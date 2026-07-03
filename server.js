const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// Common RSS/Atom feed paths to try for any domain
const RSS_PATHS = [
  '/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml',
  '/feed/rss', '/rss/feed', '/news/feed', '/feed/news',
  '/?feed=rss2', '/index.xml', '/feeds/posts/default',
  '/blog/feed', '/articles/feed', '/legal-news/feed'
];

function decodeEntities(s) {
  return s
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ');
}

function parseXmlItems(xml, sourceDomain, maxItems = 8) {
  const out = [];
  // Support both RSS <item> and Atom <entry>
  const matches = [...xml.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g)];
  for (const [, block] of matches.slice(0, maxItems)) {
    const rawTitle = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '');
    const title = decodeEntities(rawTitle)
      .replace(/["\\\t\r\n]/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // RSS <link> text node OR Atom <link href="..."/>
    const link = (
      block.match(/<link>(https?:\/\/[^\s<]+)/)?.[1] ||
      block.match(/<link[^>]+href=["'](https?:\/\/[^"']+)["']/)?.[1] ||
      block.match(/<guid[^>]+isPermaLink=["']true["'][^>]*>(https?:\/\/[^\s<]+)<\/guid>/)?.[1] ||
      block.match(/<guid[^>]*>(https?:\/\/[^\s<]+)<\/guid>/)?.[1] ||
      ''
    ).trim();

    if (title && link) out.push({ title, link, domain: sourceDomain });
  }
  return out;
}

async function fetchSiteArticles(domain) {
  const base = /^https?:\/\//.test(domain)
    ? domain.replace(/\/$/, '')
    : `https://${domain}`;

  for (const feedPath of RSS_PATHS) {
    try {
      const res = await fetch(base + feedPath, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LexBrief/1.0)',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
        },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow'
      });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('html') && !ct.includes('xml')) continue; // skip HTML pages
      const xml = await res.text();
      if (!xml.includes('<item>') && !xml.includes('<entry>')) continue;
      const items = parseXmlItems(xml, domain, 8);
      if (items.length) {
        console.log(`[RSS] ${domain}${feedPath} → ${items.length} articles`);
        return items;
      }
    } catch { /* try next path */ }
  }
  console.warn(`[RSS] No feed found for ${domain}`);
  return [];
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keySet: !!process.env.ANTHROPIC_API_KEY });
});

// Fetch articles directly from user-selected source domains
app.post('/api/search-news', async (req, res) => {
  const { urls = [] } = req.body;
  if (!urls.length) return res.json({ articles: [] });

  try {
    const results = await Promise.all(urls.map(domain => fetchSiteArticles(domain)));
    const articles = results.flat();
    res.json({ articles });
  } catch (e) {
    res.json({ articles: [] });
  }
});

// Fetch and extract full article content for the reader modal
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

    const strip = s => s
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
      .replace(/\s{2,}/g,' ').trim();

    const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const desc  = html.match(/<meta[^>]+(?:name=["']description["']|property=["']og:description["'])[^>]+content=["']([\s\S]*?)["']/i)?.[1]?.trim() || '';
    const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => strip(m[1]))
      .filter(p => p.length > 80 && p.length < 2000);

    res.json({ title, desc, paragraphs: paragraphs.slice(0, 30), finalUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function searchCourtListener(query) {
  try {
    const q   = encodeURIComponent(query);
    const res = await fetch(
      `https://www.courtlistener.com/api/rest/v4/search/?q=${q}&type=o&order_by=score+desc`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'LexBrief/1.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0, 5).map(r => ({
      title:   r.caseName   || r.case_name   || 'Unnamed Case',
      court:   r.court      || r.court_id    || '',
      date:    r.dateFiled  || r.date_filed  || '',
      url:     `https://www.courtlistener.com${r.absolute_url || '/'}`,
      snippet: (r.snippet   || '').replace(/<[^>]+>/g, '').slice(0, 300),
      type:    'case',
      source:  'CourtListener'
    }));
  } catch(e) {
    console.error('CourtListener error:', e.message);
    return [];
  }
}

