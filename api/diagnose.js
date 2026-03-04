// pages/api/diagnose.js

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbx0aMZq54sK-iA8YHvs_3ERiGQXtz80X0NR45NgyFZhYekjzMnjJq1PpPKiQIiq2Jbe/exec';

export const config = {
  api: {
    bodyParser: { sizeLimit: '20mb' },
  },
};

// --- helper: 安全にJSON抽出する ---
function extractJsonCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  // 1) ```json ... ``` があればそれを優先
  const fence = rawText.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) return fence[1].trim();

  // 2) それ以外は「最初の { から最後の }」を切り出す（最低限）
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;

  return rawText.slice(first, last + 1).trim();
}

// --- helper: JSON.parseを安全に ---
function safeJsonParse(jsonStr) {
  if (!jsonStr) return { ok: false, error: 'No JSON string' };
  try {
    return { ok: true, value: JSON.parse(jsonStr) };
  } catch (e) {
    return { ok: false, error: e?.message || 'JSON parse error' };
  }
}

// --- helper: GASに送る（失敗してもthrowしない） ---
async function postToGAS(payload) {
  try {
    const r = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // GAS側がエラーでも落とさない（ログだけ）
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('GAS logging failed:', r.status, t);
    }
  } catch (e) {
    console.error('GAS logging exception:', e?.message || e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // req.bodyが壊れてても落ちないように守る
  const prompt = req.body?.prompt;
  const imageContents = req.body?.imageContents;
  const category = req.body?.category;
  const text = req.body?.text;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // 画像ブロックのバリデーション（Claude形式の image block を想定）
  const validImages = Array.isArray(imageContents)
    ? imageContents.filter(
        (img) => img && img.type === 'image' && img.source?.type === 'base64' && typeof img.source?.data === 'string' && img.source.data.length > 0
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
        // ここが重要：JSONだけ返すことを強制
        system:
          'Return ONLY valid JSON. No prose. No markdown. No code fences. Use double quotes. No trailing commas.',
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

    // Claudeの返答からテキストを連結
    const rawText = Array.isArray(data?.content)
      ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      : '';

    // JSON候補抽出
    const jsonCandidate = extractJsonCandidate(rawText);

    // パース（失敗しても落ちない）
    const parsedResult = safeJsonParse(jsonCandidate);

    if (!parsedResult.ok) {
      // パース失敗でも、原因解析できるように返す（落とさない）
      console.error('JSON parse failed:', parsedResult.error);
      console.error('rawText:', rawText);
      console.error('jsonCandidate:', jsonCandidate);

      // GASへも「失敗ログ」を送っておく（機能維持）
      await postToGAS({
        category: category || '',
        text: text || '',
        error: 'JSON_PARSE_FAILED',
        detail: parsedResult.error,
        raw: rawText?.slice?.(0, 5000) || rawText, // 長すぎるとGASが死ぬので上限
      });

      return res.status(200).json({
        ok: false,
        error: 'JSON_PARSE_FAILED',
        detail: parsedResult.error,
        raw: rawText,
      });
    }

    const parsed = parsedResult.value;

    // GASに記録（ここが落ちても診断は返す）
    await postToGAS({
      category: category || '',
      text: text || '',
      overall: parsed?.overall ?? '',
      grade: parsed?.grade ?? '',
      axes: parsed?.axes ?? '',
      advice: parsed?.advice ?? '',
      summary: parsed?.summary ?? '',
    });

    // フロントには「パース済みオブジェクト」を返す（扱いやすい）
    return res.status(200).json({
      ok: true,
      result: parsed,
      raw: rawText,
    });
  } catch (err) {
    console.error('Handler error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Unknown error' });
  }
}
