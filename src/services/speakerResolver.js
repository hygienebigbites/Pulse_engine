/**
 * Resolves raw diarization labels (SPEAKER_0 / SPEAKER_1) into CUSTOMER /
 * AGENT roles using CONTEXTUAL analysis — never assumes the first speaker
 * is the customer (per spec).
 *
 * Strategy:
 *  1. If an LLM is configured, ask it to read the whole diarized transcript
 *     and decide which raw speaker label is the agent vs the customer,
 *     with a one-line justification.
 *  2. Otherwise (rule-based mode), score each speaker on a small set of
 *     lexical cues typical of a support agent ("thank you for calling",
 *     "how can I help", "let me check", "I can see the order", "is there
 *     anything else") vs a customer ("my order", "I have been waiting",
 *     "I want to", "when will"). The speaker with the higher agent-cue
 *     score is labeled AGENT.
 *  3. If confidence is still too low to call it either way, both speakers
 *     are left as SPEAKER_1 / SPEAKER_2 and the UI flags this for manual
 *     confirmation, per the spec's explicit fallback instruction.
 */

const llmProvider = require('./llmProvider');
const logger = require('../utils/logger');

const AGENT_CUES = [
  'thank you for calling', 'how can i help', 'how may i help', 'let me check',
  'i can see the order', 'is there anything else', 'i apologize', 'i am sorry for the',
  'your order number', 'one moment please', 'have a great day', 'support', 'i understand your concern',
  'let me look into', 'i have raised', 'ticket has been', 'refund will be',
];

const CUSTOMER_CUES = [
  'my order', 'i have been waiting', 'i want to', 'when will', 'i ordered',
  'i did not receive', 'i have not received', 'this is the second time', 'i am calling about',
  'i need a refund', 'can you check', 'why is my', 'i am not happy',
];

function scoreSegmentsBySpeaker(segments) {
  const scores = {};
  for (const seg of segments) {
    const t = seg.text.toLowerCase();
    scores[seg.speakerLabel] = scores[seg.speakerLabel] || { agent: 0, customer: 0 };
    for (const cue of AGENT_CUES) if (t.includes(cue)) scores[seg.speakerLabel].agent += 1;
    for (const cue of CUSTOMER_CUES) if (t.includes(cue)) scores[seg.speakerLabel].customer += 1;
  }
  return scores;
}

function resolveWithHeuristics(segments) {
  const speakers = [...new Set(segments.map(s => s.speakerLabel))];
  if (speakers.length !== 2) {
    return { mapping: null, confidence: 'low', reason: `Expected 2 speakers, found ${speakers.length}.` };
  }

  const scores = scoreSegmentsBySpeaker(segments);
  const [a, b] = speakers;
  const agentNet = { [a]: scores[a].agent - scores[a].customer, [b]: scores[b].agent - scores[b].customer };

  if (agentNet[a] === agentNet[b]) {
    return { mapping: null, confidence: 'low', reason: 'Lexical cues were tied between speakers — cannot confidently distinguish roles.' };
  }

  const agentLabel = agentNet[a] > agentNet[b] ? a : b;
  const customerLabel = agentLabel === a ? b : a;
  const gap = Math.abs(agentNet[a] - agentNet[b]);

  return {
    mapping: { [agentLabel]: 'AGENT', [customerLabel]: 'CUSTOMER' },
    confidence: gap >= 2 ? 'high' : 'medium',
    reason: `Rule-based lexical scoring: ${agentLabel} used ${scores[agentLabel].agent} agent-style phrases vs ${scores[agentLabel].customer} customer-style; ${customerLabel} used ${scores[customerLabel].agent} vs ${scores[customerLabel].customer}.`,
  };
}

async function resolveWithLlm(segments) {
  const transcript = segments.map(s => `${s.speakerLabel}: ${s.text}`).join('\n');
  const system = `You are analyzing a customer-support call transcript that has been diarized into raw speaker labels (SPEAKER_0, SPEAKER_1, ...). Determine which label is the CUSTOMER and which is the AGENT based on conversational content — never assume the first speaker is the customer. Respond ONLY with JSON: {"mapping": {"SPEAKER_0": "AGENT"|"CUSTOMER", ...}, "confidence": "high"|"medium"|"low", "reason": "one sentence"}`;
  const user = `Transcript:\n${transcript}`;

  const result = await llmProvider.completeJson(system, user);
  if (!result || !result.mapping) return null;
  return result;
}

/**
 * @param {Array} segments raw diarized segments [{speakerLabel, text, ...}]
 * @returns {Promise<{segments: Array, mapping: object|null, confidence: string, reason: string}>}
 */
async function resolveSpeakers(segments) {
  let resolution = await resolveWithLlm(segments);
  if (!resolution) {
    resolution = resolveWithHeuristics(segments);
  }

  if (!resolution.mapping) {
    logger.warn('Speaker role resolution was inconclusive — leaving raw SPEAKER_1/SPEAKER_2 labels for manual review.', resolution.reason);
    const speakers = [...new Set(segments.map(s => s.speakerLabel))];
    const fallbackMap = {};
    speakers.forEach((label, i) => { fallbackMap[label] = `SPEAKER_${i + 1}`; });
    return {
      segments: segments.map(s => ({ ...s, role: fallbackMap[s.speakerLabel] })),
      mapping: fallbackMap,
      confidence: 'low',
      reason: resolution.reason,
      needsManualReview: true,
    };
  }

  return {
    segments: segments.map(s => ({ ...s, role: resolution.mapping[s.speakerLabel] || s.speakerLabel })),
    mapping: resolution.mapping,
    confidence: resolution.confidence,
    reason: resolution.reason,
    needsManualReview: resolution.confidence === 'low',
  };
}

module.exports = { resolveSpeakers };
