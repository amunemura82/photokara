const GAS_URL = 'https://script.google.com/macros/s/AKfycbx0aMZq54sK-iA8YHvs_3ERiGQXtz80X0NR45NgyFZhYekjzMnjJq1PpPKiQIiq2Jbe/exec';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

// Cloudinaryに画像をアップロードしてURLを返す
async function uploadToCloudinary(base64Data, index) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'photokara';

  // 署名生成
  const crypto = await import('crypto');
  const signStr = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(signStr).digest('hex');

  const formData = new URLSearchParams();
  formData.append('file', `data:image/jpeg;base64,${base64Data}`);
  formData.append('api_key', apiKey);
  formData.append('timestamp', timestamp);
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, imageContents, category, text, platform, roles } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // 画像バリデーション
  const validImages = (imageContents || []).filter(img =>
    img && img.source && img.source.data && img.source.data.length > 0
  );

  const contentBlocks = [
    ...validImages,
    { type: 'text', text: prompt }
  ];

  try {
    // Anthropic API呼び出し
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errText);
      return res.status(500).json({ error: `Anthropic API error: ${anthropicRes.status}`, detail: errText });
    }

    const data = await anthropicRes.json();
    const rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(500).json({ error: 'Invalid response format', raw: rawText });
    }

    const parsed = JSON.parse(match[0]);

    // Cloudinaryに画像をアップロード（非同期・失敗しても診断結果は返す）
    let imageUrls = [];
    try {
      imageUrls = await Promise.all(
        validImages.map((img, i) => uploadToCloudinary(img.source.data, i))
      );
    } catch (cloudErr) {
      console.error('Cloudinary upload failed:', cloudErr.message);
    }

    // Googleスプレッドシートに記録
    try {
      await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: category || '',
          platform: platform || '',
          roles: (roles || []).join(' / '),
          text: text || '',
          overall: parsed.overall,
          grade: parsed.grade,
          axes: parsed.axes,
          advice: parsed.advice,
          summary: parsed.summary,
          imageUrls: imageUrls.join('\n'),
          feedback: '',
          feedbackComment: ''
        })
      });
    } catch (gasErr) {
      console.error('GAS logging failed:', gasErr.message);
    }

    return res.status(200).json({
      result: match[0],
      imageUrls
    });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
