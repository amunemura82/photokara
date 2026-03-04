// pages/api/diagnose.js

// ✅ あなたのGAS URL（必要なら差し替え）
const GAS_URL =
  'https://script.google.com/macros/s/AKfycbx0aMZq54sK-iA8YHvs_3ERiGQXtz80X0NR45NgyFZhYekjzMnjJq1PpPKiQIiq2Jbe/exec';

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

/**
 * GASに送信（失敗してもthrowしない）
 */
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

/**
 * Cloudinaryにbase64画像をアップロードして secure_url を返す
 * 失敗時は throw（呼び出し元で握りつぶす）
 */
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

  // 署名対象：folder と timestamp（formに同じパラメータを必ず入れる）
  const signStr = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash('sha1').update(signStr).digest('hex');

  // FormDataで送る（base64が大きくても安定）
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

/**
 * Claude(tool_use)の出力を正規化
 */
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const prompt = req.body?.prompt;
  const imageContents = req.body?.imageContents;
  const category = req.body?.category || '';
  const text = req.body?.text || '';

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
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

  // Claudeへ送る content
  const contentBlocks = [
    ...validImages,
    { type: 'text', text: prompt },
  ];

  // ✅ tool定義：JSON文字列ではなく構造化データで返す（JSON.parse不要）
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

  // ✅ まずは Claude 診断
  let diagnosis = null;
  let claudeRaw = '';
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

    // 参考用：textブロックがあれば raw も残す（UI確認に便利）
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
      text,
      error: 'CLAUDE_EXCEPTION',
      detail: (e?.message || String(e)).slice(0, 5000),
    });

    return res.status(500).json({ ok: false, error: e?.message || 'Unknown error' });
  }

  // ✅ 次に Cloudinary アップロード（失敗しても診断結果は返す）
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

  // ✅ GASへ記録（失敗しても診断結果は返す）
  await postToGAS({
    category,
    text,
    overall: diagnosis.overall,
    grade: diagnosis.grade,
    axes: diagnosis.axes,
    advice: diagnosis.advice,
    summary: diagnosis.summary,
    advice_detail: diagnosis.advice_detail,
    imageUrls: imageUrls.join('\n'),       // ←シートに入れたいURL
    cloudinaryError,                       // ←失敗理由をシートに残せる（列があれば）
    claudeRaw: claudeRaw.slice(0, 2000),   // ←必要なら（列があれば）
  });

  // ✅ フロントへ返す（見た目はindex.html側で自由に整形できる）
  return res.status(200).json({
    ok: true,
    result: diagnosis,
    imageUrls,
    cloudinaryError,
  });
}
