// Uploads "The Breaker" to the live site (R2 + Supabase)
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'D:/The Breaker';
const COVER_FILE = 'photo_2022-12-13_05-20-09.jpg';

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

// Handles: "The Breaker CH - 01 @Manga_Gallery.pdf"
function parseChapterNum(filename) {
  const m = filename.match(/CH - (\d+(?:\.\d+)?)/i);
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

  const coverPath = path.join(SOURCE_DIR, COVER_FILE);
  console.log('Uploading cover image...');
  const coverUrl = await uploadFile(
    coverPath,
    `covers/the-breaker-cover-${Date.now()}.jpg`,
    'image/jpeg'
  );
  console.log(`Cover uploaded: ${coverUrl}\n`);

  let comicId;
  const existing = await pool.query("SELECT id FROM comics WHERE title = 'The Breaker'");
  if (existing.rows.length) {
    comicId = existing.rows[0].id;
    await pool.query('UPDATE comics SET cover_image = $1 WHERE id = $2', [coverUrl, comicId]);
    console.log(`Comic already exists (ID: ${comicId}). Cover updated.`);
  } else {
    const r = await pool.query(`
      INSERT INTO comics (title, author, artist, description, cover_image, status, genres, featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [
      'The Breaker',
      'Jeon Geuk-Jin',
      'Park Jin-Hwan',
      'The new English teacher, Chun-Woo, is not your ordinary teacher. Shioon, a victim of constant bullying, unexpectedly witnesses Chun-Woo\'s fighting power, and begs him to make him his disciple. Chun-Woo claims he can teach Shioon only if he is truly determined, and Shioon must jump off a bridge into a deep river in order to prove it! It turns out, however, that Chun-Woo and his powers are more than meets the eye. Shioon makes a grand entrance into the hidden world of martial arts, and he is about to be taught by the best there is!',
      coverUrl,
      'Completed',
      JSON.stringify(['Action', 'Comedy', 'Drama', 'Martial Arts', 'Manhwa']),
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
    const r2Key = `pdfs/the-breaker-ch${chNum}-${Date.now()}.pdf`;

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
  console.log(`View at: https://mangvault.com/the-breaker`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
