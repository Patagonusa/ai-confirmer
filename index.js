import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import twilio from 'twilio';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

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
const activeConnections = new Map(); // Track active WebSocket connections

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
      sortBy: [{ fieldId: 126, order: 'ASC' }]
    });

    const leads = data.data.map(row => ({
      recordId: row['3']?.value,
      firstName: row['6']?.value || '',
      lastName: row['7']?.value || '',
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
    }));

    res.json({
      total: leads.length,
      leads,
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

    const leads = data.data.map(row => ({
      recordId: row['3']?.value,
      firstName: row['6']?.value || '',
      lastName: row['7']?.value || '',
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
    }));

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
      name: `${lead.firstName} ${lead.lastName}`,
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
      name: `${lead.firstName} ${lead.lastName}`,
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
      name: `${lead.firstName} ${lead.lastName}`,
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

  // Create outbound call with Twilio that connects to our WebSocket bridge
  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_PHONE,
    url: `${publicUrl}/api/voice/connect?leadId=${lead.recordId}`,
    statusCallback: `${publicUrl}/api/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
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
    <Stream url="${wsUrl}/media-stream">
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

    if (CallStatus === 'completed' && CallDuration > 30) {
      // Likely a successful call
      activeCampaign.confirmed++;
    } else if (CallStatus === 'no-answer' || CallStatus === 'busy') {
      activeCampaign.noAnswer++;
    }
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

// Health check
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

  let streamSid = null;
  let callSid = null;
  let elevenLabsWs = null;
  let leadId = null;

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
        console.log('Connected to ElevenLabs');

        // Send initial configuration for Twilio audio format
        const config = {
          type: 'conversation_initiation_client_data',
          conversation_config_override: {
            agent: {
              first_message: "Hi there! This is an AI calling to confirm your upcoming home improvement appointment. Am I speaking with the homeowner?"
            },
            tts: {
              agent_output_audio_format: "ulaw_8000"
            }
          },
          custom_llm_extra_body: {
            leadId: leadId
          }
        };
        ws.send(JSON.stringify(config));
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'audio') {
            // Send audio to Twilio
            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
              const audioData = {
                event: 'media',
                streamSid: streamSid,
                media: {
                  payload: message.audio_event?.audio_base_64 || message.audio?.chunk
                }
              };
              twilioWs.send(JSON.stringify(audioData));
            }
          } else if (message.type === 'agent_response') {
            console.log('Agent:', message.agent_response_event?.agent_response);
          } else if (message.type === 'user_transcript') {
            console.log('User:', message.user_transcription_event?.user_transcript);
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
          console.log(`Stream started: ${streamSid}, Call: ${callSid}, Lead: ${leadId}`);

          // Connect to ElevenLabs
          elevenLabsWs = await connectToElevenLabs();
          break;

        case 'media':
          // Forward audio to ElevenLabs
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            const audioMessage = {
              user_audio_chunk: msg.media.payload
            };
            elevenLabsWs.send(JSON.stringify(audioMessage));
          }
          break;

        case 'stop':
          console.log('Stream stopped');
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
          break;
      }
    } catch (error) {
      console.error('Error processing Twilio message:', error);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WebSocket closed');
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
