/**
 * Orchestrates the full call-analysis pipeline shared by the URL route,
 * the file-upload route, and bulk CSV processing:
 *   audio file -> transcription (diarized) -> speaker resolution -> extraction
 */

const fs = require('fs');
const mm = require('music-metadata');
const transcriptionService = require('./transcriptionService');
const speakerResolver = require('./speakerResolver');
const extractionService = require('./extractionService');
const logger = require('../utils/logger');

/**
 * Logs the recording's channel count (mono vs stereo). This matters a lot:
 * if SlashRTC exports stereo recordings with the agent on one channel and
 * the customer on the other, that's a far more reliable way to tell them
 * apart than AI-guessed diarization — worth knowing before troubleshooting
 * "speaker 2 isn't being detected" as a transcription-quality problem.
 */
async function logAudioChannelInfo(filePath) {
  try {
    const metadata = await mm.parseFile(filePath);
    const channels = metadata.format.numberOfChannels;
    const durationSec = metadata.format.duration;
    logger.info(
      `Recording audio format: ${channels} channel(s), ~${durationSec ? durationSec.toFixed(1) : '?'}s duration.` +
      (channels === 2
        ? ' STEREO — if the agent and customer are on separate left/right channels, we can use that for much more reliable speaker identification than AI diarization.'
        : ' MONO — both speakers are blended into a single track; speaker separation relies entirely on AI diarization quality (voice/pitch differences), which can miss a quiet or overlapping speaker.')
    );
  } catch (e) {
    logger.warn('Could not read audio metadata (channel count) for this file:', e.message);
  }
}

async function runPipeline({ filePath, contentType, callMeta, cleanupFile = true }) {
  try {
    await logAudioChannelInfo(filePath);
    const rawSegments = await transcriptionService.transcribe(filePath, contentType);
    const resolution = await speakerResolver.resolveSpeakers(rawSegments);
    const analysis = await extractionService.extractCallData(resolution.segments, callMeta);

    return {
      success: true,
      callMeta,
      transcript: resolution.segments,
      speakerResolution: {
        mapping: resolution.mapping,
        confidence: resolution.confidence,
        reason: resolution.reason,
        needsManualReview: resolution.needsManualReview,
      },
      analysis,
    };
  } finally {
    if (cleanupFile && filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { logger.warn('Could not clean up temp audio file', filePath); }
    }
  }
}

module.exports = { runPipeline };
