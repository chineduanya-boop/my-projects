// Uploads all "My High School Bully" PDFs to the live site (R2 + Supabase)
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'C:/Users/Administrator/Downloads/Telegram Desktop/My High School Bully';

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
});

function parseChapterNum(filename) {
  const m = filename.match(/(?:chapter|ch)[-\s]?(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

async function uploadPdf(localPath, key) {
  const fileBuffer = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: 'application/pdf',
  }));
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

async function main() {
  console.log('Connecting to database...');
  await pool.query('SELECT 1'); // test connection
  console.log('Connected.\n');

  // Get or create the comic
  let comicId;
  const existing = await pool.query("SELECT id FROM comics WHERE title = 'My High School Bully'");
  if (existing.rows.length) {
    comicId = existing.rows[0].id;
    console.log(`Comic already exists with ID: ${comicId}`);
  } else {
    const r = await pool.query(`
      INSERT INTO comics (title, author, artist, description, status, genres, featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [
      'My High School Bully',
      'Yunni & Married',
      'Yunni & Married',
      'A story about a girl who is bullied by the most popular guy in school — but things are not what they seem.',
      'Ongoing',
      JSON.stringify(['Romance', 'Drama', 'Manhwa']),
      1
    ]);
    comicId = r.rows[0].id;
    console.log(`Created comic with ID: ${comicId}`);
  }

  // Get all PDFs, sorted by chapter number
  const allFiles = fs.readdirSync(SOURCE_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

  // Build a map of chapterNum -> first file (skip duplicates like "(2)")
  const chapterMap = new Map();
  for (const file of allFiles) {
    const num = parseChapterNum(file);
    if (!num) { console.log(`  SKIP (no chapter number): ${file}`); continue; }
    if (file.includes('(') ) { console.log(`  SKIP (duplicate): ${file}`); continue; }
    if (!chapterMap.has(num)) chapterMap.set(num, file);
  }

  const sorted = [...chapterMap.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`\nFound ${sorted.length} chapters to upload.\n`);

  let added = 0, skipped = 0, failed = 0;

  for (const [chNum, file] of sorted) {
    // Check if already uploaded
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
    const r2Key = `pdfs/my-high-school-bully-ch${chNum}-${Date.now()}.pdf`;

    try {
      process.stdout.write(`  Uploading Chapter ${chNum}... `);
      const pdfUrl = await uploadPdf(localPath, r2Key);

      await pool.query(
        'INSERT INTO chapters (comic_id, chapter_number, title, pdf_url) VALUES ($1,$2,$3,$4)',
        [comicId, chNum, `Chapter ${chNum}`, pdfUrl]
      );
      await pool.query('UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [comicId]);

      console.log(`done`);
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
