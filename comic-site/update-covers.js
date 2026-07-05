// Updates cover images for Return of the Mount Hua Sect, Doom Breaker, and Tomb Raider King
require('dotenv').config();
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const COVERS = [
  {
    title: 'Return of the Mount Hua Sect',
    localPath: 'C:/Users/Administrator/Downloads/return-of-the-mount-hua-sect- cover image.webp',
    r2Key: `covers/return-mount-hua-cover-${Date.now()}.webp`,
    contentType: 'image/webp',
  },
  {
    title: 'Doom Breaker',
    localPath: 'C:/Users/Administrator/Downloads/doom breaker.webp',
    r2Key: `covers/doom-breaker-cover-${Date.now() + 1}.webp`,
    contentType: 'image/webp',
  },
  {
    title: 'Tomb Raider King',
    localPath: 'C:/Users/Administrator/Downloads/tomb raider cover image.jpeg',
    r2Key: `covers/tomb-raider-king-cover-${Date.now() + 2}.jpeg`,
    contentType: 'image/jpeg',
  },
];

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

  for (const comic of COVERS) {
    console.log(`Processing: ${comic.title}`);
    const coverUrl = await uploadFile(comic.localPath, comic.r2Key, comic.contentType);
    console.log(`  Uploaded to: ${coverUrl}`);

    const result = await pool.query(
      'UPDATE comics SET cover_image = $1 WHERE title = $2 RETURNING id',
      [coverUrl, comic.title]
    );

    if (result.rowCount === 0) {
      console.log(`  WARNING: No comic found with title "${comic.title}" — skipped DB update.`);
    } else {
      console.log(`  DB updated (ID: ${result.rows[0].id})\n`);
    }
  }

  await pool.end();
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
