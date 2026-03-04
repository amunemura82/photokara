const GAS_URL = 'https://script.google.com/macros/s/AKfycbz9cVVHNmhj1-AF46MDgTvLeC7U72-xporWy0FH9MYR65_xL4IeWDHy09Fsb8_fQAd5/exec';

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
  },
};

// JSON候補を安全に抽出
function extractJsonCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const fence = rawText.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) return fence[1].trim();
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return rawText.slice(first, last + 1).trim();
}

// JSON.parseを安全に
function safeJsonParse(jsonStr) {
  if (!jsonStr) return { ok: false, error: 'No JSON string' };
  try {
    return { ok: true, value: JSON.parse(jsonStr) };
  } catch (e) {
    return { ok: false, error: e?.message || 'JSON parse error' };
  }
}

// GASに送る（失敗してもthrowしない）
async function postToGAS(payload) {
  try {
    const r = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('GAS logging failed:', r.status, t);
    }
  } catch (e) {
    console.error('GAS logging exception:', e?.message || e);
  }
}

// Cloudinaryに画像をアップロード
async function uploadToCloudinary(base64Data) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not configured');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'photokara';

  const { createHash } = await import('crypto');
  const signStr = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash('sha1').update(signStr).digest('hex');

  const formData = new URLSearchParams();
  formData.append('file', `data:image/jpeg;base64,${base64Data}`);
  formData.append('api_key', apiKey);
  formData.append('timestamp', String(timestamp));
  formData.append('signature', signature);
  formData.append('folder', folder);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloudinary upload failed: ${err}`);
  }

  const data = await res.json();
  return data.secure_url;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt       = req.body?.prompt;
  const imageContents = req.body?.imageContents;
  const category     = req.body?.category;
  const platform     = req.body?.platform;
  const text         = req.body?.text;
  const roles        = req.body?.roles;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const validImages = Array.isArray(imageContents)
    ? imageContents.filter(
        (img) => img?.type === 'image' && img?.source?.type === 'base64' && typeof img?.source?.data === 'string' && img.source.data.length > 0
      )
    : [];

  const contentBlocks = [...validImages, { type: 'text', text: prompt }];

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1500,
        temperature: 0,
        system: 'Return ONLY valid JSON. No prose. No markdown. No code fences. Use double quotes. No trailing commas.',
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('Anthropic API error:', anthropicRes.status, errText);
      return res.status(500).json({
        error: `Anthropic API error: ${anthropicRes.status}`,
        detail: errText,
      });
    }

    const data = await anthropicRes.json();
    const rawText = Array.isArray(data?.content)
      ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      : '';

    const jsonCandidate = extractJsonCandidate(rawText);
    const parsedResult = safeJsonParse(jsonCandidate);

    if (!parsedResult.ok) {
      console.error('JSON parse failed:', parsedResult.error);
      console.error('rawText:', rawText);
      await postToGAS({
        category: category || '',
        platform: platform || '',
        text: text || '',
        error: 'JSON_PARSE_FAILED',
        detail: parsedResult.error,
        raw: rawText?.slice?.(0, 5000) || rawText,
      });
      return res.status(200).json({
        ok: false,
        error: 'JSON_PARSE_FAILED',
        detail: parsedResult.error,
        raw: rawText,
      });
    }

    const parsed = parsedResult.value;

    // Cloudinaryに画像をアップロード（失敗しても診断結果は返す）
    let imageUrls = [];
    try {
      imageUrls = await Promise.all(
        validImages.map((img) => uploadToCloudinary(img.source.data))
      );
    } catch (cloudErr) {
      console.error('Cloudinary upload failed:', cloudErr.message);
    }

    // GASに記録
    await postToGAS({
      category: category || '',
      platform: platform || '',
      roles: Array.isArray(roles) ? roles.join(' / ') : (roles || ''),
      text: text || '',
      overall: parsed?.overall ?? '',
      grade: parsed?.grade ?? '',
      axes: parsed?.axes ?? '',
      advice: parsed?.advice ?? '',
      summary: parsed?.summary ?? '',
      imageUrls: imageUrls.join('\n'),
      feedback: '',
      feedbackComment: '',
    });

    return res.status(200).json({
      ok: true,
      result: parsed,
      imageUrls,
    });

  } catch (err) {
    console.error('Handler error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Unknown error' });
  }
}
