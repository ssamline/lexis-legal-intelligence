const express = require('express');
const path = require('path');

const app = express();
app.set('trust proxy', true); // Render sits behind a proxy — needed for req.ip to reflect the real client
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ── Simple in-memory rate limiter (per IP, per feature bucket) — no new
// dependency needed at this traffic scale. Each feature gets its own budget
// (e.g. Daily Briefing is used far more often per session than Compare
// Companies or Story Research, so it needs a much more generous limit).
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateHits = new Map(); // `${bucket}:${ip}` -> { count, resetAt }
function checkRateLimit(ip, bucket, max) {
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const entry = rateHits.get(key);
  if (!entry || now > entry.resetAt) {
    rateHits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateHits) if (now > entry.resetAt) rateHits.delete(key);
}, 10 * 60 * 1000);

// Common RSS/Atom feed paths to try for any domain
const RSS_PATHS = [
  '/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml',
  '/feed/rss', '/rss/feed', '/news/feed', '/feed/news',
  '/?feed=rss2', '/index.xml', '/feeds/posts/default',
  '/blog/feed', '/articles/feed', '/legal-news/feed',
  '/rss/allArticle.xml'
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

async function tryFetchFeed(url, domain) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Lex.Almonds/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow'
    });
    if (!res.ok) return [];
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('html') && !ct.includes('xml')) return []; // skip HTML pages
    const xml = await res.text();
    if (!xml.includes('<item>') && !xml.includes('<entry>')) return [];
    return parseXmlItems(xml, domain, 8);
  } catch {
    return [];
  }
}

