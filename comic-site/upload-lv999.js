// Uploads "LV999 no Murabito" to the live site (R2 + Supabase)
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'C:/Users/Administrator/Downloads/Telegram Desktop/LV999';
const COVER_FILE = 'photo_2026-04-04_03-19-47.jpg';

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

// Handles: "Ch - 1", "Ch - 17.5", "Ch - 47.1"
function parseChapterNum(filename) {
  const m = filename.match(/ch\s*-\s*(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
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
    `covers/lv999-cover-${Date.now()}.jpg`,
    'image/jpeg'
  );
  console.log(`Cover uploaded: ${coverUrl}\n`);

  const COMIC_TITLE = 'LV999 no Murabito';
  const DESCRIPTION = 'Also known as: The Villager of Level 999 | Villageois LVL 999\n\nIn this world, the concept of levels exist. Other than those who live off defeating monsters, most people are only around Level 1 to 5. What\'s more, not just anyone can go out to hunt monsters; it\'s heavily influenced by one\'s role appointed by God. There are eight such eligible roles: warriors, fighters, clerics, magicians, rogues, merchants, hunters, and sorcerers. Those blessed with extraordinary power are divided into three types: royalty, heroes, and sages — each with unique abilities beyond the reach of common folk.';
  const GENRES = JSON.stringify(['Action', 'Monsters', 'Magic', 'Romance', 'Martial Arts', 'Slice of Life', 'Comedy', 'Fantasy', 'Adventure', 'Others', 'Drama', 'Harem', 'Manga']);

  // Get or create comic record
  let comicId;
  const existing = await pool.query("SELECT id FROM comics WHERE title = $1", [COMIC_TITLE]);
  if (existing.rows.length) {
    comicId = existing.rows[0].id;
    await pool.query(`
      UPDATE comics
      SET title = $1, description = $2, genres = $3, cover_image = $4, status = 'Ongoing', updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
    `, [COMIC_TITLE, DESCRIPTION, GENRES, coverUrl, comicId]);
    console.log(`Comic updated (ID: ${comicId}).`);
  } else {
    const r = await pool.query(`
      INSERT INTO comics (title, author, artist, description, cover_image, status, genres, featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [
      COMIC_TITLE,
      'Toshimasa Akamatsu',
      'Toshimasa Akamatsu',
      DESCRIPTION,
      coverUrl,
      'Ongoing',
      GENRES,
      1
    ]);
    comicId = r.rows[0].id;
    console.log(`Created comic with ID: ${comicId}`);
  }

  // Collect all PDFs
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
    const r2Key = `pdfs/lv999-ch${chNum}-${Date.now()}.pdf`;

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
