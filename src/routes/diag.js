/**
 * GET /api/diag  (shared-secret protected)
 *
 * Connectivity self-test, so "is it the backend, SlashRTC, or the network?"
 * can be answered without guessing. It sends NO credentials anywhere:
 *   1. egress IP  - the public IP (and rough country/city) this backend appears
 *                   as to the outside world (what SlashRTC would have to allow-list),
 *   2. SlashRTC   - a plain GET of the public login page with a short timeout.
 * A result of `error: ETIMEDOUT/ECONNABORTED` with no HTTP status means the
 * request never got an answer (typical of an IP-level block); a 403 means
 * the site actively refused this IP.
 */
const express = require('express');
const axios = require('axios');
const dns = require('dns').promises;
const config = require('../config');

const router = express.Router();

async function timed(fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, ...value };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.code || err.message };
  }
}

router.get('/', async (req, res) => {
  const host = new URL(config.slashrtc.baseUrl).hostname;

  const [egress, dnsResult, slashrtc] = await Promise.all([
    timed(async () => {
      // public IP + rough location of this backend (a site that only serves
      // Indian users may refuse foreign cloud regions, so location matters)
      try {
        const r = await axios.get('https://ipwho.is/', { timeout: 8000 });
        const d = r.data || {};
        return { ip: d.ip, country: d.country, region: d.region, city: d.city, network: d.connection && d.connection.org };
      } catch (e) {
        const r = await axios.get('https://api.ipify.org?format=json', { timeout: 8000 });
        return { ip: r.data && r.data.ip };
      }
    }),
    timed(async () => ({ addresses: (await dns.lookup(host, { all: true })).map(a => a.address) })),
    timed(async () => {
      const r = await axios.get(`${config.slashrtc.baseUrl}/index.php/login`, {
        timeout: 15000,
        validateStatus: () => true,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (HYBB-AI-Call-Listener/1.0)' },
      });
      return { httpStatus: r.status, contentType: r.headers['content-type'] || null };
    }),
  ]);

  res.json({
    time: new Date().toISOString(),
    slashrtcHost: host,
    egressIp: egress,
    dnsLookup: dnsResult,
    slashrtcLoginPage: slashrtc,
  });
});

module.exports = router;
