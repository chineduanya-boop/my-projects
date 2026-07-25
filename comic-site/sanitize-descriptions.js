#!/usr/bin/env node
/**
 * sanitize-descriptions.js — rewrites suggestive synopses as neutral plot summaries.
 *
 * Descriptions render inside <meta name="description">, the JSON-LD, and the page body.
 * Even though adult titles are excluded from the home, browse and genre pages, their own
 * book pages ARE indexed (by design — people search these titles by name), so the text
 * on them is read by Google's classifiers. A few synopses leaned on innuendo where a
 * plain plot summary works just as well.
 *
 * TITLES ARE NEVER TOUCHED. They are the search queries that bring readers in;
 * "Sexual Exploits" has to stay "Sexual Exploits" to be findable at all. The mitigation
 * for titles is max-image-preview:none plus a clean description, both already in place.
 *
 *   node sanitize-descriptions.js            dry run — shows a before/after diff
 *   node sanitize-descriptions.js --apply    writes, after backing up the originals
 *   node sanitize-descriptions.js --restore <backup.json>   undo
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./database/db');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const restoreIdx = argv.indexOf('--restore');
const RESTORE = restoreIdx !== -1 ? argv[restoreIdx + 1] : null;
const BACKUP_DIR = path.join(process.env.TEMP || '.', 'mangvault-desc-backups');

// Same story, stated plainly. Each keeps the actual premise so the page still tells a
// reader what the book is about — the point is to drop innuendo, not content.
const REWRITES = {
  'my-secretarys-got-a-secret':
    "Mr. Ju is a demanding executive whose personal life is as chaotic as his office. " +
    "When he discovers his secretary has been hiding something significant, the balance " +
    "of power between them shifts and both are forced to reconsider what they want from " +
    "their careers and each other.",

  'her-nickname-is':
    "Hyunee and Mina appear to be two perfectly ordinary students, but each is hiding a " +
    "side of herself that nobody at school has seen. As their secret slowly comes to " +
    "light, they have to decide how much of themselves they are willing to show.",

  'homestay':
    "After moving into his childhood friend's family home to attend college in the city, " +
    "he discovers she is not the person he remembered. Living under the same roof forces " +
    "both of them to confront how much has changed since they were children.",

  'big-guy':
    "By every outward measure he is the ideal man, yet a long-standing personal insecurity " +
    "has quietly shaped his entire adult life. When circumstances change unexpectedly, he " +
    "has to work out who he is when the thing he blamed for everything is gone.",

  'my-friends-sister':
    "Byung-Tae has quietly cared for Eun-ah since childhood, never acting on it out of " +
    "loyalty to her brother. When he stumbles onto a secret she has been keeping, their " +
    "carefully maintained friendship is put under real strain.",

  'may-i-watch-at-least':
    "Hugh is a mild-mannered man in a marriage that has gone quiet, desperate to reconnect " +
    "with his wife Leila. His attempt to fix things by involving his charismatic boss sets " +
    "off consequences none of them anticipated.",

  'wet-vacations':
    "RJ takes a summer job at his wealthy uncle's villa in Los Angeles, expecting easy money " +
    "and little else. What he finds instead is a household full of tensions, rivalries and " +
    "expectations he is completely unprepared for.",
};

(async () => {
  if (RESTORE) {
    if (!fs.existsSync(RESTORE)) { console.error(`\nBackup not found: ${RESTORE}\n`); process.exit(1); }
    const backup = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
    for (const { slug, description } of backup) {
      await pool.query('UPDATE comics SET description = $1 WHERE slug = $2', [description, slug]);
    }
    console.log(`\nRestored ${backup.length} description(s) from ${RESTORE}\n`);
    await pool.end();
    return;
  }

  const slugs = Object.keys(REWRITES);
  const { rows } = await pool.query(
    'SELECT slug, title, description FROM comics WHERE slug = ANY($1::text[])', [slugs]);

  const missing = slugs.filter(s => !rows.some(r => r.slug === s));
  if (missing.length) console.warn(`\nNot found in DB: ${missing.join(', ')}`);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`${rows.length} description(s) to rewrite — titles are NOT modified`);
  console.log('='.repeat(78));

  for (const r of rows) {
    const next = REWRITES[r.slug];
    console.log(`\n${r.title}  (${r.slug})`);
    console.log(`  BEFORE: ${(r.description || '').replace(/\s+/g, ' ')}`);
    console.log(`  AFTER : ${next}`);
  }

  if (!APPLY) {
    console.log(`\n\nDRY RUN — nothing changed. Re-run with --apply.\n`);
    await pool.end();
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `descriptions-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(rows.map(r => ({ slug: r.slug, description: r.description })), null, 2));
  console.log(`\nOriginals backed up to: ${backupPath}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await client.query('UPDATE comics SET description = $1 WHERE slug = $2', [REWRITES[r.slug], r.slug]);
      n++;
    }
    await client.query('COMMIT');
    console.log(`Rewrote ${n} description(s).`);
    console.log(`Undo with: node sanitize-descriptions.js --restore "${backupPath}"\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`Rolled back — nothing changed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
