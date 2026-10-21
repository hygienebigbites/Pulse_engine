/**
 * Job control.
 *   POST /api/jobs/:jobId/cancel  -> request cancellation of a running job
 *   GET  /api/jobs/:jobId         -> job status (running | cancelling | completed | failed | cancelled)
 */
const express = require('express');
const jobStore = require('../services/jobStore');

const router = express.Router();

router.post('/:jobId/cancel', (req, res) => {
  const result = jobStore.cancel(req.params.jobId);
  res.json({ success: true, jobId: req.params.jobId, ...result });
});

router.get('/:jobId', (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Unknown job (finished long ago, or the backend restarted).' });
  return res.json({ success: true, ...job });
});

module.exports = router;
