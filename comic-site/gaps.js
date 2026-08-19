#!/usr/bin/env node
/**
 * gaps.js — find content a reader cannot actually read.
 *
 * Two separate problems, both of which look fine in the admin panel:
 *
 *   MISSING CHAPTERS  numbers absent from the sequence. Solo Leveling holds 172
 *                     chapters numbered 0-200, so 29 numbers in that range are gone.
 *                     The book page used to advertise it as complete and readable
 *                     start to finish, which sends the reader to a competitor.
 *
 *   EMPTY CHAPTERS    a chapter row with neither page images nor a pdf_url. The URL
 *                     resolves, the reader gets nothing.
 *
 * Decimal chapters (43.5) are treated as extras, never as filling a gap.
 *
 *   node gaps.js                 both reports, human readable
 *   node gaps.js --list          bare copyable list of missing chapters only
 *   node gaps.js --list --expand every number spelled out instead of 142-175
 *   node gaps.js --adult         include adult titles (excluded by default)
 *   node gaps.js --slug <slug>   one series
 */
require('dotenv').config();
const { pool } = require('./database/db');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const LIST_ONLY = has('list');
const ONE = val('slug', null);

(async () => {
  const where = [];
  if (!has('adult')) where.push('c.is_adult = 0');
  if (ONE) where.push(`c.slug = '${ONE.replace(/'/g, "''")}'`);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows: comics } = await pool.query(
    `SELECT c.id, c.title, c.slug, c.status FROM comics c ${whereSql} ORDER BY c.title ASC`);

  const gapReport = [];
  const emptyReport = [];

  for (const c of comics) {
    const { rows: chs } = await pool.query(
      `SELECT DISTINCT chapter_number FROM chapters WHERE comic_id = $1 ORDER BY chapter_number ASC`,
      [c.id]);
    if (!chs.length) continue;

    const nums = chs.map(r => Number(r.chapter_number));
    const present = new Set(nums);
    const min = Math.ceil(Math.min(...nums));
    const max = Math.floor(Math.max(...nums));

    const missing = [];
    for (let n = min; n <= max; n++) if (!present.has(n)) missing.push(n);
    if (missing.length) {
      gapReport.push({ ...c, total: nums.length, min, max, missing });
    }

    // A chapter with no page rows and no PDF renders nothing.
    const { rows: empties } = await pool.query(
      `SELECT ch.chapter_number
         FROM chapters ch
        WHERE ch.comic_id = $1
          AND (ch.pdf_url IS NULL OR ch.pdf_url = '')
          AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.chapter_id = ch.id)
        ORDER BY ch.chapter_number ASC`, [c.id]);
    if (empties.length) {
      emptyReport.push({ ...c, empty: empties.map(r => Number(r.chapter_number)) });
    }
  }

  // Collapse 5,6,7,8 into 5-8 so a 400-number gap stays readable.
  const ranges = (arr) => {
    const out = [];
    let i = 0;
    while (i < arr.length) {
      let j = i;
      while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
      out.push(i === j ? `${arr[i]}` : `${arr[i]}-${arr[j]}`);
      i = j + 1;
    }
    return out.join(', ');
  };

  if (LIST_ONLY) {
    // --expand spells every number out. Ranges are easier to read, but a flat list is
    // what you want when you are ticking chapters off one at a time.
    const fmt = has('expand') ? (a) => a.join(', ') : ranges;
    gapReport.forEach(g => console.log(`${g.title} (${g.slug}): ${fmt(g.missing)}`));
    console.log(`\n${gapReport.length} series, ${gapReport.reduce((s, g) => s + g.missing.length, 0)} chapters missing`);
    await pool.end();
    return;
  }

  console.log('\n============================================================');
  console.log(' MISSING CHAPTERS');
  console.log('============================================================');
  if (!gapReport.length) console.log('\n  None — every series is contiguous.\n');
  gapReport
    .sort((a, b) => b.missing.length - a.missing.length)
    .forEach(g => {
      console.log(`\n${g.title}  [${g.status}]`);
      console.log(`  /${g.slug}`);
      console.log(`  has ${g.total} chapters, numbered ${g.min}-${g.max} — ${g.missing.length} missing`);
      console.log(`  missing: ${ranges(g.missing)}`);
    });

  console.log('\n\n============================================================');
  console.log(' EMPTY CHAPTERS  (no images and no PDF — URL loads, nothing to read)');
  console.log('============================================================');
  if (!emptyReport.length) console.log('\n  None — every chapter has content.\n');
  emptyReport.forEach(e => {
    console.log(`\n${e.title}`);
    console.log(`  /${e.slug}`);
    console.log(`  ${e.empty.length} empty: ${ranges(e.empty.filter(Number.isInteger))}${
      e.empty.some(n => !Number.isInteger(n)) ? ', ' + e.empty.filter(n => !Number.isInteger(n)).join(', ') : ''}`);
  });

  const totalMissing = gapReport.reduce((s, g) => s + g.missing.length, 0);
  const totalEmpty = emptyReport.reduce((s, e) => s + e.empty.length, 0);
  console.log('\n============================================================');
  console.log(` ${comics.length} series checked`);
  console.log(` ${gapReport.length} with gaps — ${totalMissing} chapters missing`);
  console.log(` ${emptyReport.length} with empty chapters — ${totalEmpty} unreadable`);
  console.log('============================================================\n');

  await pool.end();
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
