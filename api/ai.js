// Vercel serverless function — secure proxy for the app's "AI Procurement
// Assistant" panel.
//
// The app's front-end (index.html) never calls an AI provider directly —
// it POSTs { systemPrompt, messages, maxTokens } to this endpoint
// ("/api/ai") and expects back { text: "..." }. That contract hasn't
// changed, so index.html does NOT need any edits when swapping providers.
//
// THIS VERSION USES GOOGLE'S GEMINI API (free tier), not Anthropic's paid
// Claude API. Why: Claude's API is pay-per-use with no ongoing free tier —
// after a small one-time trial credit, it requires a funded billing
// account. Gemini API keys created in Google AI Studio start on a genuinely
// free usage tier with no credit card required, just rate limits (requests
// per minute/day) — a good fit for light, occasional internal use. If you
// ever hit those rate limits or want higher quality/throughput, the fix is
// either adding billing on the Google side, or switching back to a paid
// provider like Anthropic (ask for that change — it's a small edit here,
// nothing in index.html needs to move either way).
//
// SETUP REQUIRED (see the chat instructions for full steps):
//   1. Get a free API key at https://aistudio.google.com/apikey (sign in
//      with a Google account, accept the terms, click "Create API key" —
//      no card needed to get a working key on the free tier).
//   2. In your Vercel project: Settings -> Environment Variables -> add
//      GEMINI_API_KEY = <your key>  (Production, and Preview if you want).
//   3. Redeploy (Vercel doesn't apply new env vars to old deployments —
//      trigger a fresh deploy, e.g. Deployments -> "..." -> Redeploy).
//      Vercel picks up this file automatically as a serverless function at
//      yourapp.vercel.app/api/ai — no extra config needed.
//
// SECURITY NOTE: this app has no real per-user login (it uses a shared
// passcode system, not Supabase Auth — see the rest of the app for that
// same tradeoff), so this endpoint is reachable by anyone who knows your
// app's URL, not just signed-in team members. That mostly just means you
// could hit Gemini's free-tier rate limit faster than expected if someone
// scripted requests at it — there's no surprise bill risk the way there was
// with a paid API, since the free tier simply stops responding (with an
// error) once the limit is hit rather than charging you. The MAX_TOKENS_CAP
// below still limits how large any single response can be, and you can
// optionally set an ALLOWED_ORIGIN environment variable (see below) as a
// light extra check — neither is strong access control. If this ever needs
// real protection, the fix is wiring the app up to real user accounts
// (Supabase Auth) so requests can be tied to a logged-in user.

// "gemini-flash-latest" always points at Google's newest flash model —
// which is exactly what makes it prone to "high demand" overload errors on
// the free tier, since every free user's app defaults to that same model.
// gemini-2.5-flash-lite is an older, established, still very capable model
// that sees a lot less of that traffic, so it's used as an automatic
// fallback below when the primary model stays overloaded.
const GEMINI_MODEL_PRIMARY = 'gemini-flash-latest';
const GEMINI_MODEL_FALLBACK = 'gemini-2.5-flash-lite';
function geminiEndpoint(model) { return 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent'; }
// This model "thinks" internally before writing its visible answer, and
// that thinking draws from the SAME token budget as the reply
// (maxOutputTokens covers both). A low budget can get fully consumed by
// thinking with nothing left for the actual text, which comes back as an
// empty response with finishReason "MAX_TOKENS". MIN_TOKENS_FLOOR keeps
// enough headroom for both regardless of what the caller asks for.
const MIN_TOKENS_FLOOR = 1500;
const MAX_TOKENS_CAP = 4096;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// The free tier occasionally returns 503 ("model overloaded") or 429
// ("rate limited") during high-traffic periods — usually resolved within a
// second or two. Retry a couple of times with a short backoff before
// giving up, so a brief blip doesn't surface as a failure to the user.
const RETRY_DELAYS_MS = [500, 1200];

async function callGeminiWithRetry(url, requestBody) {
  let geminiRes, data;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    data = await geminiRes.json();

    const isRetryable = geminiRes.status === 503 || geminiRes.status === 429;
    const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
    if (geminiRes.ok || !isRetryable || isLastAttempt) {
      return { res: geminiRes, data };
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return { res: geminiRes, data };
}

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

  const cappedMaxTokens = Math.min(Math.max(Number(maxTokens) || 1000, MIN_TOKENS_FLOOR), MAX_TOKENS_CAP);

  const requestBody = {
    contents,
    generationConfig: { maxOutputTokens: cappedMaxTokens }
  };
  if (systemPrompt) {
    requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  try {
    let { res: geminiRes, data } = await callGeminiWithRetry(geminiEndpoint(GEMINI_MODEL_PRIMARY) + '?key=' + encodeURIComponent(apiKey), requestBody);

    // Still overloaded/rate-limited after retrying the primary model? Give
    // the older, less-congested fallback model one try before giving up.
    if (!geminiRes.ok && (geminiRes.status === 503 || geminiRes.status === 429)) {
      ({ res: geminiRes, data } = await callGeminiWithRetry(geminiEndpoint(GEMINI_MODEL_FALLBACK) + '?key=' + encodeURIComponent(apiKey), requestBody));
    }

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
