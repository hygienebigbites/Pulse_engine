/**
 * Turns a role-labeled transcript (CUSTOMER/AGENT segments) into the
 * structured call-analysis object the UI displays:
 *   orderId, customerIssue, agentResponse, resolutionOffered, callOutcome,
 *   customerSentiment, agentPerformance (score + notes), importantEvents
 *
 * Uses the configured LLM when available (much higher quality — it can
 * actually understand the conversation), and falls back to transparent
 * rule-based heuristics otherwise so the app still produces *something*
 * useful with zero API keys.
 */

const config = require('../config');
const llmProvider = require('./llmProvider');
const logger = require('../utils/logger');

function extractOrderIdsRegex(fullText) {
  const re = new RegExp(config.orderIdRegex, 'g');
  const matches = [...fullText.matchAll(re)].map(m => m[0]);
  return [...new Set(matches)];
}

const POSITIVE_WORDS = ['thank you', 'thanks', 'great', 'appreciate', 'happy', 'good', 'perfect', 'resolved'];
const NEGATIVE_WORDS = ['not happy', 'angry', 'frustrated', 'worst', 'terrible', 'still waiting', 'not received', 'unacceptable', 'disappointed', 'never', 'complain'];

function ruleBasedSentiment(customerText) {
  const t = customerText.toLowerCase();
  let pos = 0, neg = 0;
  POSITIVE_WORDS.forEach(w => { if (t.includes(w)) pos += 1; });
  NEGATIVE_WORDS.forEach(w => { if (t.includes(w)) neg += 1; });
  if (neg > pos) return 'negative';
  if (pos > neg) return 'positive';
  return 'neutral';
}

// Very rough keyword map so rule-based mode (no LLM configured) still puts
// *something* plausible in Complaint Category instead of leaving it blank.
// Nowhere near as reliable as LLM classification — flagged via
// extractionMethod so reviewers know to double-check it.
const CATEGORY_KEYWORDS = {
  'Food Quality': ['cold food', 'stale', 'spoiled', 'taste', 'quality', 'raw', 'burnt'],
  'Wrong Item': ['wrong item', 'wrong order', 'different item', 'not what i ordered'],
  'Missing Item': ['missing', 'not received the', 'item was missing', 'short'],
  'Late Delivery': ['late', 'delay', 'took too long', 'still waiting'],
  'Order Not Delivered': ['not delivered', 'never arrived', 'did not receive', 'no delivery'],
  'Payment/Refund Issue': ['refund', 'payment', 'charged', 'money back', 'double charged'],
  'Packaging Issue': ['packaging', 'spilled', 'leak', 'box damaged', 'container'],
  'Rude Behavior': ['rude', 'misbehav', 'shouted', 'disrespect'],
  'App/Technical Issue': ['app crash', 'not working', 'technical', 'bug', 'error on app'],
  'Delivery Partner Issue': ['delivery boy', 'delivery partner', 'rider', 'driver'],
  'Pricing Issue': ['overcharg', 'price', 'expensive', 'bill amount'],
};

function ruleBasedComplaintCategory(fullTextLower) {
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => fullTextLower.includes(k))) return category;
  }
  return 'General Inquiry';
}

function emptyQaParameters(note) {
  const parameters = {};
  config.qaParameters.forEach(p => { parameters[p.key] = { score: null, note: null }; });
  return { parameters, weightedScore: null, notes: note };
}

function ruleBasedExtraction(resolvedSegments, callMeta) {
  const fullText = resolvedSegments.map(s => s.text).join(' ');
  const customerSegments = resolvedSegments.filter(s => s.role === 'CUSTOMER');
  const agentSegments = resolvedSegments.filter(s => s.role === 'AGENT');
  const customerText = customerSegments.map(s => s.text).join(' ');
  const agentText = agentSegments.map(s => s.text).join(' ');

  const orderIds = extractOrderIdsRegex(fullText);
  const customerIssue = customerSegments[0]?.text || null;
  const agentResponse = agentSegments.map(s => s.text).join(' ') || null;

  return {
    orderId: orderIds[0] || null,
    orderIdCandidates: orderIds,
    item: null, // rule-based mode can't reliably name the menu item — needs an LLM
    complaintCategory: ruleBasedComplaintCategory(fullText.toLowerCase()),
    customerIssue,
    customerSummary: customerIssue,
    agentResponse,
    agentSummary: agentResponse,
    resolutionOffered: agentSegments[agentSegments.length - 1]?.text || null,
    callOutcome: /resolved|refund|replace|escalat|delivered/i.test(agentText) ? 'likely resolved' : 'unclear — review manually',
    customerSentiment: ruleBasedSentiment(customerText),
    agentPerformance: {
      score: null,
      notes: 'Rule-based mode cannot score agent performance meaningfully — configure an LLM provider (ANTHROPIC, OPENAI, or the free GROQ) for real QA scoring.',
    },
    agentQA: emptyQaParameters('Rule-based mode cannot score agent QA parameters — configure an LLM provider for the weighted QA rubric.'),
    importantEvents: [],
    extractionMethod: 'rule-based',
    callMeta,
  };
}

