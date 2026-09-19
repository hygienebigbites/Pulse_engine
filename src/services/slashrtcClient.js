/**
 * SlashRTC client: logs into the SlashRTC portal with a service account and
 * fetches recording files using the authenticated session.
 *
 * Confirmed against the live login page (2026-09-18):
 *   POST https://<host>/index.php/login/validate
 *   form fields: username, password  (no CSRF token observed)
 *
 * IMPORTANT (found 2026-09-18): the login page's own JavaScript RSA-encrypts
 * the password with a public key (via JSEncrypt) before submitting the form
 * — the server never receives the plain password, even from a real browser.
 * We replicate that exact step below with Node's built-in crypto module
 * (PKCS1 v1.5 padding, matching JSEncrypt's default), using the same public
 * key the login page embeds in its own source.
 *
 * IMPORTANT: the recording "play" URL (…/play/<callId>/<date>/<dir>/false)
 * is the page a human clicks through in the browser. We have not been able
 * to confirm from here whether, once authenticated, it (a) streams audio
 * directly, (b) returns an HTML player page embedding the real media URL,
 * or (c) returns JSON. This client handles all three: it inspects the
 * response Content-Type and, for HTML/JSON, tries to locate an embedded
 * media URL before giving up. If your SlashRTC instance behaves
 * differently, adjust `extractMediaUrlFromHtml` / `extractMediaUrlFromJson`
 * below — that's the one seam designed to be tuned per-tenant.
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger');

const AUDIO_CONTENT_TYPES = ['audio/', 'video/', 'application/octet-stream'];

// Public key embedded in the SlashRTC login page's own <script> source
// (visible to anyone who views the page source — this is not a secret and
// is not something we extracted through any bypass). The page's JS uses
// JSEncrypt to RSA-encrypt the password with this key before submitting.
const SLASHRTC_LOGIN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA84JcXmxx+g+XF6tLUc8q
KdcD/UQd5H4Iv9qQe+PzOs52BBsDZ56NyzsgduH7qy2J9Fh55+/6CrJOMTudpGm8
JGjHcA/HBekcgMV6l/Cjg8vQGSuHqez/WKkKlpkvoqGxYJlg1xAapP3HUiVI5Ynk
WU/a7ryQqQGCVANLCP8VYENohbRae4W86dEbJ892O8Bb8k+9OaMoV6aqAH+vpRRf
Om873KCA3xdnfSeF4Vm5n+xSdd6h7B9HXsxEPCj93/rHdel8hwjLRcErcoKC5UrI
MTjFAgZ51RyxzJZj73jQlbtnqgKWfbdp65FcucFSai4EKgSAlzbbHcyH3+MR1aTZ
KQIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Encrypts a plaintext password the same way the SlashRTC login page's own
 * JavaScript does (JSEncrypt → RSAES-PKCS1-v1_5 → base64), so the server
 * accepts it exactly as it would from a real browser submission.
 *
 * NOTE: if SlashRTC ever rotates this public key, copy the new one from the
 * login page's inline <script> (view-source on /index.php/login, search for
 * "BEGIN PUBLIC KEY") and paste it in above.
 */
function encryptPasswordForSlashRtc(plainPassword) {
  const encrypted = crypto.publicEncrypt(
    { key: SLASHRTC_LOGIN_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plainPassword, 'utf8')
  );
  return encrypted.toString('base64');
}

function buildClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    baseURL: config.slashrtc.baseUrl,
    jar,
    withCredentials: true,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (HYBB-AI-Call-Listener/1.0)',
    },
    validateStatus: () => true, // we inspect status ourselves
  }));
  return { client, jar };
}

