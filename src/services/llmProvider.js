/**
 * Pluggable LLM provider. Both speakerResolver.js and extractionService.js
 * call `completeJson(systemPrompt, userPrompt)` and get back a parsed JS
 * object — they don't know or care whether it came from Anthropic, OpenAI,
 * or nothing at all (config.llm.provider === "rule-based" returns null,
 * and callers fall back to heuristics).
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

function extractJsonBlock(text) {
  // Models sometimes wrap JSON in prose or code fences — pull out the
  // outermost {...} block defensively.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch (e) {
    return null;
  }
}

async function completeJson(systemPrompt, userPrompt) {
  if (config.llm.provider === 'anthropic') return callAnthropic(systemPrompt, userPrompt);
  if (config.llm.provider === 'openai') return callOpenAI(systemPrompt, userPrompt);
  if (config.llm.provider === 'groq') return callGroq(systemPrompt, userPrompt);
  return null; // rule-based mode — caller handles fallback
}

async function callAnthropic(systemPrompt, userPrompt) {
  if (!config.llm.anthropicApiKey) {
    logger.warn('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing — falling back to rule-based logic for this call.');
    return null;
  }
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: config.llm.anthropicModel,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      {
        headers: {
          'x-api-key': config.llm.anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 60000,
      }
    );
    const text = res.data?.content?.[0]?.text || '';
    return extractJsonBlock(text);
  } catch (err) {
    logger.error('Anthropic call failed', err.response?.data || err.message);
    return null;
  }
}

async function callOpenAI(systemPrompt, userPrompt) {
  if (!config.llm.openaiApiKey) {
    logger.warn('LLM_PROVIDER=openai but OPENAI_API_KEY is missing — falling back to rule-based logic for this call.');
    return null;
  }
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: config.llm.openaiModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.llm.openaiApiKey}`,
          'content-type': 'application/json',
        },
        timeout: 60000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    return extractJsonBlock(text);
  } catch (err) {
    logger.error('OpenAI call failed', err.response?.data || err.message);
    return null;
  }
}

async function callGroq(systemPrompt, userPrompt) {
  if (!config.llm.groqApiKey) {
    logger.warn('LLM_PROVIDER=groq but GROQ_API_KEY is missing — falling back to rule-based logic for this call.');
    return null;
  }
  try {
    // Groq's API is OpenAI-compatible, just a different base URL + free
    // open-source models (e.g. Llama 3.3 70B) instead of GPT.
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: config.llm.groqModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${config.llm.groqApiKey}`,
          'content-type': 'application/json',
        },
        timeout: 60000,
      }
    );
    const text = res.data?.choices?.[0]?.message?.content || '';
    return extractJsonBlock(text);
  } catch (err) {
    logger.error('Groq call failed', err.response?.data || err.message);
    return null;
  }
}

module.exports = { completeJson };
