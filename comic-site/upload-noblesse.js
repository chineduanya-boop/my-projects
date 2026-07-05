// Uploads "Noblesse" to the live site (R2 + Supabase)
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'C:/Users/Administrator/Downloads/Telegram Desktop/Noblesse';
const EXTRA_DIR = 'C:/Users/Administrator/Downloads/Telegram Desktop';
const COVER_FILE = '81kQYq6T2CL._SL1500_.jpg';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function parseChapterNum(filename) {
  const m = filename.match(/^Ch\s*-\s*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  return null;
}

async function uploadFile(localPath, key, contentType) {
  const buffer = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

async function main() {
  console.log('Connecting to database...');
  await pool.query('SELECT 1');
  console.log('Connected.\n');

  // Upload cover image
  const coverPath = path.join(SOURCE_DIR, COVER_FILE);
  console.log('Uploading cover image...');
  const coverUrl = await uploadFile(
    coverPath,
    `covers/noblesse-cover-${Date.now()}.jpg`,
    'image/jpeg'
  );
  console.log(`Cover uploaded: ${coverUrl}\n`);

  // Get or create comic record
  let comicId;
  const existing = await pool.query(
    "SELECT id FROM comics WHERE title = 'Noblesse'"
  );
  if (existing.rows.length) {
    comicId = existing.rows[0].id;
    await pool.query('UPDATE comics SET cover_image = $1 WHERE id = $2', [coverUrl, comicId]);
    console.log(`Comic already exists (ID: ${comicId}). Cover updated.`);
  } else {
    const r = await pool.query(`
      INSERT INTO comics (title, author, artist, description, cover_image, status, genres, featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [
      'Noblesse',
      'Son Jeho',
      'Lee Kwangsu',
      'For 820 years he had slumbered with no knowledge of mankind\'s advancement and scientific progress. The land which he once knew has become an unfamiliar place with new technology, attitudes, and lifestyles. Upon awakening, Cadis Etrama Di Raizel (aka Rai), seeks to familiarize himself with this era.',
      coverUrl,
      'Completed',
      JSON.stringify(['Action', 'Supernatural', 'Manhwa']),
      0
    ]);
    comicId = r.rows[0].id;
    console.log(`Created comic with ID: ${comicId}`);
  }

  // Collect all PDFs from main dir
  const allFiles = fs.readdirSync(SOURCE_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

  const chapterMap = new Map();
  for (const file of allFiles) {
    const num = parseChapterNum(file);
    if (num === null) { console.log(`  SKIP (no chapter number): ${file}`); continue; }
    if (!chapterMap.has(num)) chapterMap.set(num, { file, dir: SOURCE_DIR });
  }

  // Pick up missing chapters from parent directory
  const extraFiles = fs.readdirSync(EXTRA_DIR).filter(f => f.toLowerCase().endsWith('.pdf') && /noblesse/i.test(f));
  for (const file of extraFiles) {
    const num = parseChapterNum(file);
    if (num === null) continue;
    if (!chapterMap.has(num)) {
      chapterMap.set(num, { file, dir: EXTRA_DIR });
      console.log(`  Found extra chapter ${num} in parent folder: ${file}`);
    }
  }

  const sorted = [...chapterMap.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`Found ${sorted.length} chapters to upload.\n`);

  let added = 0, skipped = 0, failed = 0;

  for (const [chNum] of sorted) {
    const exists = await pool.query(
      'SELECT id FROM chapters WHERE comic_id = $1 AND chapter_number = $2',
      [comicId, chNum]
    );
    if (exists.rows.length) {
      console.log(`  SKIP (already in DB): Chapter ${chNum}`);
      skipped++;
      continue;
    }

    const { file, dir } = chapterMap.get(chNum);
    const localPath = path.join(dir, file);
    const r2Key = `pdfs/noblesse-ch${chNum}-${Date.now()}.pdf`;

    try {
      process.stdout.write(`  Uploading Chapter ${chNum}... `);
      const pdfUrl = await uploadFile(localPath, r2Key, 'application/pdf');

      await pool.query(
        'INSERT INTO chapters (comic_id, chapter_number, title, pdf_url) VALUES ($1,$2,$3,$4)',
        [comicId, chNum, `Chapter ${chNum}`, pdfUrl]
      );
      await pool.query('UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [comicId]);

      console.log('done');
      added++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone! Added: ${added}, Skipped: ${skipped}, Failed: ${failed}`);
  console.log(`View at: https://mangvault.com/noblesse`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
