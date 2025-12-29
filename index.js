import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import twilio from 'twilio';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { mulawToPcm16k, pcm16kToMulaw } from './audio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const PORT = process.env.PORT || 3000;

// ElevenLabs Config (set via environment variables)
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Quickbase Config (set via environment variables)
const QB_REALM = process.env.QB_REALM;
const QB_APP_ID = process.env.QB_APP_ID;
const QB_USER_TOKEN = process.env.QB_USER_TOKEN;
const QB_LEADS_TABLE = process.env.QB_LEADS_TABLE || 'bqn46epj5';
const QB_STATUS_TABLE = process.env.QB_STATUS_TABLE || 'bqn46epmb';

// Twilio Config (set via environment variables)
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE;

const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

// In-memory call tracking
const activeCampaign = {
  running: false,
  totalLeads: 0,
  callsMade: 0,
  confirmed: 0,
  rescheduled: 0,
  cancelled: 0,
  noAnswer: 0,
  currentLead: null,
  leads: [],
  startTime: null,
  instructions: '',
  dispositions: []
};

const callHistory = [];
const callTranscripts = new Map(); // Map callSid -> transcript array
const activeConnections = new Map(); // Track active WebSocket connections
const pendingCallLeads = new Map(); // Store lead data for pending calls

// Quickbase API helper
async function qbRequest(endpoint, method = 'GET', body = null) {
  const url = `https://api.quickbase.com/v1/${endpoint}`;
  const options = {
    method,
    headers: {
      'QB-Realm-Hostname': QB_REALM,
      'Authorization': `QB-USER-TOKEN ${QB_USER_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  return response.json();
}

// Get all statuses from Quickbase
app.get('/api/statuses', async (req, res) => {
  try {
    const data = await qbRequest('records/query', 'POST', {
      from: QB_STATUS_TABLE,
      select: [3, 6, 7, 8, 11],
      where: "{11.EX.true}"
    });

    const statuses = data.data.map(row => ({
      id: row['3'].value,
      name: row['6'].value,
      description: row['7'].value,
      type: row['8'].value,
      active: row['11'].value
    }));

    res.json(statuses);
  } catch (error) {
    console.error('Error fetching statuses:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get leads for a specific date with specific dispositions
app.get('/api/leads', async (req, res) => {
  try {
    const { date, dispositions } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    // Build query for date and dispositions
    let whereClause = `{11.EX.'${date}'}`;

    if (dispositions) {
      const dispArray = dispositions.split(',').map(d => d.trim());
      const dispClauses = dispArray.map(d => `{9.EX.'${d}'}`).join('OR');
      whereClause = `(${whereClause})AND(${dispClauses})`;
    }

    const data = await qbRequest('records/query', 'POST', {
      from: QB_LEADS_TABLE,
      select: [3, 6, 7, 9, 11, 15, 94, 95, 97, 98, 99, 108, 109, 126],
      where: whereClause,
      sortBy: [{ fieldId: 126, order: 'ASC' }],
      options: { top: 1000, skip: 0 }
    });

    // Parse name into first/last - field 6 contains full name like "John Smith / Jane Smith"
    const leads = data.data.map(row => {
      const fullName = row['6']?.value || '';
      // Split on / or & to get primary contact, then split into first/last
      const primaryName = fullName.split(/[/&]/)[0].trim();
      const nameParts = primaryName.split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      return {
        recordId: row['3']?.value,
        fullName: primaryName,
        firstName,
        lastName,
        phone: row['109']?.value || '',
        altPhone: row['108']?.value || '',
        status: row['9']?.value || '',
        appointmentDate: row['11']?.value,
        appointmentTime: row['126']?.value,
        product: row['15']?.value || '',
        address: row['94']?.value || '',
        street: row['95']?.value || '',
        city: row['97']?.value || '',
        state: row['98']?.value || '',
        zip: row['99']?.value || ''
      };
    });

    // Apply time filter if provided
    const { timeFrom, timeTo } = req.query;
    let filteredLeads = leads;
    if (timeFrom || timeTo) {
      // Normalize time format for comparison (HH:MM -> HH:MM:SS)
      const normalizeTime = (t) => {
        if (!t) return null;
        // Remove seconds if present, then add :00
        const parts = t.split(':');
        return parts[0].padStart(2, '0') + ':' + (parts[1] || '00').padStart(2, '0') + ':00';
      };
      const fromNorm = normalizeTime(timeFrom);
      const toNorm = normalizeTime(timeTo);

      filteredLeads = leads.filter(l => {
        if (!l.appointmentTime) return false;
        const time = normalizeTime(l.appointmentTime);
        if (fromNorm && time < fromNorm) return false;
        if (toNorm && time > toNorm) return false;
        return true;
      });
    }

    res.json({
      total: filteredLeads.length,
      leads: filteredLeads,
      date,
      dispositions: dispositions ? dispositions.split(',') : []
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start calling campaign
app.post('/api/campaign/start', async (req, res) => {
  try {
    const { date, dispositions, instructions } = req.body;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    // Fetch leads
    let whereClause = `{11.EX.'${date}'}`;
    if (dispositions && dispositions.length > 0) {
      const dispClauses = dispositions.map(d => `{9.EX.'${d}'}`).join('OR');
      whereClause = `(${whereClause})AND(${dispClauses})`;
    }

    const data = await qbRequest('records/query', 'POST', {
      from: QB_LEADS_TABLE,
      select: [3, 6, 7, 9, 11, 15, 94, 95, 97, 98, 99, 108, 109, 126],
      where: whereClause,
      sortBy: [{ fieldId: 126, order: 'ASC' }]
    });

    // Parse name into first/last
    const leads = data.data.map(row => {
      const fullName = row['6']?.value || '';
      const primaryName = fullName.split(/[/&]/)[0].trim();
      const nameParts = primaryName.split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      return {
        recordId: row['3']?.value,
        fullName: primaryName,
        firstName,
        lastName,
        phone: row['109']?.value || '',
        altPhone: row['108']?.value || '',
        status: row['9']?.value || '',
        appointmentDate: row['11']?.value,
        appointmentTime: row['126']?.value,
        product: row['15']?.value || '',
        street: row['95']?.value || '',
        city: row['97']?.value || '',
        state: row['98']?.value || '',
        zip: row['99']?.value || ''
      };
    });

    // Initialize campaign
    activeCampaign.running = true;
    activeCampaign.totalLeads = leads.length;
    activeCampaign.callsMade = 0;
    activeCampaign.confirmed = 0;
    activeCampaign.rescheduled = 0;
    activeCampaign.cancelled = 0;
    activeCampaign.noAnswer = 0;
    activeCampaign.leads = leads;
    activeCampaign.startTime = new Date();
    activeCampaign.instructions = instructions || '';
    activeCampaign.dispositions = dispositions || [];

    res.json({
      success: true,
      message: `Campaign started with ${leads.length} leads`,
      totalLeads: leads.length
    });

    // Start calling in background
    processNextCall();

  } catch (error) {
    console.error('Error starting campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// Process next call in queue
async function processNextCall() {
  if (!activeCampaign.running || activeCampaign.leads.length === 0) {
    activeCampaign.running = false;
    activeCampaign.currentLead = null;
    console.log('Campaign finished or stopped');
    return;
  }

  const lead = activeCampaign.leads.shift();
  activeCampaign.currentLead = lead;

  // Clean phone number
  let phone = (lead.phone || lead.altPhone || '').replace(/\D/g, '');
  if (phone.length === 10) phone = '1' + phone;
  if (!phone.startsWith('+')) phone = '+' + phone;

  if (phone.length < 11) {
    console.log(`Skipping lead ${lead.recordId} - invalid phone: ${phone}`);
    callHistory.push({
      recordId: lead.recordId,
      name: lead.fullName || `${lead.firstName} ${lead.lastName}`.trim(),
      appointmentDate: lead.appointmentDate,
      appointmentTime: lead.appointmentTime,
      product: lead.product,
      phone: lead.phone,
      status: 'skipped',
      reason: 'Invalid phone number',
      timestamp: new Date()
    });
    activeCampaign.callsMade++;
    setTimeout(processNextCall, 1000);
    return;
  }

  console.log(`Calling ${lead.firstName} ${lead.lastName} at ${phone}`);

  try {
    // Use ElevenLabs conversational AI to make the call via Twilio
    const callResult = await initiateAICall(lead, phone);

    callHistory.push({
      recordId: lead.recordId,
      name: lead.fullName || `${lead.firstName} ${lead.lastName}`.trim(),
      appointmentDate: lead.appointmentDate,
      appointmentTime: lead.appointmentTime,
      product: lead.product,
      phone,
      status: callResult.status,
      callSid: callResult.callSid,
      timestamp: new Date()
    });

    activeCampaign.callsMade++;

    // Wait before next call (30 seconds minimum between calls)
    setTimeout(processNextCall, 30000);

  } catch (error) {
    console.error(`Error calling lead ${lead.recordId}:`, error);
    callHistory.push({
      recordId: lead.recordId,
      name: lead.fullName || `${lead.firstName} ${lead.lastName}`.trim(),
      appointmentDate: lead.appointmentDate,
      appointmentTime: lead.appointmentTime,
      product: lead.product,
      phone,
      status: 'error',
      error: error.message,
      timestamp: new Date()
    });
    activeCampaign.callsMade++;
    setTimeout(processNextCall, 5000);
  }
}

// Get the public URL for webhooks
function getPublicUrl() {
  return process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : `https://ai-confirmer.onrender.com`;
}

// Initiate AI call using ElevenLabs + Twilio
async function initiateAICall(lead, phone) {
  const publicUrl = getPublicUrl();

  // Store lead data for WebSocket to access later
  const tempCallId = Date.now().toString();
  pendingCallLeads.set(tempCallId, lead);

  // Create outbound call with Twilio that connects to our WebSocket bridge
  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_PHONE,
    url: `${publicUrl}/api/voice/connect?leadId=${lead.recordId}&tempId=${tempCallId}`,
    statusCallback: `${publicUrl}/api/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    record: true,
    recordingStatusCallback: `${publicUrl}/api/voice/recording`,
    recordingStatusCallbackEvent: ['completed']
  });

  return {
    status: 'initiated',
    callSid: call.sid
  };
}

// Twilio voice webhook - connects to our WebSocket bridge
app.post('/api/voice/connect', async (req, res) => {
  const leadId = req.query.leadId;
  const publicUrl = getPublicUrl();
  const wsUrl = publicUrl.replace('https://', 'wss://');

  console.log(`Voice connect for lead ${leadId}, WebSocket URL: ${wsUrl}`);

  // TwiML to connect call to our WebSocket bridge
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/media-stream?tempId=${req.query.tempId}">
      <Parameter name="leadId" value="${leadId}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// Twilio status callback
app.post('/api/voice/status', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  console.log(`Call ${CallSid} status: ${CallStatus}, duration: ${CallDuration}s`);

  // Update call history
  const call = callHistory.find(c => c.callSid === CallSid);
  if (call) {
    call.status = CallStatus;
    call.duration = CallDuration;

    // Don't auto-confirm - wait for actual conversation outcome
    // Status will be updated by AI agent via tool call
    if (CallStatus === 'no-answer' || CallStatus === 'busy' || CallStatus === 'failed') {
      activeCampaign.noAnswer++;
      // Add to retry queue if configured
      if (call && call.recordId) {
        addToRetryQueue(call.recordId, CallStatus);
      }
    }
  }

  res.sendStatus(200);
});

// Proxy endpoint to serve recordings (avoids Twilio auth requirement)
app.get('/api/recording/:sid', async (req, res) => {
  try {
    const { sid } = req.params;
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Recordings/${sid}.mp3`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });

    if (!response.ok) {
      return res.status(response.status).send('Recording not found');
    }

    res.set('Content-Type', 'audio/mpeg');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Error fetching recording:', error);
    res.status(500).send('Error fetching recording');
  }
});



