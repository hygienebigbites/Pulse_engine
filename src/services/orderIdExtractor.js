/**
 * Order ID extraction from a call transcript.
 *
 * Pipeline: transcript text -> number normalisation (Devanagari/Kannada
 * digits, spoken digits in English/Hindi/Kannada, "double five", digits
 * spoken in groups) -> digit "runs" -> context classification (phone / amount
 * / OTP / date-time are excluded; order cues and "last four digits" cues are
 * recognised) -> best candidate.
 *
 * EXISTING BUSINESS RULE (preserved): a full order ID is whatever
 * ORDER_ID_REGEX matches (default: 5-8 digits, see config.js). Nothing here
 * changes that definition; this module only decides WHICH number in the
 * transcript is the order reference, and never guesses missing digits.
 *
 * Output (all strings, so leading zeros survive):
 *   {
 *     orderId:       full order ID, or null,
 *     orderIdLast4:  last four digits (from the full ID, or stated directly), or null,
 *     confidence:    'high' | 'medium' | 'low' | 'none',
 *     source:        'full_with_order_cue' | 'full_no_cue' | 'explicit_last4' |
 *                    'spoken_last4' | 'short_with_order_cue' | 'none',
 *     needsReview:   true when the transcript is ambiguous / incomplete / conflicting,
 *     reason:        human-readable explanation,
 *     candidates:    [{ value, kind, reason, spoken }]   (excluded numbers included, for audit)
 *   }
 */

const config = require('../config');

// ---- number words --------------------------------------------------------

const WORD_DIGITS = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9,
  // Hindi / Hinglish (romanised)
  shunya: 0, shoonya: 0, ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4,
  paanch: 5, panch: 5, pach: 5, chhe: 6, chhah: 6, chheh: 6, che: 6, chah: 6,
  saat: 7, sat: 7, aath: 8, aat: 8, ath: 8, nau: 9, nao: 9,
  // Hindi (Devanagari)
  'शून्य': 0, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'पाच': 5,
  'छह': 6, 'छः': 6, 'छे': 6, 'छै': 6, 'सात': 7, 'आठ': 8, 'नौ': 9,
  // Kannada
  'ಸೊನ್ನೆ': 0, 'ಒಂದು': 1, 'ಎರಡು': 2, 'ಮೂರು': 3, 'ನಾಲ್ಕು': 4, 'ಐದು': 5,
  'ಆರು': 6, 'ಏಳು': 7, 'ಎಂಟು': 8, 'ಒಂಬತ್ತು': 9,
};
const MULTIPLIERS = { double: 2, triple: 3, dabal: 2, 'डबल': 2, 'ट्रिपल': 3 };

// Devanagari (U+0966-096F) and Kannada (U+0CE6-0CEF) digits -> ASCII
function asciiDigits(text) {
  return text
    .replace(/[०-९]/g, c => String(c.charCodeAt(0) - 0x0966))
    .replace(/[೦-೯]/g, c => String(c.charCodeAt(0) - 0x0CE6));
}

// ---- tokenising + digit runs ---------------------------------------------

const TOKEN_RE = /(\d+)|([\p{L}\p{M}]+)|(\s+)|([^\s\p{L}\p{M}\d]+)/gu;

function tokenize(text) {
  const tokens = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const t = { text: m[0], start: m.index, end: m.index + m[0].length };
    if (m[1]) t.type = 'num';
    else if (m[2]) t.type = 'word';
    else if (m[3]) t.type = 'space';
    else t.type = 'punct';
    tokens.push(t);
  }
  return tokens;
}

/** If tokens[i] starts a digit item, returns { digits, spoken, next } else null. */
function readDigitItem(tokens, i) {
  const tok = tokens[i];
  if (!tok) return null;
  if (tok.type === 'num') return { digits: tok.text, spoken: false, next: i + 1 };
  if (tok.type === 'word') {
    const w = tok.text.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(WORD_DIGITS, w)) {
      return { digits: String(WORD_DIGITS[w]), spoken: true, next: i + 1 };
    }
    if (Object.prototype.hasOwnProperty.call(MULTIPLIERS, w)) {
      // "double five" -> 55
      let j = i + 1;
      while (tokens[j] && tokens[j].type === 'space') j++;
      const inner = tokens[j] && tokens[j].type === 'word'
        ? WORD_DIGITS[tokens[j].text.toLowerCase()]
        : undefined;
      if (inner !== undefined) {
        return { digits: String(inner).repeat(MULTIPLIERS[w]), spoken: true, next: j + 1 };
      }
    }
  }
  return null;
}

