/**
 * POST /api/process
 * Body: { recordingUrl: string, callId?, callDate?, direction?: string, jobId?: string }
 *
 * Fetches the recording from SlashRTC (using the service-account session),
 * then runs it through the shared pipeline. Any manually-supplied
 * callId/callDate/direction override what was auto-parsed from the URL.
 *
 * Reliability additions (business logic unchanged):
 *  - every request is a "job" with an ID (supplied by the caller, or generated)
 *    that can be cancelled via POST /api/jobs/:jobId/cancel,
 *  - a second concurrent request for the same recording is refused (409),
 *  - if the caller disconnects (e.g. Apps Script gave up), the job is
 *    cancelled instead of running on unseen,
 *  - failures carry an `errorType` so callers can tell a service/upstream
 *    problem from a normal processing error.
 */

const express = require('express');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const slashrtcClient = require('../services/slashrtcClient');
const { parseSlashRtcUrl } = require('../services/callMetaParser');
const { runPipeline } = require('../services/pipeline');
const jobStore = require('../services/jobStore');
const jobContext = require('../utils/jobContext');
const logger = require('../utils/logger');

const router = express.Router();
const TMP_DIR = path.join(__dirname, '..', '..', 'uploads');

/** Maps a thrown error to { errorType, httpStatus }. */
function classifyError(err) {
  if (err instanceof jobContext.CancelledError || axios.isCancel(err) || err.code === 'ERR_CANCELED') {
    return { errorType: 'cancelled', httpStatus: 499 };
  }
  const msg = String(err.message || '');
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout of \d+ms exceeded/i.test(msg)) {
    return { errorType: 'upstream_timeout', httpStatus: 504 };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/.test(`${err.code} ${msg}`)) {
    return { errorType: 'upstream_unreachable', httpStatus: 502 };
  }
  if (/SlashRTC login failed/i.test(msg)) {
    return { errorType: 'slashrtc_auth', httpStatus: 502 };
  }
  return { errorType: 'processing_error', httpStatus: 502 };
}

router.post('/', async (req, res) => {
  const { recordingUrl, callId, callDate, direction, jobId: clientJobId } = req.body || {};

  if (!recordingUrl || typeof recordingUrl !== 'string') {
    return res.status(400).json({ success: false, errorType: 'bad_request', error: 'recordingUrl is required.' });
  }

  const parsed = parseSlashRtcUrl(recordingUrl);
  const callMeta = {
    callId: callId || parsed.callId,
    callDate: callDate || parsed.callDate,
    direction: direction || parsed.direction,
    recordingUrl,
    recordingUuid: parsed.recordingUuid,
    parseNotes: parsed.parseNotes,
  };

  const jobId = typeof clientJobId === 'string' && /^[\w-]{8,64}$/.test(clientJobId) ? clientJobId : uuidv4();

  let job;
  try {
    job = jobStore.start(jobId, recordingUrl);
  } catch (err) {
    if (err instanceof jobStore.JobError) {
      return res.status(err.httpStatus).json({ success: false, errorType: err.errorType, error: err.message, jobId, callMeta });
    }
    throw err;
  }

  // Caller hung up before we answered (Apps Script timeout, user closed the
  // sidebar...): stop working instead of burning API calls for nobody.
  res.on('close', () => {
    if (!res.writableFinished) {
      logger.warn(`Client disconnected before job ${jobId} finished — cancelling it.`);
      jobStore.cancel(jobId);
    }
  });

  try {
    const result = await jobContext.run({ controller: job.controller }, async () => {
      const { filePath, contentType } = await slashrtcClient.fetchRecording(recordingUrl, TMP_DIR);
      return runPipeline({ filePath, contentType, callMeta });
    });
    jobStore.finish(jobId, 'completed');
    return res.json({ ...result, jobId });
  } catch (err) {
    const { errorType, httpStatus } = classifyError(err);
    jobStore.finish(jobId, errorType === 'cancelled' ? 'cancelled' : 'failed');
    logger.error(`POST /api/process failed (${errorType}) job=${jobId}`, err.message);
    if (res.writableEnded || res.destroyed) return undefined;
    return res.status(httpStatus).json({
      success: false,
      errorType,
      error: errorType === 'cancelled' ? 'Job was cancelled.' : err.message,
      jobId,
      callMeta,
      hint: 'If SlashRTC auto-fetch keeps failing, download the recording manually and use the "Upload audio file" option instead.',
    });
  }
});

module.exports = router;