// Recording callback
app.post('/api/voice/recording', async (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;
  console.log('Recording received for call:', CallSid, RecordingUrl);

  const call = callHistory.find(c => c.callSid === CallSid);
  if (call) {
    const publicUrl = getPublicUrl();
    call.recordingUrl = publicUrl + '/api/recording/' + RecordingSid;
    call.recordingSid = RecordingSid;
    call.recordingDuration = RecordingDuration;
    console.log('Recording URL saved:', call.recordingUrl);
  }

  res.sendStatus(200);
});

// Stop campaign
app.post('/api/campaign/stop', (req, res) => {
  activeCampaign.running = false;
  res.json({
    success: true,
    message: 'Campaign stopped',
    stats: getCampaignStats()
  });
});

// Get campaign status
app.get('/api/campaign/status', (req, res) => {
  res.json({
    running: activeCampaign.running,
    stats: getCampaignStats(),
    currentLead: activeCampaign.currentLead,
    recentCalls: callHistory.slice(-20).reverse()
  });
});

// Get campaign stats
function getCampaignStats() {
  return {
    totalLeads: activeCampaign.totalLeads,
    callsMade: activeCampaign.callsMade,
    remaining: activeCampaign.leads.length,
    confirmed: activeCampaign.confirmed,
    rescheduled: activeCampaign.rescheduled,
    cancelled: activeCampaign.cancelled,
    noAnswer: activeCampaign.noAnswer,
    startTime: activeCampaign.startTime,
    elapsedMinutes: activeCampaign.startTime
      ? Math.round((Date.now() - activeCampaign.startTime) / 60000)
      : 0
  };
}