// Search stories: user feeds + CourtListener
app.post('/api/research-search', async (req, res) => {
  const { query = '', urls = [] } = req.body;
  if (!query.trim()) return res.json({ results: [] });

  const q = query.toLowerCase();

  // Search user feeds by keyword match in title
  const feedResults = [];
  for (const domain of urls) {
    const articles = await fetchSiteArticles(domain);
    const matches  = articles.filter(a => a.title.toLowerCase().includes(q));
    feedResults.push(...matches.map(a => ({ title: a.title, url: a.link, source: a.domain, domain: a.domain, type: 'news' })));
  }

  const caseResults = await searchCourtListener(query);
  res.json({ results: [...feedResults, ...caseResults] });
});

// Legal Q&A context: CourtListener + user feeds keyword match
app.post('/api/legal-search', async (req, res) => {
  const { query = '', urls = [] } = req.body;
  const [cases, ...feedArrays] = await Promise.all([
    searchCourtListener(query),
    ...urls.map(async domain => {
      const articles = await fetchSiteArticles(domain);
      const q = query.toLowerCase();
      return articles.filter(a => a.title.toLowerCase().split(' ').some(w => w.length > 4 && q.includes(w)));
    })
  ]);
  const articles = feedArrays.flat().slice(0, 5);
  res.json({ cases, articles });
});

// Discover the latest version hash for MusicGen on Replicate
async function getMusicGenVersion(replicateKey) {
  const candidates = ['meta/musicgen', 'facebook/musicgen'];
  for (const model of candidates) {
    try {
      const r = await fetch(`https://api.replicate.com/v1/models/${model}/versions`, {
        headers: { 'Authorization': `Bearer ${replicateKey}` },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const d = await r.json();
      const v = d.results?.[0]?.id;
      if (v) { console.log(`[Replicate] Using ${model} @ ${v}`); return v; }
    } catch {}
  }
  return null;
}

// Song generation: Claude writes lyrics → Replicate MusicGen composes
app.post('/api/song-start', async (req, res) => {
  const replicateKey = process.env.REPLICATE_API_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!replicateKey) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured in Render environment variables.' });

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided.' });

  // Step 1: Generate song lyrics with Claude
  let lyrics = text.slice(0, 300);
  if (anthropicKey) {
    try {
      const lyricRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 180,
          system: 'You are a creative songwriter. Given a legal news briefing, write 4-6 short punchy rhyming song lyrics capturing the key legal developments. Professional but catchy. Output ONLY the lyrics — no titles, no labels, no extra text.',
          messages: [{ role: 'user', content: text.slice(0, 800) }]
        }),
        signal: AbortSignal.timeout(15000)
      });
      if (lyricRes.ok) {
        const ld = await lyricRes.json();
        lyrics = ld.content?.[0]?.text?.trim() || lyrics;
      }
    } catch {}
  }

  // Step 2: Discover latest MusicGen version on Replicate
  const version = await getMusicGenVersion(replicateKey);
  if (!version) {
    return res.status(404).json({ error: 'MusicGen model not found on your Replicate account. Visit replicate.com and ensure your token has access.' });
  }

  // Step 3: Create prediction using standard predictions endpoint + version hash
  const musicPrompt = `upbeat professional news podcast song, major key, clear sung vocals, energetic and concise. Lyrics: ${lyrics}`;
  try {
    const predRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${replicateKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version,
        input: { prompt: musicPrompt, duration: 30, output_format: 'mp3' }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!predRes.ok) {
      const err = await predRes.json().catch(() => ({}));
      return res.status(predRes.status).json({ error: err.detail || JSON.stringify(err) });
    }
    const pred = await predRes.json();
    res.json({ id: pred.id, status: pred.status, lyrics });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/song-status/:id', async (req, res) => {
  const replicateKey = process.env.REPLICATE_API_TOKEN;
  if (!replicateKey) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured.' });
  try {
    const r    = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${replicateKey}` },
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    const url  = Array.isArray(data.output) ? data.output[0] : (data.output || null);
    res.json({ status: data.status, url, error: data.error });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tts', async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured in Render environment variables.' });

  const { text, voice = 'nova' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided.' });

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: text.slice(0, 4096), voice, response_format: 'mp3' }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'TTS request failed.' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set on server.' } });

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
