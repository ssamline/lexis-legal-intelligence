const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const TOPIC_QUERIES = {
  ip:   'intellectual property patent copyright trademark technology law',
  reg:  'regulatory compliance enforcement agency law government',
  lit:  'litigation lawsuit court ruling verdict legal',
  corp: 'corporate merger acquisition deal business law',
};

function parseRssItems(xml, topic, maxItems = 4) {
  const out = [];
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, maxItems);
  for (const [, item] of items) {
    const title = (item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/ - [^-]{2,40}$/, '')   // strip "- Publisher Name" suffix
      .replace(/["\\\t\r\n]/g, ' ').replace(/\s{2,}/g,' ').trim();
    const link = (item.match(/<link>(https?:\/\/[^\s<]+)/)?.[1] ||
                  item.match(/<guid[^>]*>(https?:\/\/[^\s<]+)<\/guid>/)?.[1] || '').trim();
    const domain = (item.match(/<source[^>]+url=["'](https?:\/\/[^"'/]+)/)?.[1] || '').replace(/^https?:\/\//,'');
    if (title && link) out.push({ topic, title, link, domain });
  }
  return out;
}

async function fetchNewsArticles(topics, keywords, sourceDomains) {
  const results = [];
  const seen    = new Set();
  const domains = sourceDomains && sourceDomains.length ? sourceDomains : [''];

  for (const topic of topics) {
    const base  = TOPIC_QUERIES[topic] || topic + ' law';
    const extra = keywords.slice(0, 2).join(' ');

    for (const domain of domains) {
      const siteFilter = domain ? ` site:${domain}` : '';
      const q = encodeURIComponent(`${base} ${extra}${siteFilter}`.trim());
      try {
        const rss = await fetch(
          `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LexBrief/1.0)' }, signal: AbortSignal.timeout(7000) }
        );
        if (!rss.ok) continue;
        const xml = await rss.text();
        for (const a of parseRssItems(xml, topic, 3)) {
          if (!seen.has(a.link)) { seen.add(a.link); results.push(a); }
        }
      } catch (e) {
        console.error('RSS fetch error:', topic, domain, e.message);
      }
    }
  }
  return results;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keySet: !!process.env.ANTHROPIC_API_KEY });
});

app.post('/api/fetch-article', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow'
    });

    const html     = await response.text();
    const finalUrl = response.url;

    const clean = s => s
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
      .replace(/\s{2,}/g,' ').trim();

    const title = clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const desc  = html.match(/<meta[^>]+(?:name=["']description["']|property=["']og:description["'])[^>]+content=["']([\s\S]*?)["']/i)?.[1]?.trim() || '';

    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => clean(m[1]))
      .filter(p => p.length > 80 && p.length < 2000);

    res.json({ title, desc, paragraphs: paragraphs.slice(0, 30), finalUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/search-news', async (req, res) => {
  const { topics = [], keywords = [], urls = [] } = req.body;
  try {
    const articles = await fetchNewsArticles(topics, keywords, urls);
    res.json({ articles });
  } catch (e) {
    res.json({ articles: [] });
  }
});

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set on server.' } });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
