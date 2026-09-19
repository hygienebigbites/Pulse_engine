require('dotenv').config();

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  corsOrigin: (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()),

  slashrtc: {
    baseUrl: process.env.SLASHRTC_BASE_URL || 'https://bigbite.slashrtc.in',
    username: process.env.SLASHRTC_USERNAME || '',
    password: process.env.SLASHRTC_PASSWORD || '',
    loginPath: '/index.php/login/validate',
  },

  transcription: {
    provider: (process.env.TRANSCRIPTION_PROVIDER || 'mock').toLowerCase(), // deepgram | mock
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
    // nova-3 has the broadest Indian-language coverage (Hindi + Kannada);
    // nova-2 only covers Hindi among these two. Default to nova-3 since
    // HYBB's calls mix Hindi/Kannada/English.
    deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-3',
    // "multi" = Deepgram's code-switching mode (auto-detects/mixes languages
    // within one call). Set to a specific code (e.g. "hi", "kn", "en") in
    // .env if multi mode doesn't perform well enough on your real calls.
    deepgramLanguage: process.env.DEEPGRAM_LANGUAGE || 'multi',
  },

  llm: {
    provider: (process.env.LLM_PROVIDER || 'rule-based').toLowerCase(), // anthropic | openai | groq | rule-based
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    // Groq: free tier (1,000 requests/day as of writing), OpenAI-compatible
    // API, runs the open-source Llama 3.3 70B model. Good zero-cost option
    // for a QA tool at this call volume; quality is a step below
    // Claude/GPT but should be solid for structured extraction tasks.
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },

  orderIdRegex: process.env.ORDER_ID_REGEX || '\\b\\d{5,8}\\b',

  // Controlled vocabulary the LLM must pick from for "Complaint Category".
  // Keep this in sync with COMPLAINT_CATEGORIES in
  // apps-script/Config.gs (Google Sheet dropdown) if you change it —
  // they're two separate codebases so nothing enforces this automatically.
  complaintCategories: [
    'Food Quality', 'Wrong Item', 'Missing Item', 'Late Delivery',
    'Order Not Delivered', 'Payment/Refund Issue', 'Packaging Issue',
    'Rude Behavior', 'App/Technical Issue', 'Delivery Partner Issue',
    'Pricing Issue', 'General Inquiry', 'Other',
  ],

  // 10-parameter agent QA rubric. Weights must sum to 100 — this is the
  // single place to change to re-balance the weighted score (nothing else
  // needs editing; extractionService.js sums whatever is here). Each
  // parameter is scored 0-10 by the LLM; the weighted 0-100 score is
  // computed in code (not trusted from the LLM) as
  // sum(paramScore/10 * paramWeight).
  qaParameters: [
    { key: 'greeting', label: 'Greeting & Introduction', weight: 5 },
    { key: 'activeListening', label: 'Active Listening', weight: 10 },
    { key: 'empathy', label: 'Empathy & Tone', weight: 15 },
    { key: 'issueVerification', label: 'Issue / Order Verification Accuracy', weight: 15 },
    { key: 'infoAccuracy', label: 'Information Accuracy', weight: 10 },
    { key: 'resolution', label: 'Resolution / Solution Offered', weight: 15 },
    { key: 'clarity', label: 'Communication Clarity', weight: 10 },
    { key: 'processAdherence', label: 'Process / SOP Adherence', weight: 10 },
    { key: 'efficiency', label: 'Call Efficiency (no rambling/dead air)', weight: 5 },
    { key: 'closing', label: 'Closing & Confirmation', weight: 5 },
  ],

  // Shared secret that Google Apps Script (or any other caller) must send
  // in an "X-HYBB-Secret" header. Required once this backend is deployed
  // somewhere public (Render, etc.) — on localhost-only use it's optional.
  // Generate any long random string for this; it's not tied to any
  // provider's account, just a password only you and your Apps Script
  // project know.
  backendSharedSecret: process.env.BACKEND_SHARED_SECRET || '',
};
