// Uploads "Tomb Raider King" to the live site (R2 + Supabase)
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'C:/Users/Administrator/Downloads/Telegram Desktop/Tomb Raider King';
const COVER_FILE = 'photo_2026-04-05_18-55-47.jpg';

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

// Handles many naming styles found in the folder:
//   "Ch 209.pdf"                    → 209
//   "Ch. 216 - Chapter 216.pdf"     → 216
//   "CH 264 @MANGAMANWHA .pdf"      → 264
//   "CHAPTER 218 @MANGAMANWHA .pdf" → 218
//   "Chapter 363.pdf"               → 363
//   "267 @MANGAMANWHA .pdf"         → 267
function parseChapterNum(filename) {
  // "Ch 209", "Ch. 216", "CH 264", "CHAPTER 218", "Chapter 363"
  const m1 = filename.match(/^Ch(?:apter)?\.?\s*(\d+(?:\.\d+)?)/i);
  if (m1) return parseFloat(m1[1]);
  // "267 @MANGAMANWHA .pdf" — bare number followed by space+@
  const m2 = filename.match(/^(\d+(?:\.\d+)?)\s+@/);
  if (m2) return parseFloat(m2[1]);
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

  const coverPath = path.join(SOURCE_DIR, COVER_FILE);
  console.log('Uploading cover image...');
  const coverUrl = await uploadFile(
    coverPath,
    `covers/tomb-raider-king-cover-${Date.now()}.jpg`,
    'image/jpeg'
  );
  console.log(`Cover uploaded: ${coverUrl}\n`);

  let comicId;
  const existing = await pool.query("SELECT id FROM comics WHERE title = 'Tomb Raider King'");
  if (existing.rows.length) {
    comicId = existing.rows[0].id;
    await pool.query('UPDATE comics SET cover_image = $1 WHERE id = $2', [coverUrl, comicId]);
    console.log(`Comic already exists (ID: ${comicId}). Cover updated.`);
  } else {
    const r = await pool.query(`
      INSERT INTO comics (title, author, artist, description, cover_image, status, genres, featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [
      'Tomb Raider King',
      'Yuns',
      '3B2S',
      'Mysterious tombs appeared all over the world one day, each containing a relic which grants its owner supernatural abilities. Joo-Heon Suh is a tomb explorer, excavator, and raider. Betrayed by his employer, he\'s about to die at the hands of a powerful new relic when he suddenly finds himself 15 years in the past, before any relics or tombs made their debut. Driven by feelings of revenge, how will Joo-Heon use his knowledge of the future to become the Tomb Raider King?',
      coverUrl,
      'Releasing',
      JSON.stringify(['Action', 'Adventure', 'Fantasy', 'Manhwa']),
      0
    ]);
    comicId = r.rows[0].id;
    console.log(`Created comic with ID: ${comicId}`);
  }

  const allFiles = fs.readdirSync(SOURCE_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

  const chapterMap = new Map();
  for (const file of allFiles) {
    const num = parseChapterNum(file);
    if (num === null) { console.log(`  SKIP (no chapter number): ${file}`); continue; }
    if (!chapterMap.has(num)) chapterMap.set(num, file);
  }

  const sorted = [...chapterMap.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`\nFound ${sorted.length} chapters to upload.\n`);

  let added = 0, skipped = 0, failed = 0;

  for (const [chNum, file] of sorted) {
    const exists = await pool.query(
      'SELECT id FROM chapters WHERE comic_id = $1 AND chapter_number = $2',
      [comicId, chNum]
    );
    if (exists.rows.length) {
      console.log(`  SKIP (already in DB): Chapter ${chNum}`);
      skipped++;
      continue;
    }

    const localPath = path.join(SOURCE_DIR, file);
    const r2Key = `pdfs/tomb-raider-king-ch${chNum}-${Date.now()}.pdf`;

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
  console.log(`View at: https://mangvault.com/comic/${comicId}`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
