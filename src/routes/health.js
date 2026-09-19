const express = require('express');
const config = require('../config');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    transcriptionProvider: config.transcription.provider,
    llmProvider: config.llm.provider,
    slashrtcConfigured: Boolean(config.slashrtc.username && config.slashrtc.password),
    time: new Date().toISOString(),
  });
});

module.exports = router;