function findFeedLinkInHtml(html) {
  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const candidates = linkTags.filter(tag =>
    /rel=["']?alternate["']?/i.test(tag) &&
    /type=["']?application\/(?:rss|atom)\+xml["']?/i.test(tag)
  );
  // WordPress (very common among small news/blog sites) emits a "Comments
  // Feed" <link> alongside the real article feed — usually after it, but
  // that order isn't guaranteed. Skip anything whose title says "comment"
  // so we don't silently parse blog comments instead of articles.
  const primary = candidates.find(tag => !/title=["'][^"']*comment/i.test(tag)) || candidates[0];
  if (!primary) return null;
  const hrefMatch = primary.match(/href=["']([^"']+)["']/i) || primary.match(/href=([^\s>]+)/i);
  return hrefMatch ? decodeEntities(hrefMatch[1]) : null;
}

async function discoverFeedUrl(base) {
  try {
    const res = await fetch(base + '/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow'
    });
    if (!res.ok) return null;
    const html = await res.text();
    const href = findFeedLinkInHtml(html);
    return href ? new URL(href, base + '/').href : null;
  } catch {
    return null;
  }
}

async function fetchSiteArticles(domain) {
  const base = /^https?:\/\//.test(domain)
    ? domain.replace(/\/$/, '')
    : `https://${domain}`;

  // 1. Ask the homepage what feed it actually advertises — works for any
  //    domain that follows the standard, regardless of path convention.
  const discovered = await discoverFeedUrl(base);
  if (discovered) {
    const items = await tryFetchFeed(discovered, domain);
    if (items.length) {
      console.log(`[RSS] ${domain} via discovered link (${discovered}) → ${items.length} articles`);
      return items;
    }
  }

  // 2. Fall back to guessing common paths — still catches sites that
  //    don't advertise a <link> tag but do have a feed at a known path.
  for (const feedPath of RSS_PATHS) {
    const items = await tryFetchFeed(base + feedPath, domain);
    if (items.length) {
      console.log(`[RSS] ${domain}${feedPath} → ${items.length} articles`);
      return items;
    }
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
  if (!urls.length) return res.json({ articles: [], failedDomains: [] });

  try {
    const results = await Promise.all(urls.map(domain => fetchSiteArticles(domain)));
    const articles = results.flat();
    const failedDomains = urls.filter((_, i) => results[i].length === 0);
    res.json({ articles, failedDomains });
  } catch (e) {
    res.json({ articles: [], failedDomains: urls });
  }
});

// Fetch a URL and extract {title, desc, paragraphs, finalUrl} — shared by the
// article reader modal and story-research.
async function extractArticleText(url) {
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

  return { title, desc, paragraphs: paragraphs.slice(0, 30), finalUrl };
}

// Fetch and extract full article content for the reader modal
app.post('/api/fetch-article', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'Invalid URL' });

  try {
    const data = await extractArticleText(url);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function searchCourtListener(query) {
  try {
    const q   = encodeURIComponent(query);
    const res = await fetch(
      `https://www.courtlistener.com/api/rest/v4/search/?q=${q}&type=o&order_by=score+desc`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'Lex.Almonds/1.0' }, signal: AbortSignal.timeout(8000) }
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

const BRIEFING_TOPIC_LABELS = { ip: 'IP & Technology', reg: 'Regulatory & Compliance', lit: 'Litigation & Courts', corp: 'Corporate & M&A' };

// Server-fixed prompt for the Daily Briefing — moved off the open /api/chat
// proxy specifically because it now optionally uses paid web_search/web_fetch
// tools, and a client-controlled proxy would let anyone trigger those at will.
// See CLAUDE.md and docs/plans/plan_global_legal_research.md for the design.
app.post('/api/generate-briefing', async (req, res) => {
  if (!checkRateLimit(req.ip, 'generate-briefing', 30)) {
    return res.status(429).json({ error: 'Too many briefing requests. Please try again later.' });
  }

  const {
    activeTopics = [], keywords = [], sectors = [], companies = [],
    articles = [], failedSources = []
  } = req.body;
  if (!activeTopics.length) return res.status(400).json({ error: 'Enable at least one Legal Topic.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const topicNames = activeTopics.map(t => BRIEFING_TOPIC_LABELS[t] || t).join(', ');
  const kwExtra     = keywords.length ? ` Emphasize: ${keywords.join(', ')}.` : '';
  const today       = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const hasCompanies = companies.length > 0;

  let bizInstr = ` For each section include a "biz" array of 1-2 opportunities and 1-2 risks directly tied to that section's legal developments.`;
  if (sectors.length)   bizInstr += ` Business sectors: ${sectors.join(', ')}.`;
  if (companies.length) bizInstr += ` Tracked companies: ${companies.join(', ')}.`;
  if (hasCompanies) {
    bizInstr += ` For opportunity/risk items tied to a tracked company: first determine (use web_search if needed) which countries that company primarily operates in or is listed in — do not assume it is US-only. For each relevant jurisdiction, prioritize official, primary sources over blogs or unverified news — for example SEC EDGAR and CourtListener for US companies, EUR-Lex and European Commission announcements for the EU, Companies House and the FCA register for the UK, EDINET for Japan, DART for South Korea, or the equivalent official regulator, court, or government gazette for other countries. Also look for what the company has recently told investors — 10-K risk factors, annual report, earnings call commentary, investor day materials — and explicitly compare that against current legal/regulatory developments, calling out concrete gaps or alignments rather than generic statements. Every company-related biz item must be grounded in a specific finding; if you cannot find a credible source, say so rather than inventing one. Add a "source" field (a real URL, or "" if no external source was used) to each biz item.`;
  } else {
    bizInstr += ` Each biz item: {type:"opportunity"|"risk",company:"name or empty",sector:"name or empty",text:"1-2 sentences"}.`;
  }

  let articleCtx = '';
  if (articles.length) {
    articleCtx = '\n\nRecent articles fetched from the user\'s selected sources:\n' +
      articles.map((a, i) => `${i+1}. (${a.domain}) ${a.title}`).join('\n');
  }
  const hasArticles = articles.length > 0;

  const foreignInstr = ` Additionally, inspect the article list above by their (domain) prefix — if any domain's article titles are written in a language other than English, identify each such distinct language. For each one, write a 3-5 sentence summary paragraph, written ENTIRELY in that language, covering only the legal and business developments implied by that domain's titles, scoped to topics: ${topicNames}${sectors.length ? ' and business sectors: ' + sectors.join(', ') : ''}. Add one entry per distinct non-English language to a "foreignSummaries" array: {"language":"<language name in English, e.g. French>","text":"<summary written in that language>"}. If every source domain's titles are in English, return "foreignSummaries": [].`;
  const failedSourcesInstr = failedSources.length
    ? ` Additionally, for each of these source domains that returned no articles today — ${failedSources.join(', ')} — suggest ONE real, well-known alternative English-language legal or business-regulatory news site (one likely to have a working public RSS feed) that covers similar ground. Add one entry per failed domain to a "sourceAlternatives" array: {"failedDomain":"...","suggestion":"suggested-domain.com","reason":"one short sentence why"}.`
    : '';

  const system = `You are a senior legal news analyst. Generate a concise daily legal briefing for ${today}. Topics: ${topicNames}.${kwExtra}${bizInstr}
${hasArticles ? articleCtx + `\n\nUsing ONLY the articles listed above, select and summarize the ones most strategically significant for the selected topics${sectors.length ? ' and business sectors' : ''} — prioritize by likely business/legal impact (deal risk, regulatory exposure, competitive positioning, revenue impact), never by which source domain or language an article happens to come from. Write 2-3 bullet summaries per section from that selection. Each bullet MUST reference one article by its number using "ref": <integer>. Do NOT copy URLs into the JSON.${foreignInstr}` : 'No live articles available — generate a plausible briefing based on current legal trends. Omit "ref" from bullets.'}${failedSourcesInstr}
Reply ONLY in valid JSON, no markdown fences:
{"sections":[{"topic":"ip","bullets":[{"text":"one-sentence summary of the article","ref":1}],"prose":"...","biz":[{"type":"opportunity","company":"","sector":"","text":"..."}]}],"foreignSummaries":[{"language":"French","text":"..."}],"sourceAlternatives":[{"failedDomain":"...","suggestion":"...","reason":"..."}]}
Only include these topics: ${activeTopics.join(',')}.`;

  const body = {
    model: hasCompanies ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001',
    max_tokens: hasCompanies ? 4000 : 2500,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: `Generate briefing. Topics:${activeTopics.join(',')}.` }]
  };
  if (hasCompanies) {
    body.tools = [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 }
    ];
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(hasCompanies ? 60000 : 30000)
    });
    const data = await claudeRes.json();
    res.status(claudeRes.status).json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// Competitive legal analysis: SEC EDGAR + CourtListener + user sources
app.post('/api/compare-companies', async (req, res) => {
  if (!checkRateLimit(req.ip, 'compare-companies', 10)) {
    return res.status(429).json({ error: 'Too many comparison requests. Please try again later.' });
  }

  const { companies = [], urls = [], topics = {}, sectors = {} } = req.body;
  if (companies.length < 2) return res.status(400).json({ error: 'Need at least 2 companies to compare.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  // 1. News from user sources mentioning each company
  const newsData = {};
  for (const co of companies) {
    const hits = [];
    for (const domain of urls) {
      try {
        const arts = await fetchSiteArticles(domain);
        hits.push(...arts.filter(a => a.title.toLowerCase().includes(co.toLowerCase())).slice(0, 3));
      } catch {}
    }
    newsData[co] = hits.slice(0, 5);
  }

  // 2. CourtListener federal cases for each company
  const caseData = {};
  for (const co of companies) {
    caseData[co] = await searchCourtListener(co);
  }

  // 3. SEC EDGAR recent filings for each company
  const secData = {};
  for (const co of companies) {
    try {
      const secRes = await fetch(
        `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(co)}%22&forms=10-K,10-Q,8-K&dateRange=custom&startdt=2024-01-01`,
        {
          headers: { 'User-Agent': 'Lex.Almonds/1.0 (lexalmonds@gmail.com)', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000)
        }
      );
      if (secRes.ok) {
        const d = await secRes.json();
        secData[co] = (d.hits?.hits || []).slice(0, 4).map(h => ({
          form: h._source?.form_type || '',
          date: h._source?.file_date || '',
          company: (h._source?.display_names?.[0]?.name || co)
        }));
      }
    } catch {}
    if (!secData[co]) secData[co] = [];
  }

  // 4. Build context for Claude
  const TOPIC_LABELS = { ip: 'IP & Technology law', reg: 'Regulatory & Compliance', lit: 'Litigation & Courts', corp: 'Corporate & M&A' };
  const SECTOR_LABELS = {
    technology:'Technology & AI', finance:'Finance & Banking', healthcare:'Healthcare & Pharma',
    realestate:'Real Estate', energy:'Energy & Environment', retail:'Retail & E-commerce',
    media:'Media & Entertainment', manufacturing:'Manufacturing', startup:'Startups & VC'
  };
  const activeTopics  = Object.entries(topics).filter(([,v])=>v).map(([k])=>TOPIC_LABELS[k]||k);
  const activeSectors = Object.entries(sectors).filter(([,v])=>v).map(([k])=>SECTOR_LABELS[k]||k);

  let ctx = `Compare these companies from a legal perspective: ${companies.join(' vs. ')}\n\n`;
  if (activeTopics.length)  ctx += `FOCUS ONLY on these legal topic areas: ${activeTopics.join(', ')}. Do not analyse areas outside this scope.\n`;
  if (activeSectors.length) ctx += `Industry context: ${activeSectors.join(', ')}.\n`;
  ctx += `Lens: how do recent changes in law and regulations within the above topic areas create competitive differences?\n\n`;

  for (const co of companies) {
    ctx += `## ${co}\n`;
    if (newsData[co].length) ctx += `Recent legal news:\n${newsData[co].map(a => `- ${a.title}`).join('\n')}\n`;
    if (caseData[co].length) ctx += `Court cases:\n${caseData[co].map(c => `- ${c.title} (${c.court}, ${c.date}): ${c.snippet}`).join('\n')}\n`;
    if (secData[co].length) ctx += `SEC filings:\n${secData[co].map(s => `- ${s.form} (${s.date}): ${s.company}`).join('\n')}\n`;
    ctx += '\n';
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
          { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 }
        ],
        system: `You are a legal intelligence analyst specializing in competitive regulatory analysis. Compare companies strictly within the legal topic areas specified by the user. If specific topic areas are listed (e.g. IP & Technology, Regulatory & Compliance, Litigation & Courts, Corporate & M&A), confine every insight to those areas only — do not stray into unrelated legal domains.

These companies may not all operate primarily in the US. Before analyzing, determine (use web_search if needed) which countries each company primarily operates in and where it is listed/incorporated — do not assume US-only. For each relevant jurisdiction, prioritize official, primary sources over blogs or unverified news: for example SEC EDGAR and CourtListener for US companies, EUR-Lex and European Commission announcements for the EU, Companies House and the FCA register for the UK, EDINET for Japan, DART for South Korea, or the equivalent official regulator, court, or government gazette for other countries. The context below already includes some US-sourced news/case/filing data as a starting point — supplement it with jurisdiction-appropriate sources for each company via web_search/web_fetch, and do not treat the US sources as sufficient for a non-US company.

Also look for what each company has recently told investors — 10-K risk factors, annual report, earnings call commentary, investor day materials — and explicitly compare that against current legal/regulatory developments, calling out concrete gaps or alignments rather than generic statements.

Every risk, advantage, and development you list must be grounded in a specific source found via the context or web_search/web_fetch. Do not write vague, ungrounded generalities — if you cannot find credible evidence for a claim, omit it rather than inventing one.

Respond ONLY as valid JSON (no markdown fences, no text outside the JSON object):
{
  "summary": "2-3 sentence overview of the competitive legal landscape within the specified topic areas",
  "isCompetitors": true,
  "industryContext": "What industry/market they compete in",
  "focusAreas": ["topic area 1", "topic area 2"],
  "companies": {
    "COMPANY_NAME": {
      "riskLevel": "High|Medium|Low",
      "keyRisks": ["specific risk within selected topics 1", "risk 2", "risk 3"],
      "legalAdvantages": ["advantage within selected topics 1", "advantage 2"],
      "recentDevelopments": ["recent legal development relevant to selected topics 1", "development 2"],
      "regulatoryExposure": "One sentence on main exposure within the selected topic areas",
      "citations": ["https://... real URL backing the above", "https://..."]
    }
  },
  "industryTrends": ["regulatory trend within selected topics 1", "trend 2", "trend 3"],
  "comparativeVerdict": "Which company has the stronger position within the selected legal topic areas and why",
  "watchlist": ["upcoming development in selected topic areas to watch 1", "development 2"]
}`,
        messages: [{ role: 'user', content: ctx }]
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!claudeRes.ok) return res.status(500).json({ error: 'Claude API error.' });
    const claudeData = await claudeRes.json();
    // With web_search/web_fetch tools, content includes tool_result blocks alongside
    // text blocks — the final answer isn't necessarily at index 0, so join all text blocks.
    const raw = (claudeData.content || []).map(b => b.text || '').join('').trim();

    try {
      const m = raw.match(/\{[\s\S]*\}/);
      const analysis = m ? JSON.parse(m[0]) : { summary: raw };
      res.json({ analysis, sources: { news: newsData, cases: caseData, sec: secData } });
    } catch {
      res.json({ analysis: { summary: raw }, sources: {} });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Story research: summarize a story, or analyze its impact on tracked companies/sectors,
// from either a pasted URL or an uploaded image. See CLAUDE.md for the design rules this
// endpoint must keep (fixed server-side prompts, cost caps, rate limit, JSON-only output).
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

app.post('/api/story-research', async (req, res) => {
  if (!checkRateLimit(req.ip, 'story-research', 8)) {
    return res.status(429).json({ error: 'Too many research requests. Please try again later.' });
  }

  const { researchType, url, image, companies = [], sectors = [] } = req.body;
  if (!['summary', 'impact'].includes(researchType)) {
    return res.status(400).json({ error: 'Invalid research type.' });
  }
  if (!url && !image) return res.status(400).json({ error: 'Provide a URL or an image.' });
  if (url && image) return res.status(400).json({ error: 'Provide either a URL or an image, not both.' });
  if (researchType === 'impact' && companies.length === 0 && sectors.length === 0) {
    return res.status(400).json({ error: 'Add a tracked company or business sector first.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  // 1. Prepare the source content as Claude message content blocks
  let sourceTitle = '';
  let userContent;

  if (url) {
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid URL.' });
    try {
      const { title, desc, paragraphs } = await extractArticleText(url);
      sourceTitle = title || url;
      const text = (paragraphs.length ? paragraphs.join('\n\n') : desc).slice(0, 6000);
      if (!text.trim()) return res.status(422).json({ error: 'Could not extract readable content from that URL.' });
      userContent = [{ type: 'text', text: `Article title: ${sourceTitle}\n\n${text}` }];
    } catch (e) {
      return res.status(502).json({ error: `Could not fetch that URL: ${e.message}` });
    }
  } else {
    const { data, mediaType } = image || {};
    if (!data || !ALLOWED_IMAGE_TYPES.includes(mediaType)) {
      return res.status(400).json({ error: 'Unsupported image. Use PNG, JPEG, WebP, or GIF.' });
    }
    const approxBytes = data.length * 0.75; // base64 length -> decoded byte estimate
    if (approxBytes > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (5MB limit).' });
    sourceTitle = 'Uploaded image';
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      { type: 'text', text: 'This image shows a news story, legal document, or announcement. Analyze it.' }
    ];
  }

  // 2. Fixed system prompt per research type
  let system, maxTokens;
  if (researchType === 'summary') {
    maxTokens = 700;
    system = `You are a legal analyst. Given a news story about a law, regulation, or legal/regulatory trend, explain what it covers and why it matters.
Respond ONLY as valid JSON (no markdown fences, no text outside the JSON object):
{"headline":"one-line description of the law/trend covered","summary":"3-5 sentence plain-language explanation of what it is and why it matters","keyPoints":["point 1","point 2","point 3"]}`;
  } else {
    maxTokens = 1500;
    const targets = [...companies, ...sectors];
    system = `You are a legal intelligence analyst. Given a news story about a law, regulation, or legal/regulatory trend, analyze its potential impact specifically on these companies/industries: ${targets.join(', ')}. If a target is not clearly affected, say so plainly rather than inventing a connection.
Respond ONLY as valid JSON (no markdown fences, no text outside the JSON object):
{"summary":"2-3 sentence overview of what the story covers","impacts":[{"target":"company or industry name","riskLevel":"High|Medium|Low|None","impact":"1-3 sentence explanation specific to this target"}]}`;
  }

  // 3. Call Claude
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userContent }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!claudeRes.ok) return res.status(500).json({ error: 'Claude API error.' });
    const claudeData = await claudeRes.json();
    const raw = (claudeData.content?.[0]?.text || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const result = m ? JSON.parse(m[0]) : { summary: raw };
    res.json({ result, sourceTitle, researchType });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
