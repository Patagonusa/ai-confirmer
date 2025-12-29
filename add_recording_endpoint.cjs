const fs = require('fs');
let content = fs.readFileSync('index.js', 'utf8');

// Check if recording endpoint exists
if (!content.includes("app.post('/api/voice/recording'")) {
  const recordingEndpoint = `
// Recording callback
app.post('/api/voice/recording', async (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;
  console.log('Recording received for call:', CallSid, RecordingUrl);

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

  // Insert after Twilio status callback
  content = content.replace(
    "// Stop campaign\napp.post('/api/campaign/stop'",
    recordingEndpoint + "// Stop campaign\napp.post('/api/campaign/stop'"
  );
  
  fs.writeFileSync('index.js', content);
  console.log('Recording endpoint added');
} else {
  console.log('Recording endpoint already exists');
}
