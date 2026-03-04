// pages/api/diagnose.js

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbx0aMZq54sK-iA8YHvs_3ERiGQXtz80X0NR45NgyFZhYekjzMnjJq1PpPKiQIiq2Jbe/exec';

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

/** GASへ送信（失敗してもthrowしない） */
async function postToGAS(payload) {
  try {
    const r = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[GAS] failed:', r.status, t);
    }
  } catch (e) {
    console.error('[GAS] exception:', e?.message || e);
  }
}

/** Cloudinaryアップロード（base64 -> secure_url） */
async function uploadToCloudinary(base64Data, index = 0) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      `Cloudinary env vars not configured: ` +
        `CLOUDINARY_CLOUD_NAME=${!!cloudName}, ` +
        `CLOUDINARY_API_KEY=${!!apiKey}, ` +
        `CLOUDINARY_API_SECRET=${!!apiSecret}`
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'photokara';

  const { createHash } = await import('crypto');
  const signStr = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash('sha1').update(signStr).digest('hex');

  const form = new FormData();
  form.append('file', `data:image/jpeg;base64,${base64Data}`);
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', `diag_${Date.now()}_${index}`);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Cloudinary upload failed: ${res.status} ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Cloudinary response not JSON: ${text}`);
  }

  if (!data?.secure_url) {
    throw new Error(`Cloudinary response missing secure_url: ${text}`);
  }

  return data.secure_url;
}

/** tool_useの出力を最低限正規化 */
function normalizeDiagnosis(input) {
  const out = {
    overall: typeof input?.overall === 'number' ? input.overall : Number(input?.overall ?? 0),
    grade: typeof input?.grade === 'string' ? input.grade : 'B',
    summary: typeof input?.summary === 'string' ? input.summary : '',
    axes: Array.isArray(input?.axes) ? input.axes : [],
    advice: Array.isArray(input?.advice) ? input.advice : [],
    advice_detail: Array.isArray(input?.advice_detail) ? input.advice_detail : [],
  };

  if (!['S', 'A', 'B', 'C'].includes(out.grade)) out.grade = 'B';
  out.overall = Math.max(0, Math.min(100, out.overall));

  out.axes = out.axes
    .filter(Boolean)
    .map((ax) => ({
      name: typeof ax?.name === 'string' ? ax.name : '',
      score: typeof ax?.score === 'number' ? ax.score : Number(ax?.score ?? 0),
      comment: typeof ax?.comment === 'string' ? ax.comment : '',
    }))
    .map((ax) => ({ ...ax, score: Math.max(0, Math.min(100, ax.score)) }));

  out.advice = out.advice.map((s) => (typeof s === 'string' ? s : String(s)));
  out.advice_detail = out.advice_detail.map((s) => (typeof s === 'string' ? s : String(s)));

  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // 必須：Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  // 受け取り（フロントが送っていない場合は空でOK）
  const prompt = req.body?.prompt;
  const category = req.body?.category || '';
  const text = req.body?.text || '';
  const platform = req.body?.platform || ''; // ★列ズレ防止用に必ず送る
  const roles = req.body?.roles || [];       // ★列ズレ防止用に必ず送る（配列でも文字列でもOK）
  const imageContents = req.body?.imageContents;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'prompt is required' });
  }

  // 画像ブロック（Claude形式）をバリデーション
  const validImages = Array.isArray(imageContents)
    ? imageContents.filter(
        (img) =>
          img?.type === 'image' &&
          img?.source?.type === 'base64' &&
          typeof img?.source?.data === 'string' &&
          img.source.data.length > 0
      )
    : [];

  const contentBlocks = [...validImages, { type: 'text', text: prompt }];

  // ✅ Claude：tool_useで構造化出力（JSON.parse不要）
  const tools = [
    {
      name: 'emit_diagnosis',
      description: 'Return diagnosis result as structured data.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['overall', 'grade', 'summary', 'axes', 'advice', 'advice_detail'],
        properties: {
          overall: { type: 'number' },
          grade: { type: 'string', enum: ['S', 'A', 'B', 'C'] },
          summary: { type: 'string' },
          axes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'score', 'comment'],
              properties: {
                name: { type: 'string' },
                score: { type: 'number' },
                comment: { type: 'string' },
              },
            },
          },
          advice: { type: 'array', items: { type: 'string' }, minItems: 1 },
          advice_detail: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  ];

  let diagnosis = null;
  let claudeRaw = '';

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1500,
        temperature: 0,
        tools,
        tool_choice: { type: 'tool', name: 'emit_diagnosis' },
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error('[Claude] API error:', anthropicRes.status, errText);

      await postToGAS({
        category,
        platform,
        roles,
        text,
        error: 'CLAUDE_API_ERROR',
        claudeStatus: anthropicRes.status,
        claudeDetail: errText.slice(0, 5000),
      });

      return res.status(500).json({
        ok: false,
        error: `Anthropic API error: ${anthropicRes.status}`,
        detail: errText,
      });
    }

    const data = await anthropicRes.json();

    claudeRaw = Array.isArray(data?.content)
      ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      : '';

    const toolBlock = Array.isArray(data?.content)
      ? data.content.find((b) => b?.type === 'tool_use' && b?.name === 'emit_diagnosis')
      : null;

    if (!toolBlock?.input) {
      console.error('[Claude] tool_use missing:', JSON.stringify(data?.content || []).slice(0, 2000));

      await postToGAS({
        category,
        platform,
        roles,
        text,
        error: 'TOOL_USE_MISSING',
        claudeRaw: claudeRaw.slice(0, 5000),
      });

      return res.status(500).json({
        ok: false,
        error: 'Tool output missing',
        raw: claudeRaw,
      });
    }

    diagnosis = normalizeDiagnosis(toolBlock.input);
  } catch (e) {
    console.error('[Handler] Claude exception:', e?.message || e);

    await postToGAS({
      category,
      platform,
      roles,
      text,
      error: 'CLAUDE_EXCEPTION',
      detail: (e?.message || String(e)).slice(0, 5000),
    });

    return res.status(500).json({ ok: false, error: e?.message || 'Unknown error' });
  }

  // ✅ Cloudinary：失敗しても診断結果は返す
  let imageUrls = [];
  let cloudinaryError = '';
  if (validImages.length > 0) {
    try {
      imageUrls = await Promise.all(
        validImages.map((img, i) => uploadToCloudinary(img.source.data, i))
      );
    } catch (e) {
      cloudinaryError = e?.message || String(e);
      console.error('[Cloudinary] upload failed:', cloudinaryError);
    }
  }

  // ✅ GASへ送る（列ズレしない形：キー固定）
  await postToGAS({
    category,
    platform,
    roles,
    text,
    overall: diagnosis.overall,
    grade: diagnosis.grade,
    axes: diagnosis.axes,
    advice: diagnosis.advice,
    advice_detail: diagnosis.advice_detail,
    summary: diagnosis.summary,
    imageUrls, // ←配列のままでOK（GAS側で \n 連結して「画像URL」列へ）
    cloudinaryError,
  });

  // ✅ フロントへ返す（UIの見た目は自由に整形できる）
  return res.status(200).json({
    ok: true,
    result: diagnosis,
    imageUrls,
    cloudinaryError,
  });
}
