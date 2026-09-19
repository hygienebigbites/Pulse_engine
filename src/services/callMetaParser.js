/**
 * Parses call metadata (callId, date, direction, recording UUIDs) out of a
 * SlashRTC "generateLink" URL without hard-coding any specific call's values.
 *
 * Observed URL shape:
 *   https://<host>/index.php/download/generateLink/recording/
 *     <uuid1>/<uuid2>/play/<callId>/<YYYY-MM-DD>/<direction>/<flag>
 *
 * Example:
 *   https://bigbite.slashrtc.in/index.php/download/generateLink/recording/
 *     7cca3f52-88d7-4368-be3d-b7afed1ed5e4/7cca3f52-88d7-4368-be3d-b7afed1ed5e4/
 *     play/2269560112/2026-09-13/in/false
 *
 * We parse this generically by pattern rather than fixed position, and fall
 * back gracefully (returning nulls) for URLs that don't match, so the user
 * can still fill in call metadata manually in the UI.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const DIRECTION_RE = /\/(in|out|inbound|outbound)\b/i;

function parseSlashRtcUrl(url) {
  const result = {
    sourceUrl: url,
    recordingUuid: null,
    callId: null,
    callDate: null,
    direction: null,
    host: null,
    valid: false,
    parseNotes: [],
  };

  if (!url || typeof url !== 'string') {
    result.parseNotes.push('No URL provided.');
    return result;
  }

  let parsedHost;
  try {
    parsedHost = new URL(url).hostname;
  } catch (e) {
    result.parseNotes.push('URL is not a well-formed absolute URL.');
    return result;
  }
  result.host = parsedHost;

  const uuidMatch = url.match(UUID_RE);
  if (uuidMatch) {
    result.recordingUuid = uuidMatch[0];
  } else {
    result.parseNotes.push('Could not find a recording UUID segment.');
  }

  // Call ID: the numeric segment that follows "/play/" in the known layout.
  // Falls back to "longest standalone digit run in the path" if the /play/
  // anchor isn't present, so slightly different URL shapes still resolve.
  const playMatch = url.match(/\/play\/(\d+)/);
  if (playMatch) {
    result.callId = playMatch[1];
  } else {
    const digitRuns = url.match(/\d{6,}/g);
    if (digitRuns && digitRuns.length) {
      // pick the longest run as the most likely call/session id
      result.callId = digitRuns.sort((a, b) => b.length - a.length)[0];
      result.parseNotes.push('Call ID inferred from longest digit run (no /play/ anchor found).');
    } else {
      result.parseNotes.push('Could not identify a call ID.');
    }
  }

  const dateMatch = url.match(DATE_RE);
  if (dateMatch) {
    result.callDate = dateMatch[1];
  } else {
    result.parseNotes.push('Could not find a call date (expected YYYY-MM-DD).');
  }

  const dirMatch = url.match(DIRECTION_RE);
  if (dirMatch) {
    const raw = dirMatch[1].toLowerCase();
    result.direction = raw.startsWith('in') ? 'inbound' : 'outbound';
  } else {
    result.parseNotes.push('Could not determine call direction.');
  }

  result.valid = Boolean(result.callId && result.recordingUuid);
  return result;
}

module.exports = { parseSlashRtcUrl };
