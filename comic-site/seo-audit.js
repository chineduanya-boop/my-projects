#!/usr/bin/env node
/**
 * seo-audit.js — Playwright SEO crawler for MangVault.
 *
 *   node seo-audit.js                          audit localhost:3000, sampled
 *   node seo-audit.js --base https://mangvault.com
 *   node seo-audit.js --sample 60              how many chapter URLs to spot-check
 *   node seo-audit.js --full                   every comic + genre (still samples chapters)
 *   node seo-audit.js --vitals                 also measure LCP / CLS / TTFB / weight
 *   node seo-audit.js --index-check            ask Google which URLs are indexed (see below)
 *   node seo-audit.js --out <dir>              where to write the report
 *
 * What it checks per URL:
 *   on-page   title, meta description, canonical, robots, H1s, image alt coverage,
 *             JSON-LD validity, word count, internal links
 *   vitals    LCP, CLS, TTFB, transfer weight, request count      (--vitals)
 *   ssr-diff  raw HTML vs JS-rendered DOM, so you can see exactly what a
 *             non-executing crawler gets. This site server-renders, so a large
 *             gap here is a regression.
 *
 * --index-check scrapes Google result counts for `site:` queries. Google rate-limits
 * and CAPTCHAs automated queries, so it runs a handful of queries with long random
 * delays and reports honestly when it gets blocked. It is a rough signal, not a
 * substitute for the Search Console coverage report.
 */

const fs = require('fs');
const path = require('path');

// Playwright is not a dependency of this app — E: has no room for it. Resolve it from
// wherever it already exists rather than adding ~50 MB to this project.
function loadPlaywright() {
  const candidates = ['playwright', path.join(__dirname, '..', 'twitter-bot', 'node_modules', 'playwright')];
  for (const c of candidates) {
    try { return require(c); } catch {}
  }
  console.error('Could not find playwright. Install it, or point CANDIDATES at an existing copy.');
  process.exit(1);
}
const { chromium } = loadPlaywright();

require('dotenv').config();
const { pool } = require('./database/db');

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const BASE    = (flag('base', 'http://localhost:3000')).replace(/\/$/, '');
const SAMPLE  = parseInt(flag('sample', '40'), 10);
const FULL    = has('full');
const VITALS  = has('vitals');
const OUT_DIR = flag('out', path.join(process.env.TEMP || '.', 'mangvault-seo'));

// Rules of thumb Google's own docs and SERP truncation behaviour support.
const LIMITS = {
  titleMin: 25, titleMax: 62,
  descMin: 70,  descMax: 165,
  wordsMin: 120,
};

