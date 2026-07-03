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

// ── Suno API song generation ──────────────────────────────────────────────────
// Step 1: generate lyrics with Claude, kick off Suno job, return { id }
app.post('/api/song-start', async (req, res) => {
  const sunoKey     = process.env.SUNO_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!sunoKey) return res.status(500).json({ error: 'SUNO_API_KEY not set in Render environment variables.' });

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided.' });

  // Write lyrics with Claude
  let lyrics = text.slice(0, 300);
  let style  = 'upbeat energetic pop, professional news';
  if (anthropicKey) {
    try {
      const lr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 250,
          system: 'You are a creative songwriter. Given a legal news briefing write freestyle song lyrics (5-6 punchy rhyming lines) and a music style. Respond ONLY as JSON: {"lyrics":"line1\\nline2\\nline3\\nline4\\nline5","style":"2-5 word genre/mood"}',
          messages: [{ role: 'user', content: text.slice(0, 700) }]
        }),
        signal: AbortSignal.timeout(12000)
      });
      if (lr.ok) {
        const d = await lr.json();
        const raw = d.content?.[0]?.text?.trim() || '';
        try { const m = raw.match(/\{[\s\S]*?\}/); if (m) { const p = JSON.parse(m[0]); if (p.lyrics) lyrics = p.lyrics; if (p.style) style = p.style; } } catch {}
      }
    } catch {}
  }

  // Submit to Suno
  try {
    const sunoRes = await fetch('https://api.suno.ai/v1/generate', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sunoKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: lyrics, tags: style, title: 'LexBrief Daily Song', make_instrumental: false, wait_audio: false }),
      signal: AbortSignal.timeout(30000)
    });
    if (!sunoRes.ok) {
      const err = await sunoRes.json().catch(() => ({}));
      return res.status(sunoRes.status).json({ error: err.detail || err.message || err.error || `Suno ${sunoRes.status}` });
    }
    const data = await sunoRes.json();
    const clips = Array.isArray(data) ? data : (data.clips || data.data || [data]);
    const id    = clips[0]?.id || clips[0]?.task_id;
    if (!id) return res.status(500).json({ error: 'Suno returned no song ID — check your API key.' });
    res.json({ id, lyrics, style });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 2: poll until Suno finishes, return { status, url }
app.get('/api/song-status/:id', async (req, res) => {
  const sunoKey = process.env.SUNO_API_KEY;
  if (!sunoKey) return res.status(500).json({ error: 'SUNO_API_KEY not set.' });
  try {
    const r    = await fetch(`https://api.suno.ai/v1/songs/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${sunoKey}` },
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    const song = Array.isArray(data) ? data[0] : data;
    res.json({ status: song.status || song.state, url: song.audio_url || song.url || null, error: song.error_message || null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HuggingFace MusicGen fallback (no Suno key) ───────────────────────────────
// Song generation via HuggingFace MusicGen — token optional (anonymous has low rate limit)
app.post('/api/song-generate', async (req, res) => {
  const hfToken      = process.env.HUGGINGFACE_TOKEN; // optional — improves rate limits
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided.' });

  // Generate a short lyric-style music prompt with Claude
  let prompt = `upbeat energetic legal news jingle, major key, bright professional vocals. ${text.slice(0, 150)}`;
  if (anthropicKey) {
    try {
      const lr = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 120,
          system: 'Write 3-4 short punchy rhyming song lyrics about the legal news. Output ONLY the lyrics.',
          messages: [{ role: 'user', content: text.slice(0, 500) }]
        }),
        signal: AbortSignal.timeout(12000)
      });
      if (lr.ok) {
        const d = await lr.json();
        const l = d.content?.[0]?.text?.trim();
        if (l) prompt = `upbeat energetic pop, professional news song, sung vocals. ${l.slice(0, 200)}`;
      }
    } catch {}
  }

  const hfHeaders = { 'Content-Type': 'application/json' };
  if (hfToken) hfHeaders['Authorization'] = `Bearer ${hfToken}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const hfRes = await fetch(
        'https://api-inference.huggingface.co/models/facebook/musicgen-small',
        { method: 'POST', headers: hfHeaders, body: JSON.stringify({ inputs: prompt }), signal: AbortSignal.timeout(90000) }
      );

      if (hfRes.status === 503) {
        const info = await hfRes.json().catch(() => ({}));
        const wait = Math.min((info.estimated_time || 20) * 1000, 25000);
        console.log(`[HF] Model loading, waiting ${Math.round(wait/1000)}s (attempt ${attempt+1})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (hfRes.status === 401) {
        // Anonymous quota exhausted — tell client to use browser fallback
        return res.status(401).json({ fallback: true, error: 'HuggingFace rate limit — using in-browser music.' });
      }

      if (!hfRes.ok) {
        const msg = await hfRes.text();
        return res.status(hfRes.status).json({ fallback: true, error: `Music API: ${msg.slice(0, 150)}` });
      }

      const buf = await hfRes.arrayBuffer();
      res.setHeader('Content-Type', 'audio/flac');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(Buffer.from(buf));

    } catch(e) {
      if (attempt === 5) return res.status(500).json({ fallback: true, error: e.message });
    }
  }
  res.status(503).json({ fallback: true, error: 'Model warming up.' });
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
