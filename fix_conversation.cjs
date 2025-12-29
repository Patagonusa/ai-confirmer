const fs = require('fs');

const indexPath = './index.js';
let content = fs.readFileSync(indexPath, 'utf8');

// Fix 1: Store current lead data in a Map so WebSocket can access it
const afterActiveConnections = "const activeConnections = new Map(); // Track active WebSocket connections";
const addLeadDataMap = `const activeConnections = new Map(); // Track active WebSocket connections
const pendingCallLeads = new Map(); // Store lead data for pending calls`;

if (content.includes(afterActiveConnections) && !content.includes('pendingCallLeads')) {
  content = content.replace(afterActiveConnections, addLeadDataMap);
  console.log('Added pendingCallLeads Map');
}

// Fix 2: Store lead data before making call
const oldInitiateCall = `// Initiate AI call using ElevenLabs + Twilio
async function initiateAICall(lead, phone) {
  const publicUrl = getPublicUrl();

  // Create outbound call with Twilio that connects to our WebSocket bridge
  const call = await twilioClient.calls.create({`;

const newInitiateCall = `// Initiate AI call using ElevenLabs + Twilio
async function initiateAICall(lead, phone) {
  const publicUrl = getPublicUrl();

  // Store lead data for WebSocket to access later
  const tempCallId = Date.now().toString();
  pendingCallLeads.set(tempCallId, lead);

  // Create outbound call with Twilio that connects to our WebSocket bridge
  const call = await twilioClient.calls.create({`;

if (content.includes(oldInitiateCall)) {
  content = content.replace(oldInitiateCall, newInitiateCall);
  console.log('Added lead storage before call');
}

// Fix 3: Pass tempCallId in the URL
const oldConnectUrl = "url: `${publicUrl}/api/voice/connect?leadId=${lead.recordId}`,";
const newConnectUrl = "url: `${publicUrl}/api/voice/connect?leadId=${lead.recordId}&tempId=${tempCallId}`,";

if (content.includes(oldConnectUrl)) {
  content = content.replace(oldConnectUrl, newConnectUrl);
  console.log('Added tempId to connect URL');
}

// Fix 4: Pass tempCallId to WebSocket stream
const oldTwimlStream = '<Stream url="${wsUrl}/media-stream">';
const newTwimlStream = '<Stream url="${wsUrl}/media-stream?tempId=${req.query.tempId}">';

if (content.includes(oldTwimlStream)) {
  content = content.replace(oldTwimlStream, newTwimlStream);
  console.log('Added tempId to WebSocket stream URL');
}

// Fix 5: Get lead data in WebSocket and pass to ElevenLabs
const oldWsConnection = `wss.on('connection', async (twilioWs, req) => {
  console.log('Twilio WebSocket connected');

  let streamSid = null;
  let callSid = null;
  let elevenLabsWs = null;
  let leadId = null;
  let elevenLabsReady = false;`;

const newWsConnection = `wss.on('connection', async (twilioWs, req) => {
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
  let elevenLabsReady = false;`;

if (content.includes(oldWsConnection)) {
  content = content.replace(oldWsConnection, newWsConnection);
  console.log('Added lead retrieval in WebSocket');
}

// Fix 6: Pass dynamic variables to ElevenLabs
const oldElevenLabsInit = `// Send initial configuration - agent already configured for ulaw_8000
        const config = {
          type: 'conversation_initiation_client_data'
        };
        console.log('Sending ElevenLabs init');
        ws.send(JSON.stringify(config));`;

const newElevenLabsInit = `// Send initial configuration with customer data
        const config = {
          type: 'conversation_initiation_client_data',
          conversation_config_override: {
            agent: {
              prompt: {
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
              }
            }
          }
        };
        console.log('Sending ElevenLabs init with customer:', currentLead?.firstName);
        ws.send(JSON.stringify(config));`;

if (content.includes(oldElevenLabsInit)) {
  content = content.replace(oldElevenLabsInit, newElevenLabsInit);
  console.log('Added dynamic variables to ElevenLabs init');
}

// Fix 7: Add helper functions for date/time formatting
const beforeHealthCheck = "// Health check";
const addHelperFunctions = `// Helper functions for formatting
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
    return \`\${h12}:\${minutes} \${ampm}\`;
  } catch (e) {
    return timeStr;
  }
}

// Health check`;

if (content.includes(beforeHealthCheck) && !content.includes('function formatDate')) {
  content = content.replace(beforeHealthCheck, addHelperFunctions);
  console.log('Added date/time formatting functions');
}

fs.writeFileSync(indexPath, content);
console.log('\\nConversation fix complete! AI will now use customer data.');
