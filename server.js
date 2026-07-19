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

// Bounds the worst-case cost/latency of the per-company parallel fan-out below —
// a user tracking many companies shouldn't be able to trigger an unbounded number
// of concurrent Sonnet 5 + web_search/web_fetch calls in one request.
const MAX_COMPANIES_FOR_RESEARCH = 5;

async function attemptResearchCompanyIntel(apiKey, company, topicNames, sectors, timeoutMs) {
  const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const system = `You are a legal intelligence analyst. Today is ${todayStr}. Research ${company} to find realistic, well-sourced legal/regulatory opportunities and risks relevant to these topics: ${topicNames}.${sectors.length ? ` Business sectors: ${sectors.join(', ')}.` : ''}
Scope your research to developments from roughly the last 30 days only — this keeps the research focused on what's actually current, not a speed constraint. Thoroughness matters more than speed here — research all four of these areas properly rather than stopping early:
1. Recent court rulings or case law involving ${company} or directly affecting its industry.
2. Recent M&A activity — pending or completed acquisitions, mergers, or divestitures — and any related regulatory/antitrust review.
3. Recent regulatory or policy announcements/enforcement actions in the jurisdiction(s) ${company} operates in.
4. What ${company} has recently and publicly disclosed to investors (10-K risk factors, earnings call commentary, investor day materials) that relates to #1-#3 — compare its stated strategy against what's actually happening legally.
First determine (use web_search if needed) which countries ${company} primarily operates in or is listed in — do not assume it is US-only. For each relevant jurisdiction, prioritize official, primary sources over blogs or unverified news: SEC EDGAR and CourtListener for US companies, EUR-Lex and European Commission announcements for the EU, Companies House and the FCA register for the UK, EDINET for Japan, DART for South Korea, or the equivalent official regulator/court/gazette for other countries.
Every item must be grounded in a specific source; if you cannot find credible evidence from the last 30 days, omit it rather than inventing one or reaching further back in time.
You MUST respond with ONLY the JSON object below and nothing else — no explanation, no markdown fences, no prose before or after it. If you find no grounded evidence for opportunities or risks, return that field as an empty array rather than writing an explanation: {"opportunities":[{"text":"1-2 sentences","source":"https://..."}],"risks":[{"text":"1-2 sentences","source":"https://..."}]}`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 }
      ],
      system,
      messages: [{ role: 'user', content: `Research ${company}. Respond with ONLY the JSON object — no prose.` }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!claudeRes.ok) {
    const errBody = await claudeRes.text().catch(() => '');
    console.error(`researchCompanyIntel HTTP ${claudeRes.status} for ${company}:`, errBody);
    return { company, error: `HTTP ${claudeRes.status}: ${errBody.slice(0, 300)}` };
  }
  const data = await claudeRes.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    console.error(`researchCompanyIntel no-JSON for ${company} (stop_reason: ${data.stop_reason}):`, text.slice(0, 500));
    return { company, error: `No JSON found (stop_reason: ${data.stop_reason}): ${text.slice(0, 200)}` };
  }
  const parsed = JSON.parse(m[0]);
  return { company, opportunities: parsed.opportunities || [], risks: parsed.risks || [] };
}

