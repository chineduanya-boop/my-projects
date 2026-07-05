// Uploads "The Great Mage Returns After 4000 Years" to the live site (R2 + Supabase)
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'D:/The Great Mage Returns After 4000 Years';
const COVER_FILE = 'the-great-mage-returns-after-4000-years-what-are-your-v0-g3kruf0yttyf1.webp';

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

// Handles: "[001] [MW] The Great Mage...pdf" and "[MW] [190] The Great Mage...pdf"
function parseChapterNum(filename) {
  // Match any bracketed number in the filename
  const matches = [...filename.matchAll(/\[(\d+(?:\.\d+)?)\]/g)];
  for (const m of matches) {
    const n = parseFloat(m[1]);
    if (!isNaN(n)) return n;
  }
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
    `covers/great-mage-4000-cover-${Date.now()}.webp`,
    'image/webp'
  );
  console.log(`Cover uploaded: ${coverUrl}\n`);

  // Get or create comic record
  let comicId;
  const existing = await pool.query("SELECT id FROM comics WHERE title = $1", ['The Great Mage Returns After 4000 Years']);
  if (existing.rows.length) {
    comicId = existing.rows[0].id;
    await pool.query('UPDATE comics SET cover_image = $1 WHERE id = $2', [coverUrl, comicId]);
    console.log(`Comic already exists (ID: ${comicId}). Cover updated.`);
  } else {
    const r = await pool.query(`
      INSERT INTO comics (title, author, artist, description, cover_image, status, genres, featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [
      'The Great Mage Returns After 4000 Years',
      'Won Jae-Han',
      'SAN.G',
      'Lucas Trowman was the greatest archmage in history until he was condemned by Demigod to spend eternity losing his mind. But 4,000 years later, he\'s thrust back into this world, into the body of Frei Blake, the weakest, most un-talented student at the prestigious Westroad Academy for mages. After all this time, the world of magic has barely progressed. Could this be the work of Demigod? Determined to find out, Lucas seeks to reach the highest levels of power once again and get his revenge.',
      coverUrl,
      'Hiatus',
      JSON.stringify(['Action', 'Adventure', 'Fantasy', 'Manhwa']),
      0
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
    const r2Key = `pdfs/great-mage-4000-ch${chNum}-${Date.now()}.pdf`;

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
