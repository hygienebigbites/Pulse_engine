const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./utils/logger');

const healthRoute = require('./routes/health');
const processRoute = require('./routes/process');
const uploadRoute = require('./routes/upload');
const bulkRoute = require('./routes/bulk');

const app = express();

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors({ origin: config.corsOrigin.includes('*') ? true : config.corsOrigin }));
app.use(express.json({ limit: '2mb' }));

/**
 * Shared-secret gate for the processing endpoints. Only enforced when
 * BACKEND_SHARED_SECRET is set in .env — so local-only use (localhost,
 * no public URL) keeps working with zero setup, exactly as before. Once
 * this backend is deployed somewhere public (e.g. Render) and reachable
 * by anyone who finds the URL, set BACKEND_SHARED_SECRET so only callers
 * who know it (your Apps Script project, your own frontend) can trigger
 * processing — otherwise a stranger could burn through your Deepgram/Groq
 * quota just by finding the URL.
 */
function requireSharedSecret(req, res, next) {
  if (!config.backendSharedSecret) return next(); // not configured — open (local use)
  const provided = req.get('X-HYBB-Secret');
  if (provided && provided === config.backendSharedSecret) return next();
  return res.status(401).json({ success: false, error: 'Missing or incorrect X-HYBB-Secret header.' });
}

app.use('/api/health', healthRoute);
app.use('/api/process', requireSharedSecret, processRoute);
app.use('/api/upload', requireSharedSecret, uploadRoute);
app.use('/api/bulk', requireSharedSecret, bulkRoute);

// Serve the built-in frontend (see ../../frontend). Deploy behind your own
// static host / CDN in production if you prefer.
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
if (fs.existsSync(frontendDir)) {
  app.use(express.static(frontendDir));
  app.get('/', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));
}

app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ success: false, error: 'Internal server error', detail: err.message });
});

app.listen(config.port, () => {
  logger.info(`HYBB AI Call Listener backend running on port ${config.port}`);
  logger.info(`Transcription provider: ${config.transcription.provider} | LLM provider: ${config.llm.provider}`);
  if (!config.slashrtc.username) {
    logger.warn('SLASHRTC_USERNAME not set — URL auto-fetch is disabled until you add SlashRTC credentials to .env.');
  }
});
