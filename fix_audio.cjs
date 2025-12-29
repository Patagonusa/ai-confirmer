const fs = require('fs');

const indexPath = './index.js';
let content = fs.readFileSync(indexPath, 'utf8');

// Fix 1: Don't convert audio when sending to ElevenLabs
// ElevenLabs is configured for ulaw_8000, same as Twilio - no conversion needed
const oldSendToElevenLabs = `const audioMessage = {
              user_audio_chunk: (() => { const c = mulawToPcm16k(msg.media.payload); return c ? c : msg.media.payload; })()
            };`;

const newSendToElevenLabs = `// ElevenLabs configured for ulaw_8000 - send directly without conversion
            const audioMessage = {
              user_audio_chunk: msg.media.payload
            };`;

if (content.includes(oldSendToElevenLabs)) {
  content = content.replace(oldSendToElevenLabs, newSendToElevenLabs);
  console.log('Fixed: Removed unnecessary conversion when sending to ElevenLabs');
}

// Fix 2: Don't convert audio when receiving from ElevenLabs
// ElevenLabs outputs ulaw_8000, same as Twilio expects - no conversion needed
const oldReceiveFromElevenLabs = `media: {
                  payload: pcm16kToMulaw(audioBase64) || audioBase64
                }`;

const newReceiveFromElevenLabs = `media: {
                  payload: audioBase64  // ElevenLabs outputs ulaw_8000 - send directly
                }`;

if (content.includes(oldReceiveFromElevenLabs)) {
  content = content.replace(oldReceiveFromElevenLabs, newReceiveFromElevenLabs);
  console.log('Fixed: Removed unnecessary conversion when receiving from ElevenLabs');
}

// Also remove the import if no longer needed (optional cleanup)
// const oldImport = "import { mulawToPcm16k, pcm16kToMulaw } from './audio.js';";
// We'll keep the import in case it's needed later

fs.writeFileSync(indexPath, content);
console.log('Audio conversion fix complete!');
