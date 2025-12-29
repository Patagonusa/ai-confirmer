import WaveFile from 'wavefile';

// Audio conversion functions for Twilio <-> ElevenLabs
// Twilio uses mulaw 8kHz, ElevenLabs uses PCM 16kHz

// Convert mulaw 8kHz (Twilio) to PCM 16kHz (ElevenLabs)
export function mulawToPcm16k(mulawBase64) {
  try {
    const mulawBuffer = Buffer.from(mulawBase64, 'base64');

    // Create a WAV file with mulaw data
    const wav = new WaveFile.WaveFile();
    wav.fromScratch(1, 8000, '8m', mulawBuffer); // 1 channel, 8kHz, 8-bit mulaw

    // Convert from mulaw to PCM
    wav.fromMuLaw();

    // Upsample to 16kHz
    wav.toSampleRate(16000, { method: 'sinc' });

    // Get the raw PCM samples (16-bit signed)
    const samples = wav.getSamples(true, Int16Array);

    // Convert to base64
    const pcmBuffer = Buffer.from(samples.buffer);
    return pcmBuffer.toString('base64');
  } catch (error) {
    console.error('Error converting mulaw to PCM:', error);
    return null;
  }
}

// Convert PCM 16kHz (ElevenLabs) to mulaw 8kHz (Twilio)
export function pcm16kToMulaw(pcmBase64) {
  try {
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');

    // Create Int16Array from buffer
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

    // Create a WAV file with PCM data
    const wav = new WaveFile.WaveFile();
    wav.fromScratch(1, 16000, '16', samples); // 1 channel, 16kHz, 16-bit PCM

    // Downsample to 8kHz
    wav.toSampleRate(8000, { method: 'sinc' });

    // Convert to mulaw
    wav.toMuLaw();

    // Get the mulaw data
    const mulawSamples = wav.data.samples;

    // Convert to base64
    const mulawBuffer = Buffer.from(mulawSamples);
    return mulawBuffer.toString('base64');
  } catch (error) {
    console.error('Error converting PCM to mulaw:', error);
    return null;
  }
}