async function login(client) {
  if (!config.slashrtc.username || !config.slashrtc.password) {
    throw new Error(
      'SLASHRTC_USERNAME / SLASHRTC_PASSWORD are not set. Set them in .env, ' +
      'or use file upload / mock mode instead of URL auto-fetch.'
    );
  }

  // Visit the login PAGE first, like a real browser does, so any session
  // cookie SlashRTC sets on page-load is already present when we submit the
  // form. Some PHP session setups reject a form POST that arrives "cold"
  // without this, even with correct credentials.
  await client.get('/index.php/login', { maxRedirects: 5 });

  const params = new URLSearchParams();
  params.append('username', config.slashrtc.username);
  params.append('password', encryptPasswordForSlashRtc(config.slashrtc.password));

  const loginUrl = config.slashrtc.baseUrl + config.slashrtc.loginPath;
  const res = await client.post(config.slashrtc.loginPath, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 5,
  });

  const setCookieHeader = res.headers['set-cookie'];
  const bodySnippet = typeof res.data === 'string' ? res.data.slice(0, 600) : '[non-text response body]';

  // DEBUG: this block never logs the username/password themselves — only the
  // server's response — so it's safe to paste this output when troubleshooting.
  logger.info('--- SlashRTC login debug ---');
  logger.info('POSTed to:', loginUrl);
  logger.info('Response HTTP status:', res.status);
  logger.info('Response final URL (after redirects):', res.request?.res?.responseUrl || res.config?.url || '(unknown)');
  logger.info('Got a session cookie back?', Boolean(setCookieHeader));
  logger.info('First 600 chars of response body:\n', bodySnippet);
  logger.info('--- end debug ---');

  const failed =
    res.status >= 400 ||
    (typeof res.data === 'string' && /incorrect|invalid|login/i.test(res.data) && /password/i.test(res.data));

  if (failed) {
    logger.warn('SlashRTC login response looked like a failure', { status: res.status });
    throw new Error('SlashRTC login failed — check SLASHRTC_USERNAME / SLASHRTC_PASSWORD.');
  }

  logger.info('SlashRTC login succeeded (session cookie acquired).');
  return true;
}

function extractMediaUrlFromHtml(html, baseUrl) {
  // Look for <audio>/<source src="..."> or a bare .mp3/.wav/.m4a/.mp4 URL.
  const srcMatch = html.match(/<(?:audio|source)[^>]+src=["']([^"']+)["']/i);
  if (srcMatch) return new URL(srcMatch[1], baseUrl).toString();

  const bareMatch = html.match(/https?:\/\/[^"'\s]+\.(mp3|wav|m4a|mp4|ogg)(\?[^"'\s]*)?/i);
  if (bareMatch) return bareMatch[0];

  return null;
}

function extractMediaUrlFromJson(json) {
  const candidates = ['url', 'file', 'recording_url', 'media_url', 'path', 'link'];
  for (const key of candidates) {
    if (typeof json?.[key] === 'string' && /^https?:\/\//i.test(json[key])) {
      return json[key];
    }
  }
  // shallow scan for nested objects (one level)
  for (const val of Object.values(json || {})) {
    if (val && typeof val === 'object') {
      const found = extractMediaUrlFromJson(val);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Fetches a recording from a SlashRTC play URL and saves it to a local temp
 * file. Returns { filePath, contentType }.
 */
async function fetchRecording(playUrl, downloadDir) {
  const { client } = buildClient();
  await login(client);

  const firstRes = await client.get(playUrl, { responseType: 'arraybuffer', maxRedirects: 5 });

  if (firstRes.status >= 400) {
    throw new Error(`SlashRTC returned HTTP ${firstRes.status} for the recording URL.`);
  }

  const contentType = (firstRes.headers['content-type'] || '').toLowerCase();
  const isDirectAudio = AUDIO_CONTENT_TYPES.some(t => contentType.startsWith(t));

  let audioBuffer = firstRes.data;
  let finalContentType = contentType;

  if (!isDirectAudio) {
    const bodyText = Buffer.from(firstRes.data).toString('utf8');
    let mediaUrl = null;

    if (contentType.includes('json')) {
      try {
        mediaUrl = extractMediaUrlFromJson(JSON.parse(bodyText));
      } catch (e) {
        logger.warn('Expected JSON from SlashRTC but failed to parse it.');
      }
    } else {
      mediaUrl = extractMediaUrlFromHtml(bodyText, config.slashrtc.baseUrl + playUrl);
    }

    if (!mediaUrl) {
      throw new Error(
        'SlashRTC did not return audio directly, and no embedded media URL could be ' +
        'located in the response. The recording page structure may differ from what ' +
        'this client expects — inspect slashrtcClient.js extractMediaUrlFrom*() and adjust, ' +
        'or use manual file upload for this call in the meantime.'
      );
    }

    const mediaRes = await client.get(mediaUrl, { responseType: 'arraybuffer', maxRedirects: 5 });
    if (mediaRes.status >= 400) {
      throw new Error(`SlashRTC returned HTTP ${mediaRes.status} fetching the embedded media URL.`);
    }
    audioBuffer = mediaRes.data;
    finalContentType = (mediaRes.headers['content-type'] || '').toLowerCase();
  }

  const ext = guessExtension(finalContentType);
  const fileName = `${uuidv4()}${ext}`;
  const filePath = path.join(downloadDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(audioBuffer));

  logger.info('Recording fetched from SlashRTC', { filePath, contentType: finalContentType });
  return { filePath, contentType: finalContentType };
}

function guessExtension(contentType) {
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return '.m4a';
  if (contentType.includes('ogg')) return '.ogg';
  return '.audio';
}

module.exports = { fetchRecording };