// Researches ONE company's jurisdiction-aware legal opportunities/risks via Sonnet 5
// + web_search/web_fetch. Scoped to a single company so it completes fast enough to
// run in parallel with sibling calls — a live test that researched 2 companies in one
// combined call took 280s+ and still didn't finish. On failure (timeout or bad
// response), retries once with a shorter 100s budget — live testing showed some
// companies fail intermittently while siblings in the same request succeed, so a
// single retry meaningfully improves completion without reverting to a slower
// single-call design. The retry uses a shorter timeout than the first attempt so one
// stubborn company can't push the whole request's wall-clock time much past ~300s.
// Returns {company, error} rather than null even after both attempts fail, so the
// caller can surface why (never silently drops a company with no explanation).
async function researchCompanyIntel(apiKey, company, topicNames, sectors) {
  try {
    const first = await attemptResearchCompanyIntel(apiKey, company, topicNames, sectors, 200000);
    if (!first.error) return first;
    console.error(`researchCompanyIntel retrying ${company} after: ${first.error}`);
    try {
      return await attemptResearchCompanyIntel(apiKey, company, topicNames, sectors, 100000);
    } catch (e2) {
      console.error(`researchCompanyIntel retry failed for ${company}:`, e2.message);
      return { company, error: `${first.error} (retry: ${e2.message})` };
    }
  } catch (e) {
    console.error(`researchCompanyIntel failed for ${company}:`, e.message);
    try {
      return await attemptResearchCompanyIntel(apiKey, company, topicNames, sectors, 100000);
    } catch (e2) {
      console.error(`researchCompanyIntel retry failed for ${company}:`, e2.message);
      return { company, error: `${e.message} (retry: ${e2.message})` };
    }
  }
}

// Server-fixed prompt for the Daily Briefing — moved off the open /api/chat
// proxy specifically because it now optionally uses paid web_search/web_fetch
// tools, and a client-controlled proxy would let anyone trigger those at will.
// See CLAUDE.md and docs/plans/plan_global_legal_research.md for the design.
//
// The topic-sections generation (Haiku, no tools) and the per-company jurisdiction
// research (Sonnet 5 + tools, one call per company, run in parallel) are two
// separate Claude calls merged into one response below. Splitting them out this way
// keeps the fast/cheap Haiku path exactly as it always was, and bounds the slow path's
// wall-clock time to roughly ONE company's research time instead of N companies done
// serially in a single tool-loop (which is what caused the earlier timeouts).
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
  const researchCompanies = companies.slice(0, MAX_COMPANIES_FOR_RESEARCH);

  let bizInstr = ` For each section include a "biz" array of 1-2 opportunities and 1-2 risks directly tied to THIS SECTION's own legal developments — not a generic business summary.`;
  if (sectors.length) bizInstr += ` The user tracks these business sectors: ${sectors.join(', ')}. Only tag a biz item with one of these sectors if this section's legal development genuinely and specifically affects that sector — do not force-fit an unrelated sector onto unrelated legal news just because it's in the tracked list. Leave "sector" empty if none of the tracked sectors are actually relevant to this section.`;
  bizInstr += ` Each biz item: {type:"opportunity"|"risk",company:"",sector:"name or empty",text:"1-2 sentences"}. Do not name specific tracked companies in this array — verified, sourced company-specific intelligence is generated separately.`;

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

  const sectionsSystem = `You are a senior legal news analyst. Generate a concise daily legal briefing for ${today}. Topics: ${topicNames}.${kwExtra}${bizInstr}
${hasArticles ? articleCtx + `\n\nUsing ONLY the articles listed above, select and summarize the ones most strategically significant for the selected topics${sectors.length ? ' and business sectors' : ''} — prioritize by likely business/legal impact (deal risk, regulatory exposure, competitive positioning, revenue impact), never by which source domain or language an article happens to come from. Write 2-3 bullet summaries per section from that selection. Each bullet MUST reference one article by its number using "ref": <integer>. Do NOT copy URLs into the JSON.${foreignInstr}` : 'No live articles available — generate a plausible briefing based on current legal trends. Omit "ref" from bullets.'}${failedSourcesInstr}
Reply ONLY in valid JSON, no markdown fences:
{"sections":[{"topic":"ip","bullets":[{"text":"one-sentence summary of the article","ref":1}],"prose":"...","biz":[{"type":"opportunity","company":"","sector":"","text":"..."}]}],"foreignSummaries":[{"language":"French","text":"..."}],"sourceAlternatives":[{"failedDomain":"...","suggestion":"...","reason":"..."}]}
Only include these topics: ${activeTopics.join(',')}.`;

  // Isolated in its own try/catch (rather than let its fetch reject straight into the
  // outer Promise.all) so a sections-track failure produces a clearly labeled error
  // instead of an ambiguous "operation aborted" that could equally point at either
  // track — this distinction was impossible to diagnose without it in earlier testing.
  async function runSections() {
    try {
      const sectionsRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2500,
          temperature: 0,
          system: sectionsSystem,
          messages: [{ role: 'user', content: `Generate briefing. Topics:${activeTopics.join(',')}.` }]
        }),
        signal: AbortSignal.timeout(45000)
      });
      if (!sectionsRes.ok) {
        const errBody = await sectionsRes.json().catch(() => ({}));
        console.error('generate-briefing sections HTTP error:', sectionsRes.status, JSON.stringify(errBody));
        return { ok: false, error: errBody.error || { message: `Sections generation failed (HTTP ${sectionsRes.status}).` } };
      }
      const sectionsData = await sectionsRes.json();
      const sectionsText = (sectionsData.content || []).map(b => b.text || '').join('').trim();
      const sm = sectionsText.match(/\{[\s\S]*\}/);
      if (!sm) return { ok: false, error: { message: 'Sections generation returned no usable content.' } };
      try {
        return { ok: true, data: JSON.parse(sm[0]) };
      } catch {
        return { ok: false, error: { message: 'Sections generation returned malformed JSON.' } };
      }
    } catch (e) {
      console.error('generate-briefing sections track failed:', e.message);
      return { ok: false, error: { message: `Sections generation timed out or failed: ${e.message}` } };
    }
  }

  const companyIntelPromise = hasCompanies
    ? Promise.all(researchCompanies.map(co => researchCompanyIntel(apiKey, co, topicNames, sectors)))
    : Promise.resolve([]);

  const [sectionsResult, companyIntelResults] = await Promise.all([runSections(), companyIntelPromise]);

  if (!sectionsResult.ok) {
    return res.status(500).json({ error: sectionsResult.error });
  }

  // companyIntelResults entries are either {company,opportunities,risks} on success
  // or {company,error} on failure (researchCompanyIntel never returns null). Surfacing
  // the errors (temporarily, as companyIntelErrors) instead of silently dropping them
  // was added specifically to diagnose why per-company research kept failing without
  // access to server logs — worth keeping short-term even though the UI ignores it.
  const companyIntelOk = companyIntelResults.filter(r => r && !r.error);
  const companyIntelErrors = companyIntelResults.filter(r => r && r.error);
  if (companyIntelErrors.length) console.error('generate-briefing companyIntel errors:', JSON.stringify(companyIntelErrors));

  const merged = {
    sections: sectionsResult.data.sections || [],
    foreignSummaries: sectionsResult.data.foreignSummaries || [],
    sourceAlternatives: sectionsResult.data.sourceAlternatives || [],
    companyIntel: companyIntelOk,
    companyIntelErrors
  };
  // Wrapped in the same {content:[{type:'text',text:...}]} envelope the raw Claude
  // API would return, so the existing client-side parsing (apiData.content.map(...))
  // keeps working unchanged even though this is now server-merged, not proxied.
  res.json({ content: [{ type: 'text', text: JSON.stringify(merged) }] });
});

