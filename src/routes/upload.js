/**
 * POST /api/upload  (multipart/form-data)
 * Fields: audio (file, required), callId?, callDate?, direction?
 *
 * For testing the pipeline with a manually-downloaded recording, or any
 * call recorded outside SlashRTC. Accepts mp3/wav/m4a/mp4.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const { runPipeline } = require('../services/pipeline');
const logger = require('../utils/logger');

const router = express.Router();
const TMP_DIR = path.join(__dirname, '..', '..', 'uploads');

const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'video/mp4', 'audio/ogg',
]);

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    // Some browsers send generic octet-stream for m4a — allow by extension too.
    if (/\.(mp3|wav|m4a|mp4|ogg)$/i.test(file.originalname)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Supported: MP3, WAV, M4A, MP4.`));
  },
});

router.post('/', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No audio file received (field name must be "audio").' });
  }

  const { callId, callDate, direction } = req.body || {};
  const callMeta = {
    callId: callId || null,
    callDate: callDate || null,
    direction: direction || null,
    recordingUrl: null,
    sourceFileName: req.file.originalname,
  };

  try {
    const result = await runPipeline({
      filePath: req.file.path,
      contentType: req.file.mimetype,
      callMeta,
    });
    return res.json(result);
  } catch (err) {
    logger.error('POST /api/upload failed', err.message);
    return res.status(500).json({ success: false, error: err.message, callMeta });
  }
});

module.exports = router;
