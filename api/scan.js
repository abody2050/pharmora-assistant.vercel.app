// Vercel serverless function: POST /api/scan  (reads one product photo with Google Gemini)
// Body: { image: "data:image/jpeg;base64,...", lang: "ar" | "en", cats: ["مسكنات", ...] }
// Env:  GEMINI_API_KEY (required)
//       GEMINI_MODEL    (optional, fast first attempt, default gemini-2.5-flash-lite)
//       GEMINI_STRONG   (optional, used when the first answer is weak or the fast model is limited, default gemini-2.5-flash)
//       ACCESS_CODE     (optional, restricts use to people who know the code)
//       RATE_PER_MIN    (optional, per-IP limit, default 30)
const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  return arr.length > max;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    found: { type: 'BOOLEAN' }, name: { type: 'STRING' }, sci: { type: 'STRING' }, cat: { type: 'STRING' },
    newCat: { type: 'STRING' }, barcode: { type: 'STRING' }, exp: { type: 'STRING' }, form: { type: 'STRING' },
    packCount: { type: 'INTEGER', nullable: true }, confidence: { type: 'NUMBER' }
  },
  required: ['found', 'name', 'sci', 'cat', 'newCat', 'barcode', 'exp', 'form', 'packCount', 'confidence']
};

function buildPrompt(lang, list) {
  const L = lang === 'en' ? 'English (Latin letters)' : 'Arabic';
  const ex = lang === 'en' ? '"Panadol 500 mg"' : '"بنادول 500 ملجم"';
  return `You are reading the packaging of one medicine or pharmacy product (box, blister, bottle, tube, device) for a pharmacy inventory app. Read only what is printed. Never invent values.
Reply with ONLY one JSON object, no other text:
{"found":boolean,"name":string,"sci":string,"cat":string,"newCat":string,"barcode":string,"exp":string,"form":string,"packCount":number|null,"confidence":number}
Rules:
- name: brand name plus strength, written in ${L}, like ${ex}. The brand is usually the largest text on the front; the strength sits next to it. Packaging designs vary a lot, so use the most prominent product name even when letters are stylized or partly cut off. If several products are visible, use the one nearest the center. If the brand is printed in another language, transliterate it to ${L}. Add the form only when it separates products (syrup, drops, cream, injection). No manufacturer, no slogans.
- sci: active ingredient(s) without strengths, in ${L}; "" if not printed or unsure.
- cat: exactly one string copied from this list, or "" if none fits: ${JSON.stringify(list)}
- newCat: only when cat is "": a short Arabic category name; otherwise "".
- barcode: the digits printed under the barcode, only when every digit is clearly legible; otherwise "".
- exp: the expiry date printed on the pack (labels such as EXP, Exp. date, Use before, ينتهي, تاريخ الانتهاء) as YYYY-MM-DD, or YYYY-MM when only month and year are printed. Never use the manufacturing date (MFG, Prod., تاريخ الإنتاج). "" when no expiry date is visible.
- form: one of tablet, capsule, syrup, drops, cream, ointment, gel, injection, inhaler, spray, suppository, sachet, device, supply, other.
- packCount: how many individual units the pack holds when printed (20 for "20 tablets"); otherwise null.
- confidence: 0 to 1.
If the image shows no product, reply {"found":false,"name":"","sci":"","cat":"","newCat":"","barcode":"","exp":"","form":"other","packCount":null,"confidence":0}.`;
}

function endpoint(model, key) {
  // Keys that start with "AQ." are Vertex AI express-mode keys; AI Studio keys start with "AIza".
  return key.startsWith('AQ.')
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

async function post(model, key, parts, gen) {
  return fetch(endpoint(model, key), {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: gen })
  });
}
function genConfig(model, schema) {
  const gen = { temperature: 0, maxOutputTokens: 400 };
  if (schema) { gen.responseMimeType = 'application/json'; gen.responseSchema = SCHEMA; }
  if (/2\.5/.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
  return gen;
}
async function upstreamError(r) {
  let detail = '';
  try { const j = await r.json(); detail = String((j.error && j.error.message) || '').slice(0, 160); } catch (e) {}
  return { status: r.status, detail };
}
function mapError(e) {
  const st = e.status || 0;
  if (st === 429) return ['rate_limited', 429];
  if (st === 404) return ['upstream_model', 502];
  if (st === 400 || st === 401 || st === 403) return ['upstream_auth', 502];
  return ['upstream', 502];
}
async function readOnce(model, key, mime, b64, prompt) {
  const r = await post(model, key, [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }], genConfig(model, true));
  if (!r.ok) throw await upstreamError(r);
  const data = await r.json();
  const text = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw { status: 502, detail: 'invalid_json' };
  return JSON.parse(text.slice(a, b + 1));
}
const weak = o => !o || o.found === false || !String(o.name || '').trim() || (Number(o.confidence) || 0) < 0.55;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = process.env.ACCESS_CODE;
  const key = process.env.GEMINI_API_KEY;
  const FAST = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';       // quick first attempt
  const STRONG = process.env.GEMINI_STRONG || 'gemini-2.5-flash';         // used when the first answer is weak or limited

  if (req.method === 'GET') {            // warm-up and diagnostics: /api/scan  or  /api/scan?test=1
    const info = { ok: true, hasKey: !!key, api: key && key.startsWith('AQ.') ? 'vertex-express' : 'ai-studio', fast: FAST, strong: STRONG };
    if (req.query && req.query.test && key) {
      if (code && req.headers['x-access-code'] !== code && req.query.code !== code) return res.status(401).json({ error: 'access_code' });
      info.test = {};
      for (const [label, model] of [['fast', FAST], ['strong', STRONG]]) {
        try {
          const r = await post(model, key, [{ text: 'Reply with the word OK.' }], genConfig(model, false));
          info.test[label] = r.ok ? { ok: true } : Object.assign({ ok: false }, await upstreamError(r));
        } catch (e) { info.test[label] = { ok: false, detail: 'network' }; }
      }
    }
    return res.status(200).json(info);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (code && req.headers['x-access-code'] !== code) return res.status(401).json({ error: 'access_code' });
  if (!key) return res.status(500).json({ error: 'missing_api_key' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  if (limited(ip, +process.env.RATE_PER_MIN || 30)) return res.status(429).json({ error: 'rate_limited' });

  const { image, lang, cats } = req.body || {};
  const m = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'bad_image' });
  if (image.length > 4_000_000) return res.status(413).json({ error: 'too_large' });
  const list = (Array.isArray(cats) ? cats : []).slice(0, 80).map(c => String(c).slice(0, 40));
  const prompt = buildPrompt(lang, list);

  let first = null, err = null;
  try { first = await readOnce(FAST, key, m[1], m[2], prompt); } catch (e) { err = e; }
  if (first && !weak(first)) return res.status(200).json(first);
  if (err && err.status && [400, 401, 403].includes(err.status)) { const [c, st] = mapError(err); return res.status(st).json({ error: c, status: err.status, detail: err.detail }); }
  try {                                  // second opinion from the stronger model
    const second = await readOnce(STRONG, key, m[1], m[2], prompt);
    return res.status(200).json(!weak(second) || !first ? second : first);
  } catch (e2) {
    if (first) return res.status(200).json(first);
    const [c, st] = mapError(e2.status ? e2 : (err || e2));
    return res.status(st).json({ error: c, status: (e2 && e2.status) || (err && err.status), detail: (e2 && e2.detail) || (err && err.detail) });
  }
};
