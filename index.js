import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import twilio from 'twilio';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
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

// Initiate AI call using ElevenLabs + Twilio
async function initiateAICall(lead, phone) {
  // Build context for the AI agent
  const context = {
    customerName: `${lead.firstName} ${lead.lastName}`,
    appointmentDate: lead.appointmentDate,
    appointmentTime: lead.appointmentTime,
    product: lead.product,
    address: `${lead.street}, ${lead.city}, ${lead.state} ${lead.zip}`,
    instructions: activeCampaign.instructions
  };

  // Create outbound call with Twilio that connects to ElevenLabs
  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_PHONE,
    url: `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:3000'}/api/voice/connect?leadId=${lead.recordId}`,
    statusCallback: `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:3000'}/api/voice/status`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
  });

  return {
    status: 'initiated',
    callSid: call.sid
  };
}

// Twilio voice webhook - connects to ElevenLabs
app.post('/api/voice/connect', (req, res) => {
  const leadId = req.query.leadId;
  const lead = callHistory.find(c => c.recordId == leadId) || activeCampaign.currentLead;

  // TwiML to connect call to ElevenLabs websocket
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}">
      <Parameter name="customer_name" value="${lead?.firstName || 'Customer'}" />
      <Parameter name="appointment_date" value="${lead?.appointmentDate || ''}" />
      <Parameter name="appointment_time" value="${lead?.appointmentTime || ''}" />
      <Parameter name="product" value="${lead?.product || ''}" />
      <Parameter name="instructions" value="${activeCampaign.instructions || ''}" />
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

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           AI CONFIRMER - Voice Agent System               ║
╠═══════════════════════════════════════════════════════════╣
║   Server running on port ${PORT}                            ║
║   ElevenLabs Agent: ${ELEVENLABS_AGENT_ID.substring(0, 20)}...         ║
║   Quickbase Realm: ${QB_REALM.substring(0, 30)}...    ║
║   Twilio Phone: ${TWILIO_PHONE}                        ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