function findRuns(text) {
  const tokens = tokenize(text);
  const runs = [];
  let i = 0;
  while (i < tokens.length) {
    const first = readDigitItem(tokens, i);
    if (!first) { i++; continue; }

    let digits = first.digits;
    let spoken = first.spoken;
    let items = 1;
    const start = tokens[i].start;
    let end = tokens[first.next - 1].end;
    let cursor = first.next;

    // extend across spaces and "," / "-" separators ONLY (a "..." or "." breaks a run)
    for (;;) {
      let j = cursor;
      let sawBreak = false;
      while (tokens[j] && (tokens[j].type === 'space' || (tokens[j].type === 'punct' && /^[,\-–]+$/.test(tokens[j].text)))) j++;
      // a sentence-ending / ellipsis punctuation directly after the run stops it
      if (tokens[cursor] && tokens[cursor].type === 'punct' && !/^[,\-–]+$/.test(tokens[cursor].text)) sawBreak = true;
      if (sawBreak) break;
      const next = readDigitItem(tokens, j);
      if (!next) break;
      digits += next.digits;
      spoken = spoken || next.spoken;
      items++;
      end = tokens[next.next - 1].end;
      cursor = next.next;
    }

    runs.push({ digits, spoken, items, start, end });
    i = cursor;
  }
  return runs;
}

// ---- context classification ----------------------------------------------

const RE = {
  orderCue: /(order|ordr|ticket|ऑर्डर|आर्डर|ऑडर|ಆರ್ಡರ್)/gi,
  last4Cue: /(last|ending|end\s+with|आखिरी|अंतिम|ಕೊನೆಯ)\s*(4|four|चार|ನಾಲ್ಕು)\s*(digits?|numbers?|अंक|नंबर|ಅಂಕ)?/gi,
  last4CueAfter: /^\s*(is|are|was|hai|है)?\s*(the\s+)?(last|ending)\s*(4|four)/i,
  phoneCue: /(phone|mobile|contact|call\s*back|whatsapp|cell|फोन|मोबाइल|ಫೋನ್|ಮೊಬೈಲ್)/gi,
  otpCue: /(otp|verification|password|passcode|\bpin\b|\bcode\b|ओटीपी|कोड)/gi,
  amountLeft: /(rs\.?|rupees?|inr|₹|amount|refund(ed)?|price|total|balance|रुपये|रुपए|रु\.?|ರೂಪಾಯಿ)\s*$/i,
  amountRight: /^\s*(rs\b|rupees?|rupaye|rupay|only\b|₹|रुपये|रुपए|रु\b|ರೂಪಾಯಿ)/i,
  timeRight: /^\s*(am\b|pm\b|a\.m|p\.m|baje|बजे|o'?clock|minutes?\b|mins?\b|hours?\b|days?\b|din\b|दिन|घंटे|ಗಂಟೆ|%)/i,
  yearLeft: /(year|saal|साल|ವರ್ಷ)\s*$/i,
};

/** Index of the last match of a (global) regex in str, or -1. */
function lastIndexOfCue(re, str) {
  let idx = -1;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    idx = m.index;
    if (m[0].length === 0) re.lastIndex++;
  }
  return idx;
}

function sentenceTail(text, start, maxLen) {
  const left = text.slice(Math.max(0, start - maxLen), start);
  // only look at the current sentence
  const cut = Math.max(left.lastIndexOf('.'), left.lastIndexOf('?'), left.lastIndexOf('!'), left.lastIndexOf('…'));
  return cut === -1 ? left : left.slice(cut + 1);
}

function fullIdMatcher() {
  const src = config.orderIdRegex || '\\b\\d{5,8}\\b';
  try {
    return new RegExp(`^(?:${src})$`);
  } catch (e) {
    return /^\d{5,8}$/;
  }
}