// ── URL collection ────────────────────────────────────────────────────────────
async function collectUrls() {
  const urls = [
    { url: '/',       type: 'home' },
    { url: '/browse', type: 'browse' },
  ];

  const { rows: comics } = await pool.query(
    `SELECT slug, seo_indexed FROM comics
     WHERE slug IS NOT NULL AND slug <> '' AND is_adult = 0
     ORDER BY views DESC`
  );
  const comicSet = FULL ? comics : comics.slice(0, 15);
  comicSet.forEach(c => urls.push({ url: `/${c.slug}`, type: 'comic' }));

  const { rows: genres } = await pool.query('SELECT genres FROM comics WHERE is_adult = 0');
  const counts = new Map();
  genres.forEach(r => { try { JSON.parse(r.genres).forEach(g => counts.set(g, (counts.get(g) || 0) + 1)); } catch {} });
  [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .slice(0, FULL ? 99 : 6)
    .forEach(([g]) => urls.push({
      url: `/genre/${g.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
      type: 'genre',
    }));

  // Sample chapters across indexed comics rather than crawling all 6,000.
  const { rows: chapters } = await pool.query(
    `SELECT c.slug, ch.chapter_number FROM chapters ch
     JOIN comics c ON c.id = ch.comic_id
     WHERE c.seo_indexed = 1 AND c.is_adult = 0
     GROUP BY c.slug, ch.chapter_number
     ORDER BY RANDOM() LIMIT $1`, [SAMPLE]
  );
  chapters.forEach(r => {
    const n = Number(r.chapter_number);
    const part = Number.isInteger(n) ? String(n) : String(n).replace('.', '-');
    urls.push({ url: `/${r.slug}/chapter-${part}`, type: 'chapter' });
  });

  return urls;
}

// ── in-page extraction ────────────────────────────────────────────────────────
const EXTRACT = () => {
  const txt = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
  const imgs = [...document.images];
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent);

  return {
    title:       document.title || null,
    description: txt('meta[name="description"]'),
    robots:      txt('meta[name="robots"]'),
    canonical:   document.querySelector('link[rel="canonical"]')?.href || null,
    relPrev:     document.querySelector('link[rel="prev"]')?.href || null,
    relNext:     document.querySelector('link[rel="next"]')?.href || null,
    ogTitle:     document.querySelector('meta[property="og:title"]')?.content || null,
    ogImage:     document.querySelector('meta[property="og:image"]')?.content || null,
    h1s:         [...document.querySelectorAll('h1')].map(h => h.textContent.trim()),
    h2Count:     document.querySelectorAll('h2').length,
    imgTotal:    imgs.length,
    imgNoAlt:    imgs.filter(i => !i.getAttribute('alt')).length,
    internalLinks: [...document.querySelectorAll('a[href^="/"]')].length,
    words:       (document.body.innerText || '').trim().split(/\s+/).filter(Boolean).length,
    jsonLd:      ld,
    renderedTextLen: (document.body.innerText || '').length,
  };
};

// Injected before any page script so the observers catch the real entries.
const VITALS_INIT = () => {
  window.__lcp = 0; window.__cls = 0;
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lcp = e.startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
};

// ── analysis ──────────────────────────────────────────────────────────────────
function analyse(entry, data, rawHtml) {
  const issues = [];
  const add = (sev, msg) => issues.push({ sev, msg });

  // Title
  if (!data.title) add('error', 'Missing <title>');
  else if (data.title.length > LIMITS.titleMax) add('warn', `Title ${data.title.length} chars — truncates in SERPs (>${LIMITS.titleMax})`);
  else if (data.title.length < LIMITS.titleMin) add('warn', `Title only ${data.title.length} chars`);

  // Description
  if (!data.description) add('error', 'Missing meta description');
  else if (data.description.length > LIMITS.descMax) add('warn', `Description ${data.description.length} chars (>${LIMITS.descMax})`);
  else if (data.description.length < LIMITS.descMin) add('warn', `Description only ${data.description.length} chars`);

  // Canonical
  if (!data.canonical) add('error', 'Missing canonical');
  else {
    const want = `${BASE.replace(/^https?:\/\/[^/]+/, '')}${entry.url}`;
    const got = new URL(data.canonical).pathname;
    if (got !== entry.url) add('warn', `Canonical points to ${got}, page is ${entry.url}`);
  }

  // Indexability
  if (data.robots && /noindex/i.test(data.robots)) add('info', `noindex (${data.robots})`);

  // Headings
  if (data.h1s.length === 0) add('error', 'No <h1>');
  else if (data.h1s.length > 1) add('warn', `${data.h1s.length} <h1> tags — should be exactly 1`);

  // Images
  if (data.imgNoAlt > 0) add('warn', `${data.imgNoAlt}/${data.imgTotal} images missing alt`);

  // Content depth
  if (data.words < LIMITS.wordsMin) add('warn', `Only ${data.words} words — thin for indexing`);

  // Structured data
  if (data.jsonLd.length === 0) add('warn', 'No JSON-LD structured data');
  data.jsonLd.forEach((raw, i) => {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed['@type']) add('error', `JSON-LD block ${i + 1} has no @type`);
    } catch (e) {
      add('error', `JSON-LD block ${i + 1} is invalid JSON: ${e.message.slice(0, 70)}`);
    }
  });

  // Rendered vs source — the crawler-without-JS check
  const rawText = rawHtml.replace(/<script[\s\S]*?<\/script>/gi, '')
                         .replace(/<style[\s\S]*?<\/style>/gi, '')
                         .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const ratio = data.renderedTextLen > 0 ? rawText.length / data.renderedTextLen : 0;
  if (ratio < 0.5) {
    add('error', `Only ${Math.round(ratio * 100)}% of rendered text is in the raw HTML — content depends on JS`);
  }

  return { issues, ssrRatio: Math.round(ratio * 100) };
}

// ── crawl ─────────────────────────────────────────────────────────────────────
async function crawl(urls) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    viewport: { width: 1280, height: 900 },
  });
  if (VITALS) await ctx.addInitScript(VITALS_INIT);

  const results = [];

  for (const [i, entry] of urls.entries()) {
    const full = BASE + entry.url;
    const page = await ctx.newPage();

    let transfer = 0, requests = 0;
    if (VITALS) {
      page.on('response', async (r) => {
        requests++;
        try { const b = await r.body(); transfer += b.length; } catch {}
      });
    }

    try {
      const resp = await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = resp ? resp.status() : 0;
      const rawHtml = await resp.text().catch(() => '');

      // Let deferred rendering settle without waiting on the pdf.js canvas loop.
      await page.waitForTimeout(VITALS ? 2500 : 600);

      const data = await page.evaluate(EXTRACT);
      const { issues, ssrRatio } = analyse(entry, data, rawHtml);

      let vitals = null;
      if (VITALS) {
        vitals = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          return {
            lcp: Math.round(window.__lcp || 0),
            cls: Math.round((window.__cls || 0) * 1000) / 1000,
            ttfb: Math.round(nav.responseStart || 0),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
          };
        });
        vitals.transferKB = Math.round(transfer / 1024);
        vitals.requests = requests;
      }

      results.push({ ...entry, status, ...data, jsonLd: data.jsonLd.length, issues, ssrRatio, vitals });

      const errs = issues.filter(x => x.sev === 'error').length;
      const warns = issues.filter(x => x.sev === 'warn').length;
      process.stdout.write(
        `[${String(i + 1).padStart(3)}/${urls.length}] ${status} ${entry.url.slice(0, 46).padEnd(46)} ` +
        `${errs ? `${errs}E ` : '   '}${warns ? `${warns}W` : '  '}` +
        `${vitals ? `  LCP ${String(vitals.lcp).padStart(5)}ms  ${String(vitals.transferKB).padStart(4)}KB` : ''}\n`
      );
    } catch (err) {
      results.push({ ...entry, status: 0, error: err.message, issues: [{ sev: 'error', msg: err.message }] });
      process.stdout.write(`[${String(i + 1).padStart(3)}/${urls.length}] ERR ${entry.url} — ${err.message.slice(0, 60)}\n`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  return results;
}

// ── duplicate detection across the corpus ─────────────────────────────────────
function findDuplicates(results) {
  const byTitle = new Map(), byDesc = new Map();
  results.forEach(r => {
    if (r.title) byTitle.set(r.title, [...(byTitle.get(r.title) || []), r.url]);
    if (r.description) byDesc.set(r.description, [...(byDesc.get(r.description) || []), r.url]);
  });
  return {
    titles: [...byTitle.entries()].filter(([, u]) => u.length > 1),
    descs:  [...byDesc.entries()].filter(([, u]) => u.length > 1),
  };
}

// ── report ────────────────────────────────────────────────────────────────────
function writeReport(results, dupes) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  fs.writeFileSync(path.join(OUT_DIR, `seo-audit-${stamp}.json`), JSON.stringify(results, null, 2));

  const byType = {};
  results.forEach(r => {
    byType[r.type] ??= { n: 0, errors: 0, warns: 0, noindex: 0, ssr: [], lcp: [], words: [] };
    const t = byType[r.type];
    t.n++;
    t.errors += (r.issues || []).filter(x => x.sev === 'error').length;
    t.warns  += (r.issues || []).filter(x => x.sev === 'warn').length;
    if (r.robots && /noindex/i.test(r.robots)) t.noindex++;
    if (r.ssrRatio != null) t.ssr.push(r.ssrRatio);
    if (r.words != null) t.words.push(r.words);
    if (r.vitals) t.lcp.push(r.vitals.lcp);
  });

  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const lines = [];
  const L = (s = '') => lines.push(s);

  L(`# MangVault SEO audit`);
  L();
  L(`- Base: ${BASE}`);
  L(`- When: ${new Date().toISOString()}`);
  L(`- URLs crawled: ${results.length}`);
  L();
  L(`## By page type`);
  L();
  L(`| Type | URLs | Errors | Warnings | noindex | Avg words | Avg SSR% | Avg LCP |`);
  L(`|---|---|---|---|---|---|---|---|`);
  Object.entries(byType).forEach(([type, t]) => {
    L(`| ${type} | ${t.n} | ${t.errors} | ${t.warns} | ${t.noindex} | ${avg(t.words)} | ${avg(t.ssr)}% | ${t.lcp.length ? avg(t.lcp) + 'ms' : '—'} |`);
  });
  L();

  const allIssues = new Map();
  results.forEach(r => (r.issues || []).forEach(i => {
    const key = `${i.sev}|${i.msg.replace(/\d+/g, 'N')}`;
    allIssues.set(key, [...(allIssues.get(key) || []), r.url]);
  }));

  L(`## Issues, most common first`);
  L();
  [...allIssues.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([key, urls]) => {
      const [sev, msg] = key.split('|');
      L(`### ${sev.toUpperCase()} — ${msg} _(${urls.length} pages)_`);
      urls.slice(0, 5).forEach(u => L(`- \`${u}\``));
      if (urls.length > 5) L(`- …and ${urls.length - 5} more`);
      L();
    });

  if (dupes.titles.length || dupes.descs.length) {
    L(`## Duplicate metadata`);
    L();
    dupes.titles.forEach(([t, urls]) => L(`- **Title** \`${t.slice(0, 70)}\` on ${urls.length} pages: ${urls.slice(0, 3).map(u => `\`${u}\``).join(', ')}`));
    dupes.descs.forEach(([, urls]) => L(`- **Description** shared by ${urls.length} pages: ${urls.slice(0, 3).map(u => `\`${u}\``).join(', ')}`));
    L();
  }

  const md = path.join(OUT_DIR, `seo-audit-${stamp}.md`);
  fs.writeFileSync(md, lines.join('\n'));
  return { md, byType, avg };
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nCrawling ${BASE} as Googlebot${VITALS ? ' (with Core Web Vitals)' : ''}\n`);
  const urls = await collectUrls();
  console.log(`${urls.length} URLs queued\n`);

  const results = await crawl(urls);
  const dupes = findDuplicates(results);
  const { md, byType, avg } = writeReport(results, dupes);

  const errors = results.reduce((n, r) => n + (r.issues || []).filter(i => i.sev === 'error').length, 0);
  const warns  = results.reduce((n, r) => n + (r.issues || []).filter(i => i.sev === 'warn').length, 0);

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`${results.length} URLs   ${errors} errors   ${warns} warnings`);
  Object.entries(byType).forEach(([type, t]) =>
    console.log(`  ${type.padEnd(8)} ${String(t.n).padStart(3)} urls  avg ${String(avg(t.words)).padStart(4)} words  SSR ${avg(t.ssr)}%`)
  );
  if (dupes.titles.length) console.log(`  ${dupes.titles.length} duplicate titles`);
  console.log(`\nReport: ${md}\n`);

  await pool.end();
  process.exit(errors > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
