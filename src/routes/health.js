const express = require('express');
const config = require('../config');
const jobStore = require('../services/jobStore');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    transcriptionProvider: config.transcription.provider,
    llmProvider: config.llm.provider,
    slashrtcConfigured: Boolean(config.slashrtc.username && config.slashrtc.password),
    jobs: jobStore.stats(),
    time: new Date().toISOString(),
  });
});

module.exports = router;
