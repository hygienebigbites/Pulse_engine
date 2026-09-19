/**
 * Transcription service: converts an audio file into a diarized transcript
 * — a list of { speakerLabel, text, startSec, endSec } segments where
 * speakerLabel is "SPEAKER_0", "SPEAKER_1", etc. (raw diarization output,
 * NOT yet resolved to CUSTOMER/AGENT — that happens in speakerResolver.js).
 *
 * Providers:
 *  - "deepgram": real diarized speech-to-text (needs DEEPGRAM_API_KEY)
 *  - "mock": canned example transcript so the whole app can be demoed and
 *    the UI/extraction pipeline validated with zero API keys.
 */

const fs = require('fs');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

async function transcribe(filePath, contentType) {
  if (config.transcription.provider === 'deepgram') {
    return transcribeWithDeepgram(filePath, contentType);
  }
  logger.warn('TRANSCRIPTION_PROVIDER=mock — returning a canned transcript. Set DEEPGRAM_API_KEY and TRANSCRIPTION_PROVIDER=deepgram for real transcription.');
  return mockTranscript();
}

async function transcribeWithDeepgram(filePath, contentType) {
  if (!config.transcription.deepgramApiKey) {
    throw new Error('DEEPGRAM_API_KEY is not set. Add it to .env or set TRANSCRIPTION_PROVIDER=mock.');
  }

  const audio = fs.readFileSync(filePath);
  const mimeType = normalizeMime(contentType, filePath);

  const res = await axios.post(
    'https://api.deepgram.com/v1/listen',
    audio,
    {
      params: {
        model: config.transcription.deepgramModel,
        language: config.transcription.deepgramLanguage,
        diarize: true,
        punctuate: true,
        smart_format: true,
        utterances: true,
      },
      headers: {
        Authorization: `Token ${config.transcription.deepgramApiKey}`,
        'Content-Type': mimeType,
      },
      maxBodyLength: Infinity,
      timeout: 120000,
    }
  );

  const utterances = res.data?.results?.utterances;
  if (!utterances || !utterances.length) {
    throw new Error(
      'Deepgram returned no utterances — the audio may be silent, too short, an unsupported ' +
      `format, or the language setting ("${config.transcription.deepgramModel}"/"${config.transcription.deepgramLanguage}") ` +
      'may not match this call. If your calls are in Hindi/Kannada, try setting DEEPGRAM_LANGUAGE ' +
      'in .env to "hi" or "kn" specifically instead of "multi".'
    );
  }

  return utterances.map(u => ({
    speakerLabel: `SPEAKER_${u.speaker}`,
    text: u.transcript,
    startSec: u.start,
    endSec: u.end,
    confidence: u.confidence,
  }));
}

function normalizeMime(contentType, filePath) {
  if (contentType && contentType.startsWith('audio')) return contentType;
  const ext = filePath.split('.').pop().toLowerCase();
  const map = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', ogg: 'audio/ogg' };
  return map[ext] || 'audio/mpeg';
}

function mockTranscript() {
  return [
    { speakerLabel: 'SPEAKER_0', text: 'Thank you for calling Hygiene BigBites support, how can I help you today?', startSec: 0.0, endSec: 4.2 },
    { speakerLabel: 'SPEAKER_1', text: 'Hi, my order 458921 has not arrived yet.', startSec: 4.8, endSec: 8.1 },
    { speakerLabel: 'SPEAKER_0', text: 'I am sorry to hear that. Let me check the order status for you, one moment please.', startSec: 8.6, endSec: 12.9 },
    { speakerLabel: 'SPEAKER_1', text: 'Okay, I have been waiting since 2 PM.', startSec: 13.4, endSec: 16.0 },
    { speakerLabel: 'SPEAKER_0', text: 'I can see the order. The delivery partner is on the way and should reach you in about fifteen minutes.', startSec: 16.5, endSec: 21.3 },
    { speakerLabel: 'SPEAKER_1', text: 'Alright, thank you. I hope it comes soon.', startSec: 21.8, endSec: 24.0 },
    { speakerLabel: 'SPEAKER_0', text: 'You are welcome. Is there anything else I can help you with?', startSec: 24.5, endSec: 27.2 },
    { speakerLabel: 'SPEAKER_1', text: 'No that is all, thanks.', startSec: 27.6, endSec: 29.0 },
    { speakerLabel: 'SPEAKER_0', text: 'Have a great day, goodbye.', startSec: 29.4, endSec: 31.0 },
  ];
}

module.exports = { transcribe };
