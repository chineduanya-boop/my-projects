#!/usr/bin/env node
/**
 * submit-indexnow.js — bulk-submit the site's URLs to IndexNow.
 *
 * One request reaches Bing, Yandex, Seznam, Naver and Yep. Google does not participate;
 * it is covered by the sitemap in Search Console.
 *
 * Reads the live sitemaps rather than the database, so it submits exactly the URL set
 * that is actually published and indexable — the staged rollout, the adult-content
 * rules and the noindex decisions are all already baked into those files.
 *
 *   node submit-indexnow.js                 dry run — shows what would be sent
 *   node submit-indexnow.js --apply         submit everything
 *   node submit-indexnow.js --apply --limit 500
 *   node submit-indexnow.js --only comics   just one sitemap (comics|mature|genres|chapters)
 *
 * Bing's daily URL quota is 10,000 and IndexNow accepts 10,000 per request, so the full
 * ~6,138-URL catalogue goes in a single call.
 */

require('dotenv').config();
const { submitUrls, KEY, SITE } = require('./lib/indexnow');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const APPLY = has('apply');
const LIMIT = parseInt(val('limit', '0'), 10);
const ONLY = val('only', null);

const SITEMAPS = [
  ['comics',   '/sitemap-comics.xml'],
  ['mature',   '/sitemap-mature.xml'],
  ['genres',   '/sitemap-genres.xml'],
  ['chapters', '/sitemap-chapters-1.xml'],
  ['chapters', '/sitemap-chapters-2.xml'],
];

async function urlsFrom(path) {
  const res = await fetch(SITE + path);
  if (!res.ok) { console.warn(`  ${path} -> HTTP ${res.status}, skipped`); return []; }
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
}

(async () => {
  console.log(`\nIndexNow bulk submission`);
  console.log(`  host ${SITE.replace(/^https?:\/\//, '')}`);
  console.log(`  key  ${KEY}`);
  console.log(`  file ${SITE}/${KEY}.txt`);

  // The engines fetch the key file to prove host ownership. If it is not reachable the
  // whole submission fails with 422, so check first rather than guessing afterwards.
  process.stdout.write(`\nverifying key file… `);
  try {
    const res = await fetch(`${SITE}/${KEY}.txt`);
    const body = (await res.text()).trim();
    if (!res.ok) { console.log(`HTTP ${res.status} — the key file is not reachable.`); process.exit(1); }
    if (body !== KEY) { console.log(`content mismatch.\n  expected ${KEY}\n  got      ${body.slice(0, 60)}`); process.exit(1); }
    console.log('ok');
  } catch (e) { console.log(`failed: ${e.message}`); process.exit(1); }

  console.log(`\ncollecting URLs:`);
  let all = [];
  for (const [name, path] of SITEMAPS) {
    if (ONLY && ONLY !== name) continue;
    const u = await urlsFrom(path);
    console.log(`  ${path.padEnd(26)} ${String(u.length).padStart(5)}`);
    all = all.concat(u);
  }

  all = [...new Set(all)];
  if (LIMIT > 0) all = all.slice(0, LIMIT);
  console.log(`  ${'total (deduplicated)'.padEnd(26)} ${String(all.length).padStart(5)}`);

  if (!all.length) { console.log('\nNothing to submit.\n'); return; }

  if (!APPLY) {
    console.log(`\nsample:`);
    all.slice(0, 5).forEach(u => console.log(`  ${u}`));
    console.log(`  …and ${all.length - 5} more`);
    console.log(`\nDRY RUN — nothing sent. Re-run with --apply.\n`);
    return;
  }

  console.log(`\nsubmitting…`);
  const r = await submitUrls(all, { force: true });
  console.log(
    r.ok
      ? `\nDone — ${r.submitted} URL(s) accepted (HTTP ${r.status}).\n` +
        `Bing, Yandex, Seznam, Naver and Yep have been notified.\n` +
        `Crawling follows on their own schedule; submission is not indexing.\n`
      : `\nPartial or failed — ${r.submitted} of ${all.length} accepted (HTTP ${r.status}).\n`
  );
  process.exit(r.ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
