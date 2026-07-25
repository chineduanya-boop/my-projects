#!/usr/bin/env node
/**
 * dedupe-chapters.js — collapses duplicate chapter rows.
 *
 * Concurrent runs of the upload-*.js scripts inserted the same chapter several times;
 * each attempt uploaded its own PDF to R2, so the rows differ by pdf_url and id but
 * describe one chapter. That breaks the assumption behind /:slug/chapter-:num (one
 * chapter number, one URL) and shows the same chapter repeatedly in the admin panel.
 *
 *   node dedupe-chapters.js              dry run — reports and writes a kill-list, changes nothing
 *   node dedupe-chapters.js --apply      performs the delete and adds a unique index
 *   node dedupe-chapters.js --out <file> where to write the kill-list
 *
 * Keep rule: within each (comic_id, chapter_number) group keep the row with the most
 * views, breaking ties on the lowest id. 73 duplicate rows carry views, so keeping the
 * most-viewed row preserves engagement history rather than discarding it.
 *
 * This never touches R2. Deleted rows leave their PDFs orphaned in the bucket; the
 * script lists those keys so they can be reclaimed separately if you want the space.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./database/db');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const outIdx = argv.indexOf('--out');
const OUT = outIdx !== -1 && argv[outIdx + 1]
  ? argv[outIdx + 1]
  : path.join(process.env.TEMP || '.', 'mangvault-chapter-dupes.txt');

// The survivors: one row per (comic, chapter number).
const KEEPERS = `
  SELECT DISTINCT ON (comic_id, chapter_number) id
  FROM chapters
  ORDER BY comic_id, chapter_number, views DESC, id ASC`;

(async () => {
  const { rows: before } = await pool.query(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT (comic_id, chapter_number)) AS distinct_chapters
    FROM chapters`);
  console.log(`\nchapters table: ${before[0].total} rows, ${before[0].distinct_chapters} distinct (comic, chapter) pairs`);

  // Exactly the rows that would go.
  const { rows: doomed } = await pool.query(`
    SELECT ch.id, c.slug, ch.chapter_number, ch.title, ch.views, ch.created_at, ch.pdf_url
    FROM chapters ch JOIN comics c ON c.id = ch.comic_id
    WHERE ch.id NOT IN (${KEEPERS})
    ORDER BY c.slug, ch.chapter_number, ch.id`);

  if (!doomed.length) {
    console.log('\nNo duplicates found — nothing to do.\n');
    await pool.end();
    return;
  }

  // And what survives in each affected group, so the pairing is auditable.
  const { rows: kept } = await pool.query(`
    SELECT ch.id, c.slug, ch.chapter_number, ch.views
    FROM chapters ch JOIN comics c ON c.id = ch.comic_id
    WHERE ch.id IN (${KEEPERS})
      AND (ch.comic_id, ch.chapter_number) IN (
        SELECT comic_id, chapter_number FROM chapters
        GROUP BY comic_id, chapter_number HAVING COUNT(*) > 1)
    ORDER BY c.slug, ch.chapter_number`);
  const keptBy = new Map(kept.map(k => [`${k.slug}|${k.chapter_number}`, k]));

  // Would deleting these lose any page rows? (All chapters are PDF-based today.)
  const { rows: pageImpact } = await pool.query(`
    SELECT COUNT(*) AS n FROM pages WHERE chapter_id NOT IN (${KEEPERS})`);

  const byComic = new Map();
  doomed.forEach(d => byComic.set(d.slug, (byComic.get(d.slug) || 0) + 1));

  console.log(`\nWould delete ${doomed.length} rows, leaving ${before[0].distinct_chapters}:`);
  [...byComic.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([slug, n]) => console.log(`  ${String(n).padStart(4)}  ${slug}`));

  const viewsLost = doomed.reduce((n, d) => n + d.views, 0);
  console.log(`\n  rows carrying views that would be deleted: ${doomed.filter(d => d.views > 0).length} (${viewsLost} views total)`);
  console.log(`  page rows that would cascade-delete:       ${pageImpact[0].n}`);
  console.log(`  R2 PDFs left orphaned (not deleted):       ${doomed.filter(d => d.pdf_url).length}`);

  // Kill-list
  const lines = [
    `MangVault duplicate chapter kill-list`,
    `generated ${new Date().toISOString()}`,
    `${doomed.length} rows to delete; keep rule = highest views, then lowest id`,
    ``,
    `${'DEL_ID'.padEnd(8)}${'COMIC'.padEnd(42)}${'CH'.padEnd(8)}${'VIEWS'.padEnd(7)}KEPT_ID (its views)`,
    '-'.repeat(100),
  ];
  doomed.forEach(d => {
    const k = keptBy.get(`${d.slug}|${d.chapter_number}`);
    lines.push(
      String(d.id).padEnd(8) +
      d.slug.slice(0, 40).padEnd(42) +
      String(d.chapter_number).padEnd(8) +
      String(d.views).padEnd(7) +
      (k ? `${k.id} (${k.views})` : '?')
    );
  });
  lines.push('', 'Orphaned R2 objects if applied:', ...doomed.filter(d => d.pdf_url).map(d => '  ' + d.pdf_url));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`\nKill-list written to: ${OUT}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing was changed. Re-run with --apply to execute.\n`);
    await pool.end();
    return;
  }

  console.log(`\nApplying…`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(`DELETE FROM chapters WHERE id NOT IN (${KEEPERS})`);
    // Only safe to add once the table is actually unique; this is what stops a repeat.
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_comic_num_uniq
                        ON chapters(comic_id, chapter_number)`);
    await client.query('COMMIT');
    console.log(`Deleted ${rowCount} rows and added the unique index.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`Rolled back — nothing changed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