async function attemptResearchCompareCompanyIntel(apiKey, company, ctx, activeTopicLabels, timeoutMs) {
  const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const system = `You are a legal intelligence analyst specializing in competitive regulatory analysis for ${company}. Today is ${todayStr}. Focus strictly on these legal topic areas: ${activeTopicLabels.length ? activeTopicLabels.join(', ') : 'general legal and regulatory matters'}.

Scope your research to developments from roughly the last 30 days only — this keeps the research focused on what's actually current, not a speed constraint. Thoroughness matters more than speed here — research all four of these areas properly rather than stopping early:
1. Recent court rulings or case law involving ${company} or directly affecting its industry.
2. Recent M&A activity — pending or completed acquisitions, mergers, or divestitures — and any related regulatory/antitrust review.
3. Recent regulatory or policy announcements/enforcement actions in the jurisdiction(s) ${company} operates in.
4. What ${company} has recently and publicly disclosed to investors (10-K risk factors, earnings call commentary, investor day materials) that relates to #1-#3.

This company may not operate primarily in the US. Before analyzing, determine (use web_search if needed) which countries ${company} primarily operates in and where it is listed/incorporated — do not assume US-only. For each relevant jurisdiction, prioritize official, primary sources: SEC EDGAR and CourtListener for US companies, EUR-Lex and European Commission announcements for the EU, Companies House and the FCA register for the UK, EDINET for Japan, DART for South Korea, or the equivalent official regulator/court/gazette for other countries. The context below includes some US-sourced data as a starting point — supplement it via web_search/web_fetch, and don't treat US sources as sufficient for a non-US company.

Every risk, advantage, and development must be grounded in a specific source from the last 30 days; omit rather than invent or reach further back in time.

You MUST respond with ONLY the JSON object below and nothing else — no explanation, no markdown fences, no prose before or after it. If you find no grounded evidence for a field, return an empty array/string rather than writing an explanation: {"riskLevel":"High|Medium|Low","keyRisks":["specific risk 1","risk 2","risk 3"],"legalAdvantages":["advantage 1","advantage 2"],"recentDevelopments":["development 1","development 2"],"regulatoryExposure":"one sentence on main exposure","citations":["https://... real URL backing the above","https://..."]}`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 4 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 }
      ],
      system,
      messages: [{ role: 'user', content: ctx + '\n\nRespond with ONLY the JSON object — no prose.' }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!claudeRes.ok) {
    console.error(`researchCompareCompanyIntel HTTP ${claudeRes.status} for ${company}:`, await claudeRes.text().catch(() => ''));
    return null;
  }
  const data = await claudeRes.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    console.error(`researchCompareCompanyIntel no-JSON for ${company} (stop_reason: ${data.stop_reason}):`, text.slice(0, 500));
    return null;
  }
  return { company, data: JSON.parse(m[0]) };
}

