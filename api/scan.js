// Vercel serverless function: POST /api/scan  (reads one product photo with Google Gemini)
// Body: { image: "data:image/jpeg;base64,...", lang: "ar" | "en", cats: ["مسكنات", ...] }
// Header x-user-key: a visitor's own Gemini key (used instead of the shared one; never stored or logged).
// Env:  GEMINI_API_KEY  (required; several keys may be separated by commas, or use GEMINI_API_KEY_2 ... _5)
//       GEMINI_MODELS   (optional, comma list tried in order; default flash-lite, flash, then the *-latest aliases)
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


const crypto = require('crypto');
const kid = k => crypto.createHash('sha1').update(k).digest('hex').slice(0, 10);
const dead = (m, id) => (m.get(id) || 0) > Date.now();
const bad = new Map();    // key id -> blocked until (invalid key)
const cool = new Map();   // key id + model -> blocked until (quota reached or model missing)
const route = new Map();  // key id -> endpoint that worked: 'studio' | 'vertex'

function envKeys() {
  const raw = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4, process.env.GEMINI_API_KEY_5].filter(Boolean).join(',');
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
}
function modelList() {
  const raw = process.env.GEMINI_MODELS || [process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite', process.env.GEMINI_STRONG || 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest'].join(',');
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
}
// Two kinds of keys exist: AI Studio keys (AIza...) and Google Cloud express keys (AQ....).
// A key is tried on the endpoint that matches its prefix first, then on the other one, and the working route is remembered.
function endpointsFor(key) {
  const r = route.get(kid(key));
  if (r) return [r];
  return key.startsWith('AQ.') ? ['vertex', 'studio'] : ['studio', 'vertex'];
}
function urlFor(ep, model, key) {
  return ep === 'vertex'
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(key)}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}
const isAuth = e => e && (e.status === 401 || e.status === 403 || /api key|API_KEY|credential|permission|expired|not valid/i.test(e.detail || ''));
async function upstreamError(r) {
  let detail = '';
  try { const j = await r.json(); detail = String((j.error && j.error.message) || '').slice(0, 200); } catch (e) {}
  return { status: r.status, detail };
}
async function post(model, key, parts, gen) {
  let last = null;
  for (const ep of endpointsFor(key)) {
    let r;
    try {
      r = await fetch(urlFor(ep, model, key), {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: gen })
      });
    } catch (e) { last = { status: 0, detail: 'network' }; continue; }
    if (r.ok) { route.set(kid(key), ep); return r; }
    last = await upstreamError(r);
    if (!(isAuth(last) || last.status === 404)) break;   // only auth/model problems justify trying the other endpoint
  }
  throw last || { status: 0, detail: 'network' };
}
function genConfig(model, schema) {
  const gen = { temperature: 0, maxOutputTokens: 400 };
  if (schema) { gen.responseMimeType = 'application/json'; gen.responseSchema = SCHEMA; }
  if (/2\.5/.test(model) || /latest/.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
  return gen;
}
async function generate(model, key, parts, schema) {
  try { return await post(model, key, parts, genConfig(model, schema)); }
  catch (e) {
    // a 400 that is not about the key usually means this model dislikes the schema or thinking options: retry plainly once
    if (e.status === 400 && !isAuth(e)) return post(model, key, parts, { temperature: 0, maxOutputTokens: 400, responseMimeType: schema ? 'application/json' : undefined });
    throw e;
  }
}
async function readOnce(model, key, mime, b64, prompt) {
  const r = await generate(model, key, [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }], true);
  const data = await r.json();
  const text = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw { status: 502, detail: 'invalid_json' };
  return JSON.parse(text.slice(a, b + 1));
}
const weak = o => !o || o.found === false || !String(o.name || '').trim();   // a name found is accepted at once, even with modest confidence
const score = o => (o && String(o.name || '').trim() ? 1 : 0) + (Number(o && o.confidence) || 0);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = process.env.ACCESS_CODE;
  const shared = envKeys();
  const models = modelList();
  const userKey = String(req.headers['x-user-key'] || '').trim();

  if (req.method === 'GET') {            // warm-up and diagnostics: /api/scan  or  /api/scan?test=1
    const info = { ok: true, keys: shared.length, models };
    if (req.query && req.query.test) {
      if (!userKey && code && req.headers['x-access-code'] !== code && req.query.code !== code) return res.status(401).json({ error: 'access_code' });
      const probe = async (key, model) => {
        const out = {};
        for (const ep of ['studio', 'vertex']) {
          try {
            const r = await fetch(urlFor(ep, model, key), { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }], generationConfig: { maxOutputTokens: 20 } }) });
            if (r.ok) { route.set(kid(key), ep); out[ep] = { ok: true }; break; }
            out[ep] = Object.assign({ ok: false }, await upstreamError(r));
          } catch (e) { out[ep] = { ok: false, detail: 'network' }; }
        }
        out.ok = !!((out.studio && out.studio.ok) || (out.vertex && out.vertex.ok));
        return out;
      };
      if (userKey) {
        if (!/^[A-Za-z0-9._\-]{20,200}$/.test(userKey)) return res.status(200).json({ ok: false, user: { ok: false, detail: 'bad_format' } });
        return res.status(200).json({ ok: true, user: await probe(userKey, models[0]) });
      }
      info.test = [];
      for (let i = 0; i < shared.length; i++) info.test.push(Object.assign({ key: 'key' + (i + 1), prefix: shared[i].slice(0, 3) }, await probe(shared[i], models[0])));
    }
    return res.status(200).json(info);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!userKey && code && req.headers['x-access-code'] !== code) return res.status(401).json({ error: 'access_code' });
  if (userKey && !/^[A-Za-z0-9._\-]{20,200}$/.test(userKey)) return res.status(400).json({ error: 'user_key_invalid' });
  const pool = userKey ? [userKey] : shared;
  if (!pool.length) return res.status(500).json({ error: 'missing_api_key' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  if (limited(ip, (+process.env.RATE_PER_MIN || 30) * (userKey ? 2 : 1))) return res.status(429).json({ error: 'slow_down' });

  const { image, lang, cats } = req.body || {};
  const m = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'bad_image' });
  if (image.length > 4_000_000) return res.status(413).json({ error: 'too_large' });
  const list = (Array.isArray(cats) ? cats : []).slice(0, 80).map(c => String(c).slice(0, 40));
  const prompt = buildPrompt(lang, list);

  // Walk the models in order and, inside each model, the keys. A limited or invalid one is skipped (and remembered for a while),
  // so the next one answers. A weak answer earns one second opinion from the next model.
  let best = null, answers = 0, quota = 0, auth = 0, other = null;
  for (const model of models) {
    for (const key of pool) {
      const id = kid(key);
      if (dead(bad, id)) { auth++; continue; }
      if (dead(cool, id + model)) { quota++; continue; }
      try {
        const o = await readOnce(model, key, m[1], m[2], prompt);
        answers++; if (!best || score(o) > score(best)) best = o;
        break;
      } catch (e) {
        if (isAuth(e)) { auth++; if (!userKey) bad.set(id, Date.now() + 600000); other = other || e; }
        else if (e.status === 429) { quota++; cool.set(id + model, Date.now() + (/per day|daily|PerDay/i.test(e.detail || '') ? 1800000 : 20000)); }
        else if (e.status === 404) { cool.set(id + model, Date.now() + 3600000); other = other || e; }
        else other = other || e;
      }
    }
    if (best && (!weak(best) || answers >= 2)) break;
  }
  if (best) return res.status(200).json(best);
  if (quota && !auth && !other) return res.status(429).json({ error: userKey ? 'user_key_limited' : 'quota_exhausted' });
  if (auth && !quota) return res.status(502).json({ error: userKey ? 'user_key_invalid' : 'upstream_auth', detail: other && other.detail });
  if (quota) return res.status(429).json({ error: userKey ? 'user_key_limited' : 'quota_exhausted' });
  return res.status(502).json({ error: 'upstream', status: other && other.status, detail: other && other.detail });
};
