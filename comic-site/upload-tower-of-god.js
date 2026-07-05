// Uploads "Tower of God" to the live site (R2 + Supabase)
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = 'C:/Users/Administrator/Downloads/Telegram Desktop/Tower of God';
const COVER_FILE = 'ekms8587epfb1.jpg';

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

// Handles all four filename patterns:
//   "Tower Of God - Chapter 0 @Manga_LightN.pdf"     → 0
//   "Tower of God - Chapter 526 @Manga_LightN.pdf"   → 526
//   "Twoer Of God - Chapter 522 @Manga_LightN.pdf"   → 522  (typo)
//   "Tower Of God - 626.pdf"                          → 626
//   "Ch - 597 Tower Of God.pdf"                       → 597
//   "Chapter 627 - Tower Of God.pdf"                  → 627
function parseChapterNum(filename) {
  // "Tower * - Chapter N @..." or "Twoer * - Chapter N @..."
  const m1 = filename.match(/^T(?:ower|woer)\s+[Oo]f\s+God\s+-\s+Chapter\s+(\d+(?:\.\d+)?)/i);
  if (m1) return parseFloat(m1[1]);

  // "Tower Of God - 626.pdf"  (bare number, no "Chapter" keyword)
  const m2 = filename.match(/^Tower\s+[Oo]f\s+God\s+-\s+(\d+(?:\.\d+)?)\s*\.pdf$/i);
  if (m2) return parseFloat(m2[1]);

  // "Ch - 597 Tower Of God.pdf"
  const m3 = filename.match(/^Ch\s*-\s*(\d+(?:\.\d+)?)\s+Tower/i);
  if (m3) return parseFloat(m3[1]);

  // "Chapter 627 - Tower Of God.pdf"
  const m4 = filename.match(/^Chapter\s+(\d+(?:\.\d+)?)\s+-\s+Tower/i);
  if (m4) return parseFloat(m4[1]);

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
    `covers/tower-of-god-cover-${Date.now()}.jpg`,
    'image/jpeg'
  );
  console.log(`Cover uploaded: ${coverUrl}\n`);

  // Get or create comic record
  let comicId;
  const existing = await pool.query("SELECT id FROM comics WHERE title = 'Tower of God'");
  if (existing.rows.length) {
    comicId = existing.rows[0].id;
    await pool.query('UPDATE comics SET cover_image = $1 WHERE id = $2', [coverUrl, comicId]);
    console.log(`Comic already exists (ID: ${comicId}). Cover updated.`);
  } else {
    const r = await pool.query(`
      INSERT INTO comics (title, author, artist, description, cover_image, status, genres, slug, featured)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [
      'Tower of God',
      'SIU',
      'SIU',
      `Bam, who was alone all his life has entered the tower to chase after his only friend, Rachel, but how will he survive without having any special strength or power?\n\n"What do you desire? Money and wealth? Honor and pride? Authority and power? Revenge? Or something that transcends them all? Whatever you desire—it's here."`,
      coverUrl,
      'Releasing',
      JSON.stringify(['Action', 'Adventure', 'Drama', 'Fantasy', 'Mystery', 'Manhwa']),
      'tower-of-god',
      0
    ]);
    comicId = r.rows[0].id;
    console.log(`Created comic with ID: ${comicId}`);
  }

  // Collect all PDFs
  const allFiles = fs.readdirSync(SOURCE_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

  const chapterMap = new Map();
  let unparsed = 0;
  for (const file of allFiles) {
    const num = parseChapterNum(file);
    if (num === null) {
      console.log(`  SKIP (no chapter number): ${file}`);
      unparsed++;
      continue;
    }
    // Keep first match per chapter number (avoids duplicates)
    if (!chapterMap.has(num)) chapterMap.set(num, file);
  }

  const sorted = [...chapterMap.entries()].sort((a, b) => a[0] - b[0]);
  console.log(`\nFound ${sorted.length} unique chapters to upload. (${unparsed} skipped)\n`);

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
    const r2Key = `pdfs/tower-of-god-ch${chNum}-${Date.now()}.pdf`;

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
  console.log(`View at: https://mangvault.com/tower-of-god`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