function classifyRun(run, text, groupedAmounts, isFullId) {
  const d = run.digits;
  const before = text[run.start - 1];
  const after = text[run.end];
  const left = sentenceTail(text, run.start, 60);
  const leftNear = left.slice(-45);
  const right = text.slice(run.end, run.end + 30);

  // numbers glued to / and : are dates and times (13/09/2026, 2:30)
  if ((before && /[\/:]/.test(before)) || (after && /[\/:]/.test(after) && /\d/.test(text[run.end + 1] || ''))) {
    return { kind: 'excluded', reason: 'date_or_time' };
  }
  if (groupedAmounts.has(d) && run.items === 1) return { kind: 'excluded', reason: 'amount (comma-grouped)' };

  const orderIdx = lastIndexOfCue(RE.orderCue, leftNear);
  const last4Idx = lastIndexOfCue(RE.last4Cue, leftNear);
  const phoneIdx = lastIndexOfCue(RE.phoneCue, leftNear);
  const otpIdx = lastIndexOfCue(RE.otpCue, leftNear);

  const hasLast4Cue = last4Idx !== -1 || RE.last4CueAfter.test(right);
  const hasOrderCue = orderIdx !== -1;

  // phone numbers: 10 digits starting 6-9, or 91/0-prefixed forms, or an explicit phone cue
  const looksLikePhone = /^[6-9]\d{9}$/.test(d) || /^91[6-9]\d{9}$/.test(d) || /^0[6-9]\d{9}$/.test(d);
  if (looksLikePhone && !(hasOrderCue && orderIdx > phoneIdx)) return { kind: 'excluded', reason: 'phone number' };
  if (phoneIdx !== -1 && phoneIdx > orderIdx && !hasLast4Cue) return { kind: 'excluded', reason: 'phone number (cue)' };

  if (otpIdx !== -1 && otpIdx > orderIdx) return { kind: 'excluded', reason: 'OTP / code' };
  if (RE.amountLeft.test(left) || RE.amountRight.test(right)) return { kind: 'excluded', reason: 'amount' };
  if (RE.timeRight.test(right)) return { kind: 'excluded', reason: 'time / quantity' };
  if (d.length === 4 && /^(19|20)\d\d$/.test(d) && RE.yearLeft.test(left)) return { kind: 'excluded', reason: 'year' };

  // 4 digits with an explicit "last four digits" cue
  if (d.length === 4 && hasLast4Cue) return { kind: 'last4', source: 'explicit_last4', confidence: 'high', reason: 'stated as the last four digits' };

  if (isFullId(d)) {
    return hasOrderCue
      ? { kind: 'full', source: 'full_with_order_cue', confidence: 'high', reason: 'number after an order reference' }
      : { kind: 'full', source: 'full_no_cue', confidence: 'medium', reason: 'matches the order ID format but no order reference nearby' };
  }

  if (d.length === 4 && hasOrderCue) {
    return run.spoken
      ? { kind: 'last4', source: 'spoken_last4', confidence: 'high', reason: 'four spoken digits after an order reference' }
      : { kind: 'last4', source: 'short_with_order_cue', confidence: 'medium', reason: '4-digit number after an order reference (full ID or last four - unclear)' };
  }

  if (hasOrderCue && d.length > 0) {
    return {
      kind: 'partial',
      reason: d.length > 4
        ? `${d.length}-digit number after an order reference does not match the order ID format`
        : `only ${d.length} digit(s) after an order reference - incomplete`,
    };
  }
  return { kind: 'ignored', reason: 'not an order reference' };
}

const PRIORITY = {
  'full_with_order_cue': 5,
  'explicit_last4': 4,
  'spoken_last4': 3,
  'full_no_cue': 2,
  'short_with_order_cue': 1,
};

/**
 * @param {string|Array<{text:string}>} input  transcript text, or segments
 */
