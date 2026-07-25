#!/usr/bin/env node
/**
 * apply-covers.js — upload reviewed cover crops to R2 and repoint the database.
 *
 * The crops are produced separately (scratchpad/covers/crop.js) and reviewed locally
 * before anything runs here. This script only does the upload-and-swap once a human has
 * chosen a level.
 *
 * Why crop at all: adult book pages are indexable so their titles stay findable, but
 * cover artwork is the strongest adult signal a page can emit to an image classifier.
 * max-image-preview:none already keeps these out of search thumbnails; a tighter crop
 * removes the signal at the source.
 *
 *   node apply-covers.js --dir <cropdir> --level medium              dry run
 *   node apply-covers.js --dir <cropdir> --level medium --apply
 *   node apply-covers.js --dir <cropdir> --level tight --only sexual-exploits --apply
 *   node apply-covers.js --restore <backup.json>
 *
 * The old cover URLs are backed up to JSON first. The previous images are left in R2
 * untouched, so --restore is a database-only operation and always works.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./database/db');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const DIR = val('dir');
const LEVEL = val('level', 'medium');
const ONLY = val('only', null);
const APPLY = has('apply');
const RESTORE = val('restore', null);
const BACKUP_DIR = path.join(process.env.TEMP || '.', 'mangvault-cover-backups');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const publicUrl = (key) => `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;

(async () => {
  if (RESTORE) {
    if (!fs.existsSync(RESTORE)) { console.error(`\nBackup not found: ${RESTORE}\n`); process.exit(1); }
    const backup = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
    for (const { slug, cover_image } of backup) {
      await pool.query('UPDATE comics SET cover_image = $1 WHERE slug = $2', [cover_image, slug]);
    }
    console.log(`\nRestored ${backup.length} cover(s) from ${RESTORE}\n`);
    await pool.end();
    return;
  }

  if (!DIR) { console.error('\n--dir is required (the folder holding the crops)\n'); process.exit(1); }
  if (!fs.existsSync(DIR)) { console.error(`\nNot found: ${DIR}\n`); process.exit(1); }

  // Collect <slug>--<level>.jpg files matching the chosen level.
  const files = fs.readdirSync(DIR)
    .filter(f => f.endsWith(`--${LEVEL}.jpg`))
    .map(f => ({ file: f, slug: f.replace(`--${LEVEL}.jpg`, '') }))
    .filter(f => !ONLY || f.slug === ONLY);

  if (!files.length) { console.error(`\nNo "--${LEVEL}.jpg" files in ${DIR}${ONLY ? ` for ${ONLY}` : ''}\n`); process.exit(1); }

  const { rows } = await pool.query(
    'SELECT slug, title, cover_image FROM comics WHERE slug = ANY($1::text[])',
    [files.map(f => f.slug)]
  );
  const bySlug = new Map(rows.map(r => [r.slug, r]));

  console.log(`\nlevel: ${LEVEL}   files: ${files.length}\n`);
  console.log(`${'slug'.padEnd(28)}${'size'.padEnd(10)}current cover`);
  console.log('-'.repeat(84));
  for (const f of files) {
    const rec = bySlug.get(f.slug);
    const kb = Math.round(fs.statSync(path.join(DIR, f.file)).size / 1024);
    console.log(`${f.slug.padEnd(28)}${(kb + ' KB').padEnd(10)}${rec ? rec.cover_image.split('/').pop() : 'NOT IN DB'}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing uploaded. Re-run with --apply.\n`);
    await pool.end();
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `covers-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(
    files.map(f => bySlug.get(f.slug)).filter(Boolean).map(r => ({ slug: r.slug, cover_image: r.cover_image })), null, 2));
  console.log(`\nOld cover URLs backed up to: ${backupPath}`);

  let n = 0;
  for (const f of files) {
    const rec = bySlug.get(f.slug);
    if (!rec) { console.warn(`  skip ${f.slug} — not in database`); continue; }

    // New key each time so CDN caches can never serve the old image at a live URL.
    const key = `covers/${f.slug}-cover-${Date.now()}.jpg`;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: fs.readFileSync(path.join(DIR, f.file)),
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      await pool.query('UPDATE comics SET cover_image = $1 WHERE slug = $2', [publicUrl(key), f.slug]);
      console.log(`  ${f.slug.padEnd(28)} -> ${key}`);
      n++;
    } catch (e) {
      console.error(`  ${f.slug.padEnd(28)} FAILED: ${e.message}`);
    }
  }

  console.log(`\nUpdated ${n} cover(s).`);
  console.log(`Undo with: node apply-covers.js --restore "${backupPath}"`);
  console.log(`The previous images remain in R2, so restoring is database-only.\n`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
