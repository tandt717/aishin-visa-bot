export default async function handler(req, res) {
  // CRONまたは手動トリガー（POST）を許可
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    if (req.method !== 'POST') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!apiKey || !supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Missing configuration' });
  }

  try {
    const [mhlwItems, isaItems, mojItems] = await Promise.all([
      fetchMHLW(),
      fetchISA(),
      fetchMOJ(),
    ]);

    const allItems = [...mhlwItems, ...isaItems, ...mojItems];

    if (allItems.length === 0) {
      return res.status(200).json({ message: 'No items fetched', fetched: 0, stored: 0 });
    }

    // Geminiで関連記事をフィルタリング
    const filtered = await filterWithGemini(apiKey, allItems);

    // Supabaseに保存
    const stored = await storeInSupabase(supabaseUrl, supabaseKey, filtered);

    return res.status(200).json({
      message: 'News fetched and stored',
      fetched: allItems.length,
      filtered: filtered.length,
      stored,
    });
  } catch (err) {
    console.error('Fetch news error:', err);
    return res.status(500).json({ error: 'Failed to fetch news' });
  }
}

// ===== 厚生労働省 RSS =====
async function fetchMHLW() {
  try {
    const res = await fetch('https://www.mhlw.go.jp/stf/news.rdf', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSS(xml, '厚生労働省');
  } catch {
    return [];
  }
}

// ===== 出入国在留管理庁 =====
async function fetchISA() {
  try {
    const res = await fetch('https://www.moj.go.jp/isa/news/index.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseISAPage(html);
  } catch {
    return [];
  }
}

// ===== 法務省 =====
async function fetchMOJ() {
  try {
    const res = await fetch('https://www.moj.go.jp/hisho/kouhou/press_index.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseMOJPage(html);
  } catch {
    return [];
  }
}

// ===== RSS Parser =====
function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  let count = 0;
  while ((match = itemRegex.exec(xml)) !== null && count < 30) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const date = extractTag(block, 'dc:date') || extractTag(block, 'pubDate');
    if (title) {
      items.push({ title, link, publish_date: formatDate(date), source });
      count++;
    }
  }
  return items;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.+?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

// ===== HTML Parsers =====
function parseISAPage(html) {
  const items = [];
  const linkRegex = /<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let count = 0;
  while ((match = linkRegex.exec(html)) !== null && count < 30) {
    let title = match[2].replace(/<[^>]+>/g, '').trim();
    let href = match[1];
    if (!title || title.length < 8 || title.length > 200) continue;
    const dateMatch = html.substring(Math.max(0, match.index - 150), match.index + 10)
      .match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/);
    const publish_date = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : '';
    if (href.startsWith('/')) href = 'https://www.moj.go.jp' + href;
    if (href.includes('/isa/') && !href.endsWith('index.html')) {
      items.push({ title, link: href, publish_date, source: '出入国在留管理庁' });
      count++;
    }
  }
  return items;
}

function parseMOJPage(html) {
  const items = [];
  const linkRegex = /<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let count = 0;
  while ((match = linkRegex.exec(html)) !== null && count < 30) {
    let title = match[2].replace(/<[^>]+>/g, '').trim();
    let href = match[1];
    if (!title || title.length < 8 || title.length > 200) continue;
    const dateMatch = html.substring(Math.max(0, match.index - 150), match.index + 10)
      .match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/);
    const publish_date = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
      : '';
    if (href.startsWith('/')) href = 'https://www.moj.go.jp' + href;
    if (!href.endsWith('index.html') && (href.includes('/hisho/') || href.includes('/nyuukokukanri/'))) {
      items.push({ title, link: href, publish_date, source: '法務省' });
      count++;
    }
  }
  return items;
}

// ===== Gemini フィルタリング =====
async function filterWithGemini(apiKey, items) {
  const itemList = items.map((item, i) => `${i}: [${item.source}] ${item.title}`).join('\n');

  const prompt = `以下は日本の政府機関の最新ニュース一覧です。

${itemList}

あなたは製造業で外国人労働者を雇用している企業の人事担当者をサポートしています。
上記のニュースから、以下のいずれかに該当する記事を最大15件選んでください：

1. 在留資格・ビザに関する制度変更や新制度
2. 外国人雇用・労働に関する法改正や通達
3. 特定技能・技能実習（育成就労）に関する情報
4. 入管法改正に関する情報
5. 製造業に影響する労働法規の変更
6. 外国人労働者の社会保険・労災に関する情報
7. 技能検定・日本語試験に関する情報

選んだ各記事について以下のJSON形式で出力してください。JSON配列のみを出力し、他のテキストは含めないでください：
[
  {
    "index": 記事番号,
    "summary": "この記事が製造業の人事にどう影響するか1-2文で要約",
    "relevance": "high" または "medium",
    "category": "在留資格" | "労働法規" | "特定技能" | "技能実習" | "入管法" | "社会保険" | "その他"
  }
]

該当する記事がない場合は空配列 [] を返してください。`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 },
        }),
      }
    );

    if (!res.ok) {
      // フィルタリング失敗時は全件返す（要約なし）
      return items.slice(0, 20).map(item => ({
        ...item,
        summary: null,
        relevance: 'medium',
        category: 'その他',
      }));
    }

    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return items.slice(0, 20).map(item => ({
        ...item,
        summary: null,
        relevance: 'medium',
        category: 'その他',
      }));
    }

    const selected = JSON.parse(jsonMatch[0]);
    return selected
      .map((sel) => ({
        ...items[sel.index],
        summary: sel.summary,
        relevance: sel.relevance,
        category: sel.category,
      }))
      .filter((a) => a && a.title);
  } catch {
    return items.slice(0, 20).map(item => ({
      ...item,
      summary: null,
      relevance: 'medium',
      category: 'その他',
    }));
  }
}

// ===== Supabase 保存 =====
async function storeInSupabase(supabaseUrl, supabaseKey, articles) {
  if (!articles || articles.length === 0) return 0;

  const rows = articles.map((a) => ({
    title: a.title,
    link: a.link || null,
    publish_date: a.publish_date || null,
    source: a.source,
    summary: a.summary || null,
    relevance: a.relevance || 'medium',
    category: a.category || 'その他',
  }));

  const res = await fetch(`${supabaseUrl}/rest/v1/news_articles`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Supabase insert error:', errText);
    return 0;
  }

  return rows.length;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return dateStr;
  }
}