function extractOrderId(input) {
  const raw = Array.isArray(input) ? input.map(s => s.text || '').join(' \n') : String(input || '');
  const result = {
    orderId: null,
    orderIdLast4: null,
    confidence: 'none',
    source: 'none',
    needsReview: false,
    reason: 'No order reference found in the transcript.',
    candidates: [],
  };
  if (!raw.trim()) {
    result.reason = 'Transcript is empty.';
    return result;
  }

  // normalise digits in other scripts, and remove thousands commas ("1,500")
  const groupedAmounts = new Set();
  const text = asciiDigits(raw).replace(/\d{1,3}(?:,\d{3})+/g, m => {
    const plain = m.replace(/,/g, '');
    groupedAmounts.add(plain);
    return plain;
  });

  const isFull = fullIdMatcher();
  const runs = findRuns(text);
  const viable = [];
  let sawPartial = false;

  for (const run of runs) {
    const c = classifyRun(run, text, groupedAmounts, d => isFull.test(d));
    result.candidates.push({ value: run.digits, kind: c.kind === 'full' || c.kind === 'last4' ? c.kind : c.kind, reason: c.reason, spoken: run.spoken });
    if (c.kind === 'full' || c.kind === 'last4') viable.push({ ...c, value: run.digits, pos: run.start });
    if (c.kind === 'partial') sawPartial = true;
  }

  if (!viable.length) {
    if (sawPartial) {
      result.needsReview = true;
      result.reason = 'An order reference was mentioned but the digits are incomplete or split - not guessing the missing digits.';
    }
    return result;
  }

  // group identical values, then pick by priority, repeat count, first mention
  const groups = new Map();
  for (const v of viable) {
    const key = `${v.kind}:${v.value}`;
    const g = groups.get(key) || { ...v, count: 0 };
    g.count += 1;
    if (PRIORITY[v.source] > PRIORITY[g.source]) { g.source = v.source; g.confidence = v.confidence; g.reason = v.reason; }
    groups.set(key, g);
  }
  const ranked = [...groups.values()].sort(
    (a, b) => (PRIORITY[b.source] - PRIORITY[a.source]) || (b.count - a.count) || (a.pos - b.pos)
  );
  const best = ranked[0];
  const conflicting = ranked.filter(r => PRIORITY[r.source] === PRIORITY[best.source] && r.value !== best.value);

  result.confidence = best.confidence;
  result.source = best.source;
  result.reason = best.reason;
  if (best.kind === 'full') {
    result.orderId = best.value;
    result.orderIdLast4 = best.value.slice(-4);
  } else {
    result.orderIdLast4 = best.value;
  }
  if (conflicting.length) {
    result.needsReview = true;
    result.reason += `; ${conflicting.length} other equally likely candidate(s): ${conflicting.map(c => c.value).join(', ')}`;
  }
  if (best.confidence === 'medium') result.needsReview = true;
  return result;
}

/**
 * Reconciles the order ID chosen by the LLM (existing behaviour) with what
 * the transcript actually contains. This is a validation layer, not a new
 * business rule:
 *  - an LLM order ID that never appears in the transcript digits (hallucinated
 *    / mis-heard) is replaced only when the transcript has a HIGH-confidence
 *    candidate; otherwise it is kept but flagged for review,
 *  - an LLM order ID that is really a phone number / amount / OTP / date is
 *    replaced by a high-confidence candidate when there is one,
 *  - a blank LLM order ID is filled only from a HIGH-confidence candidate.
 */
function reconcileOrderId(llmOrderId, input) {
  const ext = extractOrderId(input);
  const llmDigits = llmOrderId == null ? '' : asciiDigits(String(llmOrderId)).replace(/\D/g, '');
  const highFull = ext.confidence === 'high' && ext.orderId;

  const out = {
    orderId: llmOrderId == null || llmOrderId === '' ? null : String(llmOrderId),
    orderIdLast4: ext.orderIdLast4,
    orderIdConfidence: ext.confidence,
    orderIdSource: llmDigits ? 'llm' : ext.source,
    orderIdNeedsReview: ext.needsReview,
    orderIdReason: ext.reason,
    orderIdCandidates: ext.candidates.filter(c => c.kind === 'full' || c.kind === 'last4').map(c => c.value),
  };

  if (!llmDigits) {
    if (highFull) {
      out.orderId = ext.orderId;
      out.orderIdSource = ext.source;
    }
    return out;
  }

  const matching = ext.candidates.filter(c => c.value.includes(llmDigits) || llmDigits.includes(c.value));
  const inTranscript = matching.length > 0;
  const wasExcluded = inTranscript && matching.every(c => c.kind === 'excluded');

  if (!inTranscript || wasExcluded) {
    const why = wasExcluded
      ? `The AI picked ${llmDigits}, which the transcript shows is a ${matching[0].reason}.`
      : `The AI picked ${llmDigits}, which does not appear in the transcript.`;
    if (highFull) {
      out.orderId = ext.orderId;
      out.orderIdSource = `${ext.source} (replaced AI value ${llmDigits})`;
      out.orderIdReason = `${why} Replaced with ${ext.orderId} from the transcript.`;
    } else {
      out.orderIdNeedsReview = true;
      out.orderIdReason = `${why} No confident replacement found - please check the call.`;
    }
  } else if (llmDigits.length >= 4 && !out.orderIdLast4) {
    out.orderIdLast4 = llmDigits.slice(-4);
  }
  if (out.orderId && /^\d+$/.test(String(out.orderId)) && ext.orderId !== out.orderId) {
    out.orderIdLast4 = String(out.orderId).slice(-4);
  }
  return out;
}

module.exports = { extractOrderId, reconcileOrderId, findRuns, asciiDigits };
