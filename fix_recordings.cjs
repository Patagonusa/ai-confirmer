const fs = require('fs');

const indexPath = './index.js';
let content = fs.readFileSync(indexPath, 'utf8');

// 1. Add recording proxy endpoint after the recording callback
const recordingProxyCode = `

// Proxy endpoint to serve recordings (avoids Twilio auth requirement)
app.get('/api/recording/:sid', async (req, res) => {
  try {
    const { sid } = req.params;
    const auth = Buffer.from(\`\${TWILIO_SID}:\${TWILIO_AUTH_TOKEN}\`).toString('base64');

    const response = await fetch(\`https://api.twilio.com/2010-04-01/Accounts/\${TWILIO_SID}/Recordings/\${sid}.mp3\`, {
      headers: { 'Authorization': \`Basic \${auth}\` }
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
`;

// Check if proxy endpoint already exists
if (!content.includes('/api/recording/:sid')) {
  // Insert after recording callback
  const insertPoint = content.indexOf("res.sendStatus(200);\n});", content.indexOf("/api/voice/recording"));
  if (insertPoint !== -1) {
    const insertAfter = insertPoint + "res.sendStatus(200);\n});".length;
    content = content.slice(0, insertAfter) + recordingProxyCode + content.slice(insertAfter);
    console.log('Added recording proxy endpoint');
  }
}

// 2. Update the recording callback to use our proxy URL
const oldRecordingUrlLine = "call.recordingUrl = RecordingUrl + '.mp3';";
const newRecordingUrlLine = `const publicUrl = getPublicUrl();
    call.recordingUrl = publicUrl + '/api/recording/' + RecordingSid;`;

if (content.includes(oldRecordingUrlLine)) {
  content = content.replace(oldRecordingUrlLine, newRecordingUrlLine);
  console.log('Updated recording URL to use proxy');
}

// 3. Add more detailed logging for ElevenLabs messages to debug transcripts
const oldAgentLog = "console.log('Agent says:', message.agent_response_event?.agent_response);";
const newAgentLog = `console.log('Agent says:', JSON.stringify(message.agent_response_event || message));`;

if (content.includes(oldAgentLog)) {
  content = content.replace(oldAgentLog, newAgentLog);
}

const oldUserLog = "console.log('User said:', message.user_transcription_event?.user_transcript);";
const newUserLog = `console.log('User said:', JSON.stringify(message.user_transcription_event || message));`;

if (content.includes(oldUserLog)) {
  content = content.replace(oldUserLog, newUserLog);
}

// 4. Also capture transcripts from alternative message formats
const transcriptCaptureOld = `} else if (message.type === 'user_transcript') {
            console.log('User said:', JSON.stringify(message.user_transcription_event || message));
            // Store user transcript
            if (callSid && message.user_transcription_event?.user_transcript) {
              if (!callTranscripts.has(callSid)) callTranscripts.set(callSid, []);
              callTranscripts.get(callSid).push({ speaker: 'Customer', text: message.user_transcription_event.user_transcript, timestamp: new Date() });
            }
          }`;

const transcriptCaptureNew = `} else if (message.type === 'user_transcript') {
            console.log('User said:', JSON.stringify(message.user_transcription_event || message));
            // Store user transcript
            const userText = message.user_transcription_event?.user_transcript || message.user_transcript;
            if (callSid && userText) {
              if (!callTranscripts.has(callSid)) callTranscripts.set(callSid, []);
              callTranscripts.get(callSid).push({ speaker: 'Customer', text: userText, timestamp: new Date() });
            }
          } else if (message.type === 'interruption') {
            console.log('Interruption detected');
          } else if (message.type === 'internal_vad_score' || message.type === 'internal_turn_probability') {
            // Voice activity detection - ignore
          }`;

// Apply fix only if the old version exists
if (content.includes("} else if (message.type === 'user_transcript') {") &&
    !content.includes("message.type === 'interruption'")) {
  content = content.replace(
    /\} else if \(message\.type === 'user_transcript'\) \{[\s\S]*?callTranscripts\.get\(callSid\)\.push\(\{ speaker: 'Customer'[\s\S]*?\}\);\n            \}\n          \}/,
    transcriptCaptureNew
  );
  console.log('Enhanced transcript capture');
}

fs.writeFileSync(indexPath, content);
console.log('Fix complete! Recording proxy and transcript fixes applied.');