// Update lead status in Quickbase
app.post('/api/lead/:recordId/status', async (req, res) => {
  try {
    const { recordId } = req.params;
    const { status, notes } = req.body;

    // Update lead status in Quickbase
    const result = await qbRequest('records', 'POST', {
      to: QB_LEADS_TABLE,
      data: [{
        '3': { value: parseInt(recordId) },
        '9': { value: status }
      }]
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('Error updating lead status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get call history
app.get('/api/calls/history', (req, res) => {
  res.json(callHistory.slice(-100).reverse());
});


// SMS/Texting endpoints
const smsHistory = []; // In-memory SMS storage

// Send SMS
app.post('/api/sms/send', async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }

    let phoneNumber = to.replace(/D/g, '');
    if (phoneNumber.length === 10) phoneNumber = '1' + phoneNumber;
    if (!phoneNumber.startsWith('+')) phoneNumber = '+' + phoneNumber;

    const sms = await twilioClient.messages.create({
      body: message,
      from: TWILIO_PHONE,
      to: phoneNumber
    });

    smsHistory.push({
      sid: sms.sid,
      phone: phoneNumber,
      text: message,
      direction: 'outgoing',
      timestamp: new Date()
    });

    res.json({ success: true, sid: sms.sid });
  } catch (error) {
    console.error('Error sending SMS:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get SMS threads
app.get('/api/sms/threads', (req, res) => {
  const threads = {};
  smsHistory.forEach(msg => {
    if (!threads[msg.phone]) {
      threads[msg.phone] = {
        phone: msg.phone,
        name: msg.name || msg.phone,
        lastMessage: msg.text,
        lastTime: msg.timestamp
      };
    } else if (new Date(msg.timestamp) > new Date(threads[msg.phone].lastTime)) {
      threads[msg.phone].lastMessage = msg.text;
      threads[msg.phone].lastTime = msg.timestamp;
    }
  });
  res.json(Object.values(threads));
});

// Get messages for a phone
app.get('/api/sms/messages', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json([]);

  let cleanPhone = phone.replace(/D/g, '');
  if (cleanPhone.length === 10) cleanPhone = '1' + cleanPhone;
  if (!cleanPhone.startsWith('+')) cleanPhone = '+' + cleanPhone;

  const messages = smsHistory.filter(m => m.phone === cleanPhone);
  res.json(messages);
});

// Twilio SMS webhook for incoming messages
app.post('/api/sms/incoming', (req, res) => {
  const { From, Body } = req.body;
  smsHistory.push({
    phone: From,
    text: Body,
    direction: 'incoming',
    timestamp: new Date()
  });
  res.type('text/xml').send('<Response></Response>');
});

// Retry queue for failed/no-answer calls
const retryQueue = [];
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 300000; // 5 minutes

function addToRetryQueue(recordId, reason) {
  const existing = retryQueue.find(r => r.recordId === recordId);
  if (existing) {
    existing.attempts++;
    if (existing.attempts >= MAX_RETRIES) {
      console.log(`Max retries reached for ${recordId}`);
      return;
    }
  } else {
    retryQueue.push({ recordId, reason, attempts: 1, scheduledTime: Date.now() + RETRY_DELAY_MS });
  }
  console.log(`Added ${recordId} to retry queue (reason: ${reason})`);
}

// Helper functions for formatting
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  } catch (e) {
    return dateStr;
  }
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  try {
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${minutes} ${ampm}`;
  } catch (e) {
    return timeStr;
  }
}

// Health check
// Test call endpoint - call a specific phone number
app.post('/api/test-call', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }

    let phoneNumber = phone.replace(/\D/g, '');
    if (phoneNumber.length === 10) phoneNumber = '1' + phoneNumber;
    if (!phoneNumber.startsWith('+')) phoneNumber = '+' + phoneNumber;

    const publicUrl = getPublicUrl();
    
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE,
      url: `${publicUrl}/api/voice/connect?leadId=test`,
      statusCallback: `${publicUrl}/api/voice/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    res.json({
      success: true,
      message: `Test call initiated to ${phoneNumber}`,
      callSid: call.sid
    });
  } catch (error) {
    console.error('Error initiating test call:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    campaign: activeCampaign.running ? 'running' : 'stopped'
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create HTTP server
const server = createServer(app);

// Create WebSocket server for Twilio media streams
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', async (twilioWs, req) => {
  console.log('Twilio WebSocket connected');

  // Get tempId from URL to retrieve lead data
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const tempId = urlParams.get('tempId');
  const currentLead = tempId ? pendingCallLeads.get(tempId) : null;
  if (tempId) pendingCallLeads.delete(tempId); // Clean up

  console.log('Current lead for call:', currentLead?.firstName, currentLead?.lastName);

  let streamSid = null;
  let callSid = null;
  let elevenLabsWs = null;
  let leadId = null;
  let elevenLabsReady = false;

  // Get signed URL from ElevenLabs
  async function connectToElevenLabs() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }
      );
      const data = await response.json();

      if (!data.signed_url) {
        console.error('Failed to get signed URL from ElevenLabs');
        return null;
      }

      console.log('Got ElevenLabs signed URL, connecting...');

      const ws = new WebSocket(data.signed_url);

      ws.on('open', () => {
        console.log('Connected to ElevenLabs WebSocket');

        // Send initial configuration with customer data
        // Dynamic variables go at top level, not nested under conversation_config_override
        const config = {
          type: 'conversation_initiation_client_data',
          dynamic_variables: currentLead ? {
            first_name: currentLead.firstName || 'Customer',
            last_name: currentLead.lastName || '',
            phone_number: currentLead.phone || currentLead.altPhone || '',
            appointment_date: formatDate(currentLead.appointmentDate) || 'your scheduled date',
            appointment_time: formatTime(currentLead.appointmentTime) || 'your scheduled time',
            product: currentLead.product || 'home improvement service',
            company_name: 'Expert Home Builders',
            record_id: String(currentLead.recordId || ''),
            new_date: '',
            new_time: ''
          } : {}
        };
        console.log('Sending ElevenLabs init with customer:', currentLead?.firstName, currentLead?.lastName);
        console.log('Dynamic variables:', JSON.stringify(config.dynamic_variables || {}, null, 2));
        ws.send(JSON.stringify(config));
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log('ElevenLabs message type:', message.type);

          if (message.type === 'audio') {
            // Send audio to Twilio - check various possible paths for audio data
            const audioBase64 = message.audio_event?.audio_base_64
              || message.audio?.chunk
              || message.audio_event?.chunk
              || message.data;

            if (audioBase64 && twilioWs.readyState === WebSocket.OPEN && streamSid) {
              const audioData = {
                event: 'media',
                streamSid: streamSid,
                media: {
                  payload: audioBase64  // ElevenLabs outputs ulaw_8000 - send directly
                }
              };
              twilioWs.send(JSON.stringify(audioData));
              console.log('Sent audio to Twilio, length:', audioBase64.length);
            }
          } else if (message.type === 'agent_response') {
            // Handle agent response - check multiple possible paths
            const agentText = message.agent_response_event?.agent_response
              || message.agent_response
              || message.text;
            console.log('Agent says:', agentText);
            if (callSid && agentText) {
              if (!callTranscripts.has(callSid)) callTranscripts.set(callSid, []);
              callTranscripts.get(callSid).push({ speaker: 'Agent', text: agentText, timestamp: new Date() });
            }
          } else if (message.type === 'agent_response_correction') {
            // Handle corrected agent response (final version)
            const correctedText = message.agent_response_correction_event?.agent_response
              || message.agent_response;
            console.log('Agent corrected:', correctedText);
            // Update the last agent message if this is a correction
            if (callSid && correctedText && callTranscripts.has(callSid)) {
              const transcript = callTranscripts.get(callSid);
              // Find last agent entry and update it
              for (let i = transcript.length - 1; i >= 0; i--) {
                if (transcript[i].speaker === 'Agent') {
                  transcript[i].text = correctedText;
                  break;
                }
              }
            }
          } else if (message.type === 'user_transcript') {
            // Handle user transcript - check multiple possible paths
            const userText = message.user_transcription_event?.user_transcript
              || message.user_transcript
              || message.text;
            const isFinal = message.user_transcription_event?.is_final !== false;
            console.log('User said:', userText, '(final:', isFinal, ')');
            // Only store final transcripts to avoid duplicates
            if (callSid && userText && isFinal) {
              if (!callTranscripts.has(callSid)) callTranscripts.set(callSid, []);
              callTranscripts.get(callSid).push({ speaker: 'Customer', text: userText, timestamp: new Date() });
            }
          } else if (message.type === 'voicemail_detected') {
            console.log('Voicemail detected!');
            if (callSid) {
              if (!callTranscripts.has(callSid)) callTranscripts.set(callSid, []);
              callTranscripts.get(callSid).push({ speaker: 'System', text: '[Voicemail detected - leaving message]', timestamp: new Date() });
            }
          } else if (message.type === 'interruption') {
            console.log('Interruption detected');
          } else if (message.type === 'internal_vad_score' || message.type === 'internal_turn_probability') {
            // Voice activity detection - ignore
          } else if (message.type === 'conversation_initiation_metadata') {
            console.log('Conversation initiated:', message.conversation_initiation_metadata_event?.conversation_id);
            elevenLabsReady = true;
          } else if (message.type === 'ping') {
            // Respond to ping with pong
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (err) {
          console.error('Error processing ElevenLabs message:', err);
        }
      });

      ws.on('error', (error) => {
        console.error('ElevenLabs WebSocket error:', error);
      });

      ws.on('close', () => {
        console.log('ElevenLabs WebSocket closed');
      });

      return ws;
    } catch (error) {
      console.error('Error connecting to ElevenLabs:', error);
      return null;
    }
  }

  twilioWs.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          leadId = msg.start.customParameters?.leadId;
          console.log(`Twilio stream started - StreamSid: ${streamSid}, CallSid: ${callSid}, LeadId: ${leadId}`);

          // Connect to ElevenLabs
          elevenLabsWs = await connectToElevenLabs();
          break;

        case 'media':
          // Forward audio to ElevenLabs only when ready
          if (elevenLabsReady && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            // Send audio chunk to ElevenLabs as base64
            // ElevenLabs configured for ulaw_8000 - send directly without conversion
            const audioMessage = {
              user_audio_chunk: msg.media.payload
            };
            elevenLabsWs.send(JSON.stringify(audioMessage));
          }
          break;

        case 'mark':
          console.log('Twilio mark received:', msg.mark?.name);
          break;

        case 'stop':
          console.log('Twilio stream stopped');
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
          break;

        default:
          console.log('Unknown Twilio event:', msg.event);
      }
    } catch (error) {
      console.error('Error processing Twilio message:', error);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WebSocket closed');
    // Save transcript to call history
    if (callSid && callTranscripts.has(callSid)) {
      const call = callHistory.find(c => c.callSid === callSid);
      if (call) {
        call.transcript = callTranscripts.get(callSid);
        console.log('Transcript saved for call:', callSid, call.transcript.length, 'lines');
      }
      callTranscripts.delete(callSid);
    }
    if (elevenLabsWs) {
      elevenLabsWs.close();
    }
  });

  twilioWs.on('error', (error) => {
    console.error('Twilio WebSocket error:', error);
  });
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           AI CONFIRMER - Voice Agent System               ║
╠═══════════════════════════════════════════════════════════╣
║   Server running on port ${PORT}                            ║
║   ElevenLabs Agent: ${ELEVENLABS_AGENT_ID?.substring(0, 20) || 'not set'}...         ║
║   Quickbase Realm: ${QB_REALM?.substring(0, 30) || 'not set'}...    ║
║   Twilio Phone: ${TWILIO_PHONE || 'not set'}                        ║
║   WebSocket bridge: enabled                               ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
