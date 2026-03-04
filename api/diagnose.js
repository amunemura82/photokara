const GAS_URL = 'https://script.google.com/macros/s/AKfycbx0aMZq54sK-iA8YHvs_3ERiGQXtz80X0NR45NgyFZhYekjzMnjJq1PpPKiQIiq2Jbe/exec';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, imageContents, category, text } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const contentBlocks = [
    ...(imageContents || []),
    { type: 'text', text: prompt }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [
          { role: 'user', content: contentBlocks }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: err });
    }

    const data = await response.json();
    const rawText = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(500).json({ error: 'Invalid response format', raw: rawText });
    }

    const parsed = JSON.parse(match[0]);

    // Googleスプレッドシートに記録（失敗しても診断結果は返す）
    try {
      await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: category || '',
          text: text || '',
          overall: parsed.overall,
          grade: parsed.grade,
          axes: parsed.axes,
          advice: parsed.advice,
          summary: parsed.summary
        })
      });
    } catch (gasErr) {
      console.error('GAS logging failed:', gasErr.message);
    }

    return res.status(200).json({ result: match[0] });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
