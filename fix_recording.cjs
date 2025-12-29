const fs = require('fs');
let content = fs.readFileSync('index.js', 'utf8');

// 1. Add record: true to call creation
if (!content.includes('record: true')) {
  content = content.replace(
    "statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']",
    "statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],\n    record: true,\n    recordingStatusCallback: `${publicUrl}/api/voice/recording`,\n    recordingStatusCallbackEvent: ['completed']"
  );
  console.log('Added recording to calls');
}

// 2. Add recording callback endpoint if not exists
if (!content.includes('/api/voice/recording')) {
  const recordingEndpoint = `
// Recording callback
app.post('/api/voice/recording', async (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;
  console.log('Recording received for call:', CallSid, RecordingUrl);

  // Find the call in history and add recording URL
  const call = callHistory.find(c => c.callSid === CallSid);
  if (call) {
    call.recordingUrl = RecordingUrl + '.mp3';
    call.recordingSid = RecordingSid;
    call.recordingDuration = RecordingDuration;
    console.log('Recording URL saved:', call.recordingUrl);
  }

  res.sendStatus(200);
});

`;

  // Insert before Stop campaign
  content = content.replace(
    "// Stop campaign\napp.post('/api/campaign/stop'",
    recordingEndpoint + "// Stop campaign\napp.post('/api/campaign/stop'"
  );
  console.log('Added recording callback endpoint');
}

// 3. Track transcripts from ElevenLabs - store them in the call
if (!content.includes('callTranscripts')) {
  // Add transcript storage
  content = content.replace(
    'const callHistory = [];',
    'const callHistory = [];\nconst callTranscripts = new Map(); // Map callSid -> transcript array'
  );

  // Capture agent responses
  content = content.replace(
    "console.log('Agent says:', message.agent_response_event?.agent_response);",
    `console.log('Agent says:', message.agent_response_event?.agent_response);
            // Store agent transcript
            if (callSid && message.agent_response_event?.agent_response) {
              if (!callTranscripts.has(callSid)) callTranscripts.set(callSid, []);
              callTranscripts.get(callSid).push({ speaker: 'Agent', text: message.agent_response_event.agent_response, timestamp: new Date() });
            }`
  );

  // Capture user transcripts
  content = content.replace(
    "console.log('User said:', message.user_transcription_event?.user_transcript);",
    `console.log('User said:', message.user_transcription_event?.user_transcript);
            // Store user transcript
            if (callSid && message.user_transcription_event?.user_transcript) {
              if (!callTranscripts.has(callSid)) callTranscripts.set(callSid, []);
              callTranscripts.get(callSid).push({ speaker: 'Customer', text: message.user_transcription_event.user_transcript, timestamp: new Date() });
            }`
  );

  // Save transcript when call ends
  content = content.replace(
    "console.log('Twilio WebSocket closed');",
    `console.log('Twilio WebSocket closed');
    // Save transcript to call history
    if (callSid && callTranscripts.has(callSid)) {
      const call = callHistory.find(c => c.callSid === callSid);
      if (call) {
        call.transcript = callTranscripts.get(callSid);
        console.log('Transcript saved for call:', callSid, call.transcript.length, 'lines');
      }
      callTranscripts.delete(callSid);
    }`
  );

  console.log('Added transcript capture');
}

fs.writeFileSync('index.js', content);
console.log('Recording and transcript fixes applied');
