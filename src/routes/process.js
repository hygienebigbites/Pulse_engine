/**
 * POST /api/process
 * Body: { recordingUrl: string, callId?, callDate?, direction?: string }
 *
 * Fetches the recording from SlashRTC (using the service-account session),
 * then runs it through the shared pipeline. Any manually-supplied
 * callId/callDate/direction override what was auto-parsed from the URL.
 */

const express = require('express');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const slashrtcClient = require('../services/slashrtcClient');
const { parseSlashRtcUrl } = require('../services/callMetaParser');
const { runPipeline } = require('../services/pipeline');
const logger = require('../utils/logger');

const router = express.Router();
const TMP_DIR = path.join(__dirname, '..', '..', 'uploads');

router.post('/', async (req, res) => {
  const { recordingUrl, callId, callDate, direction } = req.body || {};

  if (!recordingUrl || typeof recordingUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'recordingUrl is required.' });
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

  try {
    const { filePath, contentType } = await slashrtcClient.fetchRecording(recordingUrl, TMP_DIR);
    const result = await runPipeline({ filePath, contentType, callMeta });
    return res.json(result);
  } catch (err) {
    logger.error('POST /api/process failed', err.message);
    return res.status(502).json({
      success: false,
      error: err.message,
      callMeta,
      hint: 'If SlashRTC auto-fetch keeps failing, download the recording manually and use the "Upload audio file" option instead.',
    });
  }
});

module.exports = router;
