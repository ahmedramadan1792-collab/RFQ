
 
const GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

const MIN_TOKENS_FLOOR = 1500;
const MAX_TOKENS_CAP = 4096;
 
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
 
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing the GEMINI_API_KEY environment variable. Add it in Vercel Project Settings -> Environment Variables, then redeploy.'
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
 

  const contents = normalizedMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content == null ? '' : m.content) }]
  }));
 
  const cappedMaxTokens = Math.min(Math.max(Number(maxTokens) || 1000, MIN_TOKENS_FLOOR), MAX_TOKENS_CAP);
 
  const requestBody = {
    contents,
    generationConfig: { maxOutputTokens: cappedMaxTokens }
  };
  if (systemPrompt) {
    requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
 
  try {
    const geminiRes = await fetch(GEMINI_ENDPOINT + '?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
 
    const data = await geminiRes.json();
 
    if (!geminiRes.ok) {
      const message = (data && data.error && data.error.message) || ('Gemini API error (' + geminiRes.status + ')');
      return res.status(geminiRes.status).json({ error: message });
    }
 
    const candidate = data.candidates && data.candidates[0];
    const text = (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text) || '';
 
    if (!text && candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
      const reasons = {
        MAX_TOKENS: 'The reply used up its whole token budget on internal reasoning before writing an answer. This request should have had enough headroom (' + cappedMaxTokens + ' tokens) — if this keeps happening, the conversation or system prompt may just be too long; try a shorter question.',
        SAFETY: 'The response was blocked by Gemini\'s safety filters.',
        RECITATION: 'The response was blocked because it matched existing content too closely.'
      };
      const explanation = reasons[candidate.finishReason] || ('finishReason: ' + candidate.finishReason);
      return res.status(200).json({ text: '', error: 'Gemini returned no text. ' + explanation });
    }
 
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
};
 
