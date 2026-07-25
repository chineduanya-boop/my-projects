#!/usr/bin/env node
/**
 * gsc-api.js — Google Search Console via a service account. No browser, no session,
 * no dependencies.
 *
 * Uses Node's built-in crypto to sign the service-account JWT and plain fetch for the
 * API, deliberately avoiding the googleapis package (~50 MB, and E: has ~3 MB free).
 *
 * COMMANDS
 *   node gsc-api.js --sitemaps                 list submitted sitemaps and their status
 *   node gsc-api.js --submit sitemap.xml       submit (or resubmit) a sitemap
 *   node gsc-api.js --inspect <url>            index status for one URL
 *   node gsc-api.js --coverage [--sample 20]   sample live URLs and report index status
 *   node gsc-api.js --performance [--days 28]  clicks / impressions / position
 *
 * SETUP (one time)
 *   1. console.cloud.google.com -> create/pick a project
 *   2. Enable "Google Search Console API"
 *   3. IAM & Admin -> Service Accounts -> Create -> Keys -> Add key -> JSON
 *   4. Save the JSON somewhere outside the repo and point GSC_KEY_FILE at it,
 *      e.g. setx GSC_KEY_FILE "C:\keys\mangvault-gsc.json"
 *   5. IMPORTANT: in Search Console -> Settings -> Users and permissions, add the
 *      service account's client_email as an Owner. Without this every call 403s —
 *      enabling the API is not enough on its own.
 *
 * WHAT THIS CANNOT DO
 *   Google's Indexing API only accepts JobPosting and BroadcastEvent content. There
 *   is no supported API for "please index this page" on an ordinary page, so the
 *   per-URL indexing requests still have to go through the Search Console UI and its
 *   ~10/day cap. Sitemap submission below is the supported bulk path.
 */

const fs = require('fs');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const SITE     = val('site', 'https://mangvault.com/');
const KEY_FILE = val('key', process.env.GSC_KEY_FILE);
const SITE_ENC = encodeURIComponent(SITE);

function die(msg) { console.error(`\n${msg}\n`); process.exit(1); }

function loadKey() {
  if (!KEY_FILE) die('No key file. Set GSC_KEY_FILE or pass --key <path.json>. See the header for setup.');
  if (!fs.existsSync(KEY_FILE)) die(`Key file not found: ${KEY_FILE}`);
  const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  if (!k.client_email || !k.private_key) die('That JSON is not a service-account key (missing client_email / private_key).');
  return k;
}

const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Standard RS256 service-account flow — sign a JWT, trade it for an access token.
async function getToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claim)}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j = await res.json();
  if (!res.ok) die(`Token request failed: ${j.error_description || JSON.stringify(j)}`);
  return j.access_token;
}

async function api(token, url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 403) {
    die(`403 from Google.\nAdd the service account as an Owner in Search Console:\n  Settings -> Users and permissions -> Add user\n\n${text.slice(0, 300)}`);
  }
  if (!res.ok) die(`${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function siteUrls(limit) {
  const xml = await fetch(`${SITE.replace(/\/$/, '')}/sitemap-comics.xml`).then(r => r.text());
  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  return all.slice(0, limit);
}

(async () => {
  const key = loadKey();
  const token = await getToken(key);
  console.log(`\nAuthenticated as ${key.client_email}`);
  console.log(`Property: ${SITE}`);

  if (has('submit')) {
    const feed = val('submit', 'sitemap.xml');
    const feedUrl = feed.startsWith('http') ? feed : `${SITE.replace(/\/$/, '')}/${feed}`;
    await api(token, `https://www.googleapis.com/webmasters/v3/sites/${SITE_ENC}/sitemaps/${encodeURIComponent(feedUrl)}`, 'PUT');
    console.log(`\nSubmitted ${feedUrl}`);
    console.log('Google fetches it asynchronously — re-run --sitemaps in a few minutes for status.\n');
    return;
  }

  if (has('sitemaps')) {
    const r = await api(token, `https://www.googleapis.com/webmasters/v3/sites/${SITE_ENC}/sitemaps`);
    if (!r.sitemap || !r.sitemap.length) {
      console.log('\nNo sitemaps submitted yet. Run: node gsc-api.js --submit sitemap.xml\n');
      return;
    }
    console.log(`\n${r.sitemap.length} sitemap(s):\n`);
    r.sitemap.forEach(s => {
      const submitted = s.lastSubmitted ? s.lastSubmitted.slice(0, 10) : '—';
      const downloaded = s.lastDownloaded ? s.lastDownloaded.slice(0, 10) : 'not yet fetched';
      const counts = (s.contents || []).map(c => `${c.submitted} ${c.type}`).join(', ') || '—';
      console.log(`  ${s.path.replace(SITE.replace(/\/$/, ''), '')}`);
      console.log(`    submitted ${submitted}   fetched ${downloaded}   ${counts}`);
      if (s.errors > 0 || s.warnings > 0) console.log(`    errors ${s.errors}  warnings ${s.warnings}`);
      if (s.isPending) console.log('    still processing');
    });
    console.log('');
    return;
  }

  if (has('inspect') || has('coverage')) {
    const urls = has('inspect')
      ? [val('inspect')]
      : await siteUrls(parseInt(val('sample', '20'), 10));

    const tally = {};
    console.log(`\nInspecting ${urls.length} URL(s) — Google allows ~2000/day:\n`);
    for (const u of urls) {
      const r = await api(token, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', 'POST',
        { inspectionUrl: u, siteUrl: SITE });
      const idx = r.inspectionResult?.indexStatusResult || {};
      const verdict = idx.coverageState || idx.verdict || 'unknown';
      tally[verdict] = (tally[verdict] || 0) + 1;
      console.log(`  ${verdict.padEnd(42)} ${u.replace(SITE.replace(/\/$/, ''), '') || '/'}`);
      await new Promise(r => setTimeout(r, 400));
    }
    console.log('\nSummary:');
    Object.entries(tally).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
    console.log('');
    return;
  }

  if (has('performance')) {
    const days = parseInt(val('days', '28'), 10);
    const end = new Date();
    const start = new Date(Date.now() - days * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);

    const totals = await api(token, `https://www.googleapis.com/webmasters/v3/sites/${SITE_ENC}/searchAnalytics/query`, 'POST',
      { startDate: iso(start), endDate: iso(end), dimensions: [] });
    const t = totals.rows?.[0];
    console.log(`\nLast ${days} days:`);
    if (!t) { console.log('  no data yet — normal for a property with nothing indexed\n'); return; }
    console.log(`  clicks       ${t.clicks}`);
    console.log(`  impressions  ${t.impressions}`);
    console.log(`  CTR          ${(t.ctr * 100).toFixed(2)}%`);
    console.log(`  avg position ${t.position.toFixed(1)}`);

    const pages = await api(token, `https://www.googleapis.com/webmasters/v3/sites/${SITE_ENC}/searchAnalytics/query`, 'POST',
      { startDate: iso(start), endDate: iso(end), dimensions: ['page'], rowLimit: 15 });
    if (pages.rows?.length) {
      console.log(`\n  Top pages by impressions:`);
      pages.rows.forEach(r => console.log(
        `    ${String(r.impressions).padStart(6)} imp  ${String(r.clicks).padStart(4)} clk  pos ${r.position.toFixed(1).padStart(5)}  ${r.keys[0].replace(SITE.replace(/\/$/, ''), '') || '/'}`
      ));
    }
    console.log('');
    return;
  }

  console.log('\nNo command given. Try --sitemaps, --submit sitemap.xml, --coverage, or --performance.\n');
})().catch(e => { console.error(e); process.exit(1); });
