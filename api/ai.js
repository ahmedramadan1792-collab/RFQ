const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const AI_MODEL = 'claude-sonnet-5';
const MAX_TOKENS_CAP = 2000;
 
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }
 
  // Optional, off by default: set ALLOWED_ORIGIN in Vercel (e.g.
  // "https://your-app.vercel.app") to reject requests whose Origin/Referer
  // header doesn't match. This is a light deterrent, not real security —
  // it can be spoofed by a determined caller — but it stops casual abuse.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin) {
    const source = req.headers.origin || req.headers.referer || '';
    if (!source.startsWith(allowedOrigin)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
  }
 
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing the ANTHROPIC_API_KEY environment variable. Add it in Vercel Project Settings -> Environment Variables, then redeploy.'
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
 
  const cappedMaxTokens = Math.min(Number(maxTokens) || 1000, MAX_TOKENS_CAP);
 
  try {
    const anthropicRes = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: cappedMaxTokens,
        system: systemPrompt || undefined,
        messages: normalizedMessages
      })
    });
 
    const data = await anthropicRes.json();
 
    if (!anthropicRes.ok) {
      const message = (data && data.error && data.error.message) || ('Anthropic API error (' + anthropicRes.status + ')');
      return res.status(anthropicRes.status).json({ error: message });
    }
 
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
};
 
