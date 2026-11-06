// Vercel serverless function: POST /api/scan
// Body: { image, lang, cats }
//
// Environment variables:
// GEMINI_API_KEY (required)
// ACCESS_CODE (optional)
// GEMINI_MODEL (optional)

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const accessCode = process.env.ACCESS_CODE;

  if (accessCode && req.headers['x-access-code'] !== accessCode) {
    return res.status(401).json({ error: 'access_code' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'missing_api_key' });
  }

  const { image, lang, cats } = req.body || {};

  const match = typeof image === 'string' &&
    image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);

  if (!match) {
    return res.status(400).json({ error: 'bad_image' });
  }

  if (image.length > 4_000_000) {
    return res.status(413).json({ error: 'too_large' });
  }

  const categories = (Array.isArray(cats) ? cats : [])
    .slice(0, 80)
    .map(category => String(category).slice(0, 40));

  const language = lang === 'en'
    ? 'English (Latin letters)'
    : 'Arabic';

  const example = lang === 'en'
    ? '"Panadol 500 mg"'
    : '"بنادول 500 ملجم"';

  const prompt = `You are reading the packaging of one medicine or pharmacy product (box, blister, bottle, tube, device) for a pharmacy inventory app. Read only what is printed. Never invent values.

Reply with ONLY one valid JSON object, no markdown and no other text:

{"found":boolean,"name":string,"sci":string,"cat":string,"newCat":string,"barcode":string,"form":string,"packCount":number|null,"confidence":number}

Rules:
- name: brand name plus strength, written in ${language}, like ${example}. If the brand is printed in another language, transliterate it to ${language}. Add the form only when it separates products (syrup, drops, cream, injection). No manufacturer, no slogans.
- sci: active ingredient(s) without strengths, in ${language}; "" if not printed or unsure.
- cat: exactly one string copied from this list, or "" if none fits: ${JSON.stringify(categories)}
- newCat: only when cat is "": a short Arabic category name; otherwise "".
- barcode: the digits printed under the barcode, only when every digit is clearly legible; otherwise "".
- form: one of tablet, capsule, syrup, drops, cream, ointment, gel, injection, inhaler, spray, suppository, sachet, device, supply, other.
- packCount: how many individual units the pack holds when printed (20 for "20 tablets"); otherwise null.
- confidence: a number from 0 to 1.

If the image shows no product, reply exactly with {"found":false,"name":"","sci":"","cat":"","newCat":"","barcode":"","form":"other","packCount":null,"confidence":0}.`;

  try {

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const response = await fetch(endpoint, {
      method: 'POST',

      headers: {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json'
      },

      body: JSON.stringify({

        contents: [{
          role: 'user',

          parts: [
            {
              inline_data: {
                mime_type: match[1],
                data: match[2]
              }
            },

            { text: prompt }
          ]
        }],

        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 500,
          responseMimeType: 'application/json'
        }

      })
    });

    const data = await response.json();

    if (!response.ok) {

      console.error(
        'Gemini API error:',
        response.status,
        data?.error?.message || 'Unknown error'
      );

      return res.status(502).json({
        error: 'upstream',
        status: response.status
      });
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || '')
      .join('')
      .trim();

    if (!text) {
      return res.status(502).json({ error: 'empty_response' });
    }

    let result;

    try {
      result = JSON.parse(text);

    } catch {

      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');

      if (start < 0 || end < start) {
        return res.status(502).json({ error: 'invalid_json' });
      }

      try {
        result = JSON.parse(text.slice(start, end + 1));

      } catch {
        return res.status(502).json({ error: 'invalid_json' });
      }
    }

    return res.status(200).json(result);

  } catch (error) {

    console.error('Scan function failed:', error?.message || error);

    return res.status(502).json({ error: 'failed' });
  }
};
