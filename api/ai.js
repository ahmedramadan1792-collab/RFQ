

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';


const FREE_MODEL_CANDIDATES = [
  process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free',
  'dots-studio/dots-3-note-preview:free',
  'poolside/laguna-s-2.1:free'
].filter(Boolean);

const MIN_TOKENS_FLOOR = 800;
const MAX_TOKENS_CAP = 4096;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }


const RETRY_DELAYS_MS = [500, 1200];
const RETRYABLE_STATUSES = [429, 502, 503, 504];

async function callOpenRouterWithRetry(model, requestBody, apiKey) {
  let res, data;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    res = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        // Optional attribution headers OpenRouter uses for its public
        // rankings — not required for the request to work.
        'HTTP-Referer': process.env.ALLOWED_ORIGIN || 'https://smarter-rfq-pro.vercel.app',
        'X-Title': 'RFQ Smarter'
      },
      body: JSON.stringify(Object.assign({}, requestBody, { model }))
    });
    data = await res.json().catch(() => ({}));

    const isRetryable = RETRYABLE_STATUSES.indexOf(res.status) !== -1;
    const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
    if (res.ok || !isRetryable || isLastAttempt) {
      return { res, data };
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return { res, data };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }


  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin) {
    const source = req.headers.origin || req.headers.referer || '';
    if (!source.startsWith(allowedOrigin)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing the OPENROUTER_API_KEY environment variable. Add it in Vercel Project Settings -> Environment Variables, then redeploy.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body.' });
    }
  }
  const { systemPrompt, messages, maxTokens } = body || {};

  if (!messages || (Array.isArray(messages) && messages.length === 0)) {
    return res.status(400).json({ error: 'Missing "messages".' });
  }

  const normalizedMessages = typeof messages === 'string'
    ? [{ role: 'user', content: messages }]
    : messages;


  const chatMessages = [];
  if (systemPrompt) {
    chatMessages.push({ role: 'system', content: String(systemPrompt) });
  }
  normalizedMessages.forEach(m => {
    chatMessages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content == null ? '' : m.content)
    });
  });

  const cappedMaxTokens = Math.min(Math.max(Number(maxTokens) || 1000, MIN_TOKENS_FLOOR), MAX_TOKENS_CAP);

  const requestBody = {
    messages: chatMessages,
    max_tokens: cappedMaxTokens
  };

  try {
    let result;
    let lastMessage = 'OpenRouter API error.';

    for (let i = 0; i < FREE_MODEL_CANDIDATES.length; i++) {
      const model = FREE_MODEL_CANDIDATES[i];
      result = await callOpenRouterWithRetry(model, requestBody, apiKey);

      if (result.res.ok) break;

      const isRetryable = RETRYABLE_STATUSES.indexOf(result.res.status) !== -1;
      lastMessage = (result.data && result.data.error && result.data.error.message) || ('OpenRouter API error (' + result.res.status + ') for model ' + model);
      const isLastModel = i === FREE_MODEL_CANDIDATES.length - 1;

      if (!isRetryable || isLastModel) break;
    }

    if (!result.res.ok) {
      return res.status(result.res.status).json({ error: lastMessage });
    }

    const choice = result.data.choices && result.data.choices[0];
    const text = (choice && choice.message && choice.message.content) || '';

    if (!text && choice && choice.finish_reason && choice.finish_reason !== 'stop') {
      const reasons = {
        length: 'The reply hit its token limit before finishing. Try a shorter question, or this can be raised in api/ai.js.',
        content_filter: 'The response was blocked by the model\'s content filter.'
      };
      const explanation = reasons[choice.finish_reason] || ('finish_reason: ' + choice.finish_reason);
      return res.status(200).json({ text: '', error: 'The AI returned no text. ' + explanation });
    }

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
};
