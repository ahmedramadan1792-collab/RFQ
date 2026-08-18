const GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
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
 
  // Gemini's chat format differs from the Anthropic-style { role, content }
  // shape the app's front-end sends: roles are "user"/"model" (not
  // "assistant"), and each turn's text lives under parts: [{ text }].
  const contents = normalizedMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content == null ? '' : m.content) }]
  }));
 
  const cappedMaxTokens = Math.min(Number(maxTokens) || 1000, MAX_TOKENS_CAP);
 
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
      // e.g. blocked by safety filters, or ran out of tokens before any text.
      return res.status(200).json({ text: '', error: 'Gemini returned no text (finishReason: ' + candidate.finishReason + ').' });
    }
 
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: 'AI request failed: ' + err.message });
  }
};
