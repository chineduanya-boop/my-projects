#!/usr/bin/env node
/**
 * seo-rollout.js — controls which comics expose indexable chapter pages.
 *
 * Chapter pages always render; the seo_indexed flag decides whether they carry
 * `index, follow` and appear in sitemap-chapters-*.xml. Rolling out in stages lets
 * you confirm Google is indexing and ranking a first batch before committing the
 * whole 10,000-page long tail to the crawl budget.
 *
 *   node seo-rollout.js --status          show current rollout state
 *   node seo-rollout.js --top 20          index the 20 comics with the most chapters
 *   node seo-rollout.js --on <slug>...    index specific comics
 *   node seo-rollout.js --off <slug>...   pull comics back out of the index
 *   node seo-rollout.js --all             index everything (final stage)
 *
 * Adult titles are never flagged by --top or --all, and are excluded from every
 * server-rendered surface regardless of this flag. Indexing them risks Google
 * classifying the whole domain as adult in SafeSearch, which would suppress the
 * clean titles too.
 */
require('dotenv').config();
const { pool } = require('./database/db');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valuesAfter = (flag) => {
  const i = argv.indexOf(flag);
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
};

async function status() {
  const { rows } = await pool.query(`
    SELECT c.slug, c.title, c.seo_indexed, c.is_adult, c.views,
           (SELECT COUNT(DISTINCT chapter_number) FROM chapters WHERE comic_id = c.id) AS chapters
    FROM comics c ORDER BY c.seo_indexed DESC, chapters DESC`);

  const on = rows.filter(r => r.seo_indexed === 1);
  const off = rows.filter(r => r.seo_indexed !== 1);
  const sum = (rs) => rs.reduce((n, r) => n + parseInt(r.chapters, 10), 0);

  console.log(`\nINDEXED (${on.length} comics, ${sum(on).toLocaleString()} chapter URLs)`);
  on.forEach(r => console.log(`  ${String(r.chapters).padStart(4)} ch  ${r.slug}`));

  console.log(`\nNOT INDEXED (${off.length} comics, ${sum(off).toLocaleString()} chapter URLs held back)`);
  off.slice(0, 15).forEach(r => console.log(`  ${String(r.chapters).padStart(4)} ch  ${r.slug}${r.is_adult ? '  [adult]' : ''}`));
  if (off.length > 15) console.log(`  … and ${off.length - 15} more`);

  console.log(`\nTotal indexable chapter URLs: ${sum(on).toLocaleString()} of ${sum(rows).toLocaleString()}\n`);
}

async function setFlag(slugs, value) {
  if (!slugs.length) { console.error('No slugs given.'); process.exit(1); }
  const { rowCount, rows } = await pool.query(
    'UPDATE comics SET seo_indexed = $1 WHERE slug = ANY($2::text[]) RETURNING slug',
    [value, slugs]
  );
  const missed = slugs.filter(s => !rows.some(r => r.slug === s));
  console.log(`${value ? 'Indexed' : 'De-indexed'} ${rowCount} comic(s): ${rows.map(r => r.slug).join(', ')}`);
  if (missed.length) console.warn(`Not found: ${missed.join(', ')}`);
}

async function top(n) {
  const { rows } = await pool.query(`
    SELECT slug FROM comics c WHERE c.is_adult = 0
    ORDER BY (SELECT COUNT(DISTINCT chapter_number) FROM chapters WHERE comic_id = c.id) DESC
    LIMIT $1`, [n]);
  await setFlag(rows.map(r => r.slug), 1);
}

(async () => {
  if (has('--status') || argv.length === 0) await status();
  else if (has('--top'))  { await top(parseInt(valuesAfter('--top')[0] || '20', 10)); await status(); }
  else if (has('--all'))  { const { rowCount } = await pool.query('UPDATE comics SET seo_indexed = 1 WHERE is_adult = 0'); console.log(`Indexed all ${rowCount} non-adult comics.`); await status(); }
  else if (has('--on'))   { await setFlag(valuesAfter('--on'), 1); }
  else if (has('--off'))  { await setFlag(valuesAfter('--off'), 0); }
  else console.error('Unknown flag. See the header of this file for usage.');

  console.log('Note: sitemaps are cached for 1 hour — redeploy or wait for the TTL to see changes live.');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