function buildQaParameterSchemaLines() {
  return config.qaParameters
    .map(p => `      "${p.key}": { "score": 0-10 integer, "note": "one short sentence on ${p.label}" }`)
    .join(',\n');
}

function computeWeightedQaScore(parameters) {
  if (!parameters) return null;
  let totalWeight = 0;
  let earned = 0;
  let anyScored = false;
  config.qaParameters.forEach(p => {
    const entry = parameters[p.key];
    const score = entry && typeof entry.score === 'number' ? entry.score : null;
    totalWeight += p.weight;
    if (score != null) {
      anyScored = true;
      earned += (Math.max(0, Math.min(10, score)) / 10) * p.weight;
    }
  });
  if (!anyScored) return null;
  // Scale up in case some parameters were left unscored, so a partial
  // rubric doesn't unfairly tank the score.
  return Math.round((earned / totalWeight) * 100);
}

async function llmExtraction(resolvedSegments, callMeta) {
  const transcript = resolvedSegments.map(s => `${s.role}: ${s.text}`).join('\n');
  const categoryList = config.complaintCategories.map(c => `"${c}"`).join(' | ');

  const system = `You are a senior QA analyst for a food-delivery company's call center (Hygiene BigBites). Analyze the given CUSTOMER/AGENT labeled call transcript and extract structured data. Respond ONLY with valid JSON matching exactly this shape:
{
  "orderId": "string or null - the order/ticket number mentioned, if any",
  "orderIdCandidates": ["array of all numeric IDs mentioned that could plausibly be order IDs"],
  "item": "string or null - the specific menu item/dish mentioned, if any",
  "complaintCategory": ${categoryList},
  "customerIssue": "one to two sentence summary of what the customer's problem was",
  "agentResponse": "one to two sentence summary of how the agent responded/handled it",
  "resolutionOffered": "what resolution, if any, was offered (refund, replacement, ETA, escalation, none)",
  "callOutcome": "resolved" | "partially resolved" | "unresolved" | "escalated" | "unclear",
  "customerSentiment": "positive" | "neutral" | "negative" | "mixed",
  "agentPerformance": {
    "score": 1-10 integer,
    "notes": "brief QA-style feedback on tone, accuracy, empathy, and resolution quality"
  },
  "agentQA": {
    "parameters": {
${buildQaParameterSchemaLines()}
    },
    "notes": "one to two sentence overall QA summary"
  },
  "importantEvents": ["short bullet strings for notable actions/events mentioned, e.g. 'refund of ₹450 promised', 'escalated to logistics team', 'delivery partner reassigned'"]
}
Score every agentQA parameter even if the call is short — use your best judgment from what's actually in the transcript. Be precise and only state what the transcript actually supports — do not invent details.`;

  const user = `Call metadata: ${JSON.stringify(callMeta)}\n\nTranscript:\n${transcript}`;

  const result = await llmProvider.completeJson(system, user);
  if (!result) return null;

  // Weighted score is computed here, not trusted from the LLM, so the
  // rubric weights in config.js are always the single source of truth.
  if (result.agentQA && result.agentQA.parameters) {
    result.agentQA.weightedScore = computeWeightedQaScore(result.agentQA.parameters);
  }

  return {
    ...result,
    customerSummary: result.customerSummary || result.customerIssue,
    agentSummary: result.agentSummary || result.agentResponse,
    extractionMethod: `llm:${config.llm.provider}`,
    callMeta,
  };
}

async function extractCallData(resolvedSegments, callMeta) {
  const llmResult = await llmExtraction(resolvedSegments, callMeta);
  if (llmResult) return llmResult;

  logger.warn('Falling back to rule-based extraction (no LLM configured or LLM call failed).');
  return ruleBasedExtraction(resolvedSegments, callMeta);
}

module.exports = { extractCallData };
