/**
 * POST /api/bulk  (multipart/form-data)
 * Field: file (a CSV — export your Google Sheet as CSV and upload it here)
 *
 * Expected columns (header row, case-insensitive): recordingUrl (required),
 * callId, callDate, direction — extra columns are ignored.
 *
 * Processes each row sequentially against SlashRTC and returns an array of
 * per-call results, so one bad/expired link doesn't abort the whole batch.
 *
 * NOTE: This is the pragmatic MVP for "I keep call links in a Google
 * Sheet" — export-to-CSV avoids needing Google OAuth/service-account setup.
 * A direct Google Sheets API integration can be added later (swap this
 * route's CSV parsing for a Sheets API read) without touching the pipeline.
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const slashrtcClient = require('../services/slashrtcClient');
const { parseSlashRtcUrl } = require('../services/callMetaParser');
const { runPipeline } = require('../services/pipeline');
const logger = require('../utils/logger');

const router = express.Router();
const TMP_DIR = path.join(__dirname, '..', '..', 'uploads');
const upload = multer({ dest: TMP_DIR });

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No CSV file received (field name must be "file").' });
  }

  let rows;
  try {
    const csvText = fs.readFileSync(req.file.path, 'utf8');
    rows = parse(csvText, { columns: header => header.map(h => h.trim().toLowerCase()), skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ success: false, error: `Could not parse CSV: ${err.message}` });
  } finally {
    fs.unlinkSync(req.file.path);
  }

  const urlColumn = ['recordingurl', 'url', 'link', 'recording_link'].find(
    c => rows[0] && Object.prototype.hasOwnProperty.call(rows[0], c)
  );
  if (!urlColumn) {
    return res.status(400).json({ success: false, error: 'CSV must have a column named "recordingUrl" (or "url"/"link").' });
  }

  const results = [];
  for (const row of rows) {
    const recordingUrl = row[urlColumn];
    if (!recordingUrl) continue;

    const parsed = parseSlashRtcUrl(recordingUrl);
    const callMeta = {
      callId: row.callid || parsed.callId,
      callDate: row.calldate || parsed.callDate,
      direction: row.direction || parsed.direction,
      recordingUrl,
      recordingUuid: parsed.recordingUuid,
    };

    try {
      const { filePath, contentType } = await slashrtcClient.fetchRecording(recordingUrl, TMP_DIR);
      const result = await runPipeline({ filePath, contentType, callMeta });
      results.push(result);
    } catch (err) {
      logger.error('Bulk row failed', recordingUrl, err.message);
      results.push({ success: false, error: err.message, callMeta });
    }
  }

  res.json({ success: true, total: results.length, results });
});

module.exports = router;