// Researches ONE company's competitive legal position (risks, advantages, developments,
// citations) via Sonnet 5 + web_search/web_fetch, scoped to just that company so it can
// run in parallel with sibling companies rather than one combined multi-company call
// that serializes all the tool-use round trips (which timed out at 280s+ in testing).
// Retries once with a shorter 100s budget on failure — live testing showed some
// companies (e.g. Ford, Agilent) fail intermittently while others (Toyota) succeed
// reliably in the same request; a single retry meaningfully improves the odds both
// companies end up with data without reverting to the slower single-call design.
async function researchCompareCompanyIntel(apiKey, company, ctx, activeTopicLabels) {
  try {
    const first = await attemptResearchCompareCompanyIntel(apiKey, company, ctx, activeTopicLabels, 200000);
    if (first) return first;
    console.error(`researchCompareCompanyIntel retrying ${company} after a failed first attempt`);
  } catch (e) {
    console.error(`researchCompareCompanyIntel failed for ${company}:`, e.message);
  }
  try {
    return await attemptResearchCompareCompanyIntel(apiKey, company, ctx, activeTopicLabels, 100000);
  } catch (e) {
    console.error(`researchCompareCompanyIntel retry failed for ${company}:`, e.message);
    return null;
  }
}

// Competitive legal analysis: SEC EDGAR + CourtListener + user sources, plus per-company
// jurisdiction research (parallel Sonnet 5 + web_search/web_fetch calls, one per company)
// followed by a fast Haiku synthesis call that compares the already-gathered per-company
// findings against each other. Splitting it this way bounds wall-clock time to roughly
// one company's research instead of N companies researched serially in one long call.
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

  // 4. Build per-topic/sector labels and each company's supplementary context
  const TOPIC_LABELS = { ip: 'IP & Technology law', reg: 'Regulatory & Compliance', lit: 'Litigation & Courts', corp: 'Corporate & M&A' };
  const SECTOR_LABELS = {
    technology:'Technology & AI', finance:'Finance & Banking', healthcare:'Healthcare & Pharma',
    realestate:'Real Estate', energy:'Energy & Environment', retail:'Retail & E-commerce',
    media:'Media & Entertainment', manufacturing:'Manufacturing', startup:'Startups & VC'
  };
  const activeTopics  = Object.entries(topics).filter(([,v])=>v).map(([k])=>TOPIC_LABELS[k]||k);
  const activeSectors = Object.entries(sectors).filter(([,v])=>v).map(([k])=>SECTOR_LABELS[k]||k);
  const researchCompanies = companies.slice(0, MAX_COMPANIES_FOR_RESEARCH);

  const ctxFor = (co) => {
    let ctx = `Analyze ${co} from a legal perspective, as one company being compared against: ${companies.filter(c=>c!==co).join(', ')}.\n\n`;
    if (activeTopics.length)  ctx += `FOCUS ONLY on these legal topic areas: ${activeTopics.join(', ')}. Do not analyse areas outside this scope.\n`;
    if (activeSectors.length) ctx += `Industry context: ${activeSectors.join(', ')}.\n`;
    if (newsData[co]?.length) ctx += `Recent legal news:\n${newsData[co].map(a => `- ${a.title}`).join('\n')}\n`;
    if (caseData[co]?.length) ctx += `Court cases:\n${caseData[co].map(c => `- ${c.title} (${c.court}, ${c.date}): ${c.snippet}`).join('\n')}\n`;
    if (secData[co]?.length)  ctx += `SEC filings:\n${secData[co].map(s => `- ${s.form} (${s.date}): ${s.company}`).join('\n')}\n`;
    return ctx;
  };

  try {
    const perCompanyResults = await Promise.all(
      researchCompanies.map(co => researchCompareCompanyIntel(apiKey, co, ctxFor(co), activeTopics))
    );
    const resolved = perCompanyResults.filter(Boolean);

    const companiesObj = {};
    for (const r of resolved) companiesObj[r.company] = r.data;

    // Fast Haiku synthesis over the already-gathered per-company findings — no tools
    // needed here, it's reasoning over facts collected above, not researching from
    // scratch, so this stays cheap and quick regardless of how many companies there are.
    const synthesisCtx = `Companies analyzed: ${companies.join(' vs. ')}\n\n` +
      resolved.map(r => `## ${r.company}\nRisk Level: ${r.data.riskLevel || 'Unknown'}\nKey Risks: ${(r.data.keyRisks||[]).join('; ') || 'none found'}\nLegal Advantages: ${(r.data.legalAdvantages||[]).join('; ') || 'none found'}\nRecent Developments: ${(r.data.recentDevelopments||[]).join('; ') || 'none found'}\n`).join('\n');

    const synthesisRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        temperature: 0,
        system: `You are a legal intelligence analyst. Given per-company legal research below, write a comparative competitive analysis strictly within these topic areas: ${activeTopics.length ? activeTopics.join(', ') : 'general legal and regulatory matters'}. Base your analysis only on the findings given — do not invent new facts.
Respond ONLY as valid JSON (no markdown fences): {"summary":"2-3 sentence overview","isCompetitors":true,"industryContext":"what industry/market they compete in","focusAreas":["topic area 1","topic area 2"],"industryTrends":["trend 1","trend 2","trend 3"],"comparativeVerdict":"which company has the stronger position and why","watchlist":["development to watch 1","development 2"]}`,
        messages: [{ role: 'user', content: synthesisCtx || 'No per-company findings were available.' }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!synthesisRes.ok) {
      const errBody = await synthesisRes.text().catch(() => '');
      console.error('compare-companies synthesis error:', synthesisRes.status, errBody);
      return res.status(500).json({ error: 'Comparison synthesis failed.' });
    }
    const synthesisData = await synthesisRes.json();
    const synthesisText = (synthesisData.content || []).map(b => b.text || '').join('').trim();
    const sm = synthesisText.match(/\{[\s\S]*\}/);
    const synthesis = sm ? JSON.parse(sm[0]) : {};

    const analysis = { ...synthesis, companies: companiesObj };
    res.json({ analysis, sources: { news: newsData, cases: caseData, sec: secData } });
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
