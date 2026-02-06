export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    // 並列で各省庁のニュースを取得
    const [mhlwItems, isaItems, mojItems] = await Promise.all([
      fetchMHLW(),
      fetchISA(),
      fetchMOJ(),
    ]);

    const allItems = [...mhlwItems, ...isaItems, ...mojItems];

    if (allItems.length === 0) {
      return res.status(200).json({ articles: [], summary: 'ニュースを取得できませんでした。' });
    }

    // Geminiで製造業・外国人雇用に関連する記事をフィルタリング＆要約
    const filtered = await filterWithGemini(apiKey, allItems);

    // キャッシュヘッダー（10分間キャッシュ）
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
    return res.status(200).json(filtered);
  } catch (err) {
    console.error('News API error:', err);
    return res.status(500).json({ error: 'ニュースの取得に失敗しました' });
  }
}

// ===== 厚生労働省 RSS =====
async function fetchMHLW() {
  try {
    const res = await fetch('https://www.mhlw.go.jp/stf/news.rdf', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
      signal: AbortSignal.timeout(8000),
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
      signal: AbortSignal.timeout(8000),
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseMOJPage(html);
  } catch {
    return [];
  }
}

// ===== RSS Parser (簡易XML解析) =====
function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  let count = 0;
  while ((match = itemRegex.exec(xml)) !== null && count < 20) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const date = extractTag(block, 'dc:date') || extractTag(block, 'pubDate');
    if (title) {
      items.push({ title, link, date: formatDate(date), source });
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

// ===== HTML Parser (出入国在留管理庁) =====
function parseISAPage(html) {
  const items = [];
  // ニュース一覧のリンクを抽出
  const linkRegex = /<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let count = 0;
  while ((match = linkRegex.exec(html)) !== null && count < 20) {
    let title = match[2].replace(/<[^>]+>/g, '').trim();
    let href = match[1];
    if (!title || title.length < 5 || title.length > 200) continue;
    // 日付パターンを検出
    const dateMatch = html.substring(Math.max(0, match.index - 100), match.index).match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}` : '';
    if (href.startsWith('/')) href = 'https://www.moj.go.jp' + href;
    // ナビゲーション等を除外
    if (href.includes('/isa/') && !href.includes('index.html')) {
      items.push({ title, link: href, date, source: '出入国在留管理庁' });
      count++;
    }
  }
  return items;
}

// ===== HTML Parser (法務省) =====
function parseMOJPage(html) {
  const items = [];
  const linkRegex = /<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  let count = 0;
  while ((match = linkRegex.exec(html)) !== null && count < 20) {
    let title = match[2].replace(/<[^>]+>/g, '').trim();
    let href = match[1];
    if (!title || title.length < 5 || title.length > 200) continue;
    const dateMatch = html.substring(Math.max(0, match.index - 100), match.index).match(/(\d{4})[年\/\-](\d{1,2})[月\/\-](\d{1,2})/);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}` : '';
    if (href.startsWith('/')) href = 'https://www.moj.go.jp' + href;
    if (!href.includes('index.html') && (href.includes('/hisho/') || href.includes('/nyuukokukanri/'))) {
      items.push({ title, link: href, date, source: '法務省' });
      count++;
    }
  }
  return items;
}

// ===== Gemini フィルタリング =====
async function filterWithGemini(apiKey, items) {
  const itemList = items.map((item, i) => `${i}: [${item.source}] ${item.title}`).join('\n');

  const prompt = `以下は日本の政府機関（出入国在留管理庁・厚生労働省・法務省）の最新ニュース一覧です。

${itemList}

あなたは製造業で外国人労働者を雇用している企業の人事担当者をサポートしています。
上記のニュースから、以下のいずれかに該当する記事を最大10件選んでください：

1. 在留資格・ビザに関する制度変更や新制度
2. 外国人雇用・労働に関する法改正や通達
3. 特定技能・技能実習（育成就労）に関する情報
4. 入管法改正に関する情報
5. 製造業に影響する労働法規の変更

選んだ各記事について以下のJSON形式で出力してください。JSON配列のみを出力し、他のテキストは含めないでください：
[
  {
    "index": 記事番号,
    "summary": "この記事が製造業の人事にどう影響するか1-2文で要約",
    "relevance": "high" または "medium",
    "category": "在留資格" | "労働法規" | "特定技能" | "技能実習" | "入管法" | "その他"
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
          generationConfig: { temperature: 0.1 }
        }),
      }
    );

    if (!res.ok) {
      // Geminiフィルタリング失敗時は全件返す
      return { articles: items.slice(0, 15), summary: '※ AI要約は現在利用できません', filtered: false };
    }

    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

    // JSONを抽出
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { articles: items.slice(0, 15), summary: '関連ニュースのフィルタリング中にエラーが発生しました', filtered: false };
    }

    const selected = JSON.parse(jsonMatch[0]);
    const articles = selected.map(sel => ({
      ...items[sel.index],
      summary: sel.summary,
      relevance: sel.relevance,
      category: sel.category,
    })).filter(a => a && a.title);

    const highCount = articles.filter(a => a.relevance === 'high').length;
    const summary = articles.length > 0
      ? `${articles.length}件の関連ニュースが見つかりました（重要: ${highCount}件）`
      : '現在、製造業の外国人雇用に直接関連するニュースはありません';

    return { articles, summary, filtered: true };
  } catch {
    return { articles: items.slice(0, 15), summary: '※ AI要約は現在利用できません', filtered: false };
  }
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
