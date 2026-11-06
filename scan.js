// Vercel serverless function: POST /api/scan
// Body: { image: "data:image/jpeg;base64,...", lang: "ar" | "en", cats: ["مسكنات", ...] }
// Env:  ANTHROPIC_API_KEY (required), ACCESS_CODE (optional), ANTHROPIC_MODEL (optional)
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const code = process.env.ACCESS_CODE;
  if (code && req.headers['x-access-code'] !== code) return res.status(401).json({ error: 'access_code' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'missing_api_key' });

  const { image, lang, cats } = req.body || {};
  const m = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'bad_image' });
  if (image.length > 4_000_000) return res.status(413).json({ error: 'too_large' });
  const list = (Array.isArray(cats) ? cats : []).slice(0, 80).map(c => String(c).slice(0, 40));

  const L = lang === 'en' ? 'English (Latin letters)' : 'Arabic';
  const ex = lang === 'en' ? '"Panadol 500 mg"' : '"بنادول 500 ملجم"';
  const prompt = `You are reading the packaging of one medicine or pharmacy product (box, blister, bottle, tube, device) for a pharmacy inventory app. Read only what is printed. Never invent values.
Reply with ONLY one JSON object, no other text:
{"found":boolean,"name":string,"sci":string,"cat":string,"newCat":string,"barcode":string,"form":string,"packCount":number|null,"confidence":number}
Rules:
- name: brand name plus strength, written in ${L}, like ${ex}. If the brand is printed in another language, transliterate it to ${L}. Add the form only when it separates products (syrup, drops, cream, injection). No manufacturer, no slogans.
- sci: active ingredient(s) without strengths, in ${L}; "" if not printed or unsure.
- cat: exactly one string copied from this list, or "" if none fits: ${JSON.stringify(list)}
- newCat: only when cat is "": a short Arabic category name; otherwise "".
- barcode: the digits printed under the barcode, only when every digit is clearly legible; otherwise "".
- form: one of tablet, capsule, syrup, drops, cream, ointment, gel, injection, inhaler, spray, suppository, sachet, device, supply, other.
- packCount: how many individual units the pack holds when printed (20 for "20 tablets"); otherwise null.
- confidence: 0 to 1.
If the image shows no product, reply {"found":false,"name":"","sci":"","cat":"","newCat":"","barcode":"","form":"other","packCount":null,"confidence":0}.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: prompt }
        ] }]
      })
    });
    if (!r.ok) return res.status(502).json({ error: 'upstream', status: r.status });
    const data = await r.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) return res.status(502).json({ error: 'invalid_json' });
    return res.status(200).json(JSON.parse(text.slice(a, b + 1)));
  } catch (e) {
    return res.status(502).json({ error: 'failed' });
  }
};
