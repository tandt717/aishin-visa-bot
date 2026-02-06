export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    // クエリパラメータ
    const source = req.query.source || 'all';
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    let url = `${supabaseUrl}/rest/v1/news_articles?order=created_at.desc&limit=${limit}`;

    if (source !== 'all') {
      url += `&source=eq.${encodeURIComponent(source)}`;
    }

    const dbRes = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!dbRes.ok) {
      const errText = await dbRes.text();
      console.error('Supabase read error:', errText);
      return res.status(500).json({ error: 'Database read failed' });
    }

    const articles = await dbRes.json();

    // 件数カウント（全体）
    const countRes = await fetch(
      `${supabaseUrl}/rest/v1/news_articles?select=source`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      }
    );
    const totalCount = countRes.headers.get('content-range')?.split('/')[1] || '0';

    // 最終更新日時
    const latestRes = await fetch(
      `${supabaseUrl}/rest/v1/news_articles?select=created_at&order=created_at.desc&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );
    const latestData = await latestRes.json();
    const lastUpdated = latestData?.[0]?.created_at || null;

    const highCount = articles.filter((a) => a.relevance === 'high').length;
    const summary =
      articles.length > 0
        ? `${totalCount}件の記事を蓄積中（表示: ${articles.length}件、重要: ${highCount}件）`
        : 'まだニュースが取得されていません。「ニュース取得」ボタンを押してください。';

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({
      articles,
      summary,
      totalCount: parseInt(totalCount),
      lastUpdated,
    });
  } catch (err) {
    console.error('News API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
