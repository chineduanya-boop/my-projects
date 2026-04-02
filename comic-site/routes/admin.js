const express = require('express');
const router = express.Router();
const { pool, slugify } = require('../database/db');
const { bustCache } = require('./comics');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const path = require('path');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const fileFilter = (req, file, cb) => {
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(file.originalname)) cb(null, true);
  else cb(new Error('Only image files allowed'));
};

const uploadCover = multer({
  storage: multerS3({
    s3,
    bucket: process.env.R2_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => cb(null, `covers/${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
});

const uploadPages = multer({
  storage: multerS3({
    s3,
    bucket: process.env.R2_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => cb(null, `pages/${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter,
});

const uploadPdf = multer({
  storage: multerS3({
    s3,
    bucket: process.env.R2_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => cb(null, `pdfs/${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.pdf$/i.test(file.originalname) || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  },
});

const publicUrl = (key) => `${process.env.R2_PUBLIC_URL}/${key}`;

// Get all comics
router.get('/comics', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count
      FROM comics c ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create comic
router.post('/comics', uploadCover.single('cover'), async (req, res) => {
  try {
    const { title, author, artist, description, genres, status, featured } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const coverImage = req.file ? publicUrl(req.file.key) : '';
    let parsedGenres = [];
    try { parsedGenres = genres ? JSON.parse(genres) : []; } catch {}

    // Generate a unique slug from the title
    let slug = slugify(title);
    const existing = await pool.query('SELECT id FROM comics WHERE slug = $1', [slug]);
    if (existing.rows.length) slug = `${slug}-${Date.now()}`;

    const { rows } = await pool.query(`
      INSERT INTO comics (title, author, artist, description, cover_image, genres, status, featured, slug)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [title, author || 'Unknown', artist || author || 'Unknown', description || '', coverImage, JSON.stringify(parsedGenres), status || 'Ongoing', featured ? 1 : 0, slug]);

    bustCache();
    res.json({ id: rows[0].id, message: 'Comic created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update comic
router.put('/comics/:id', uploadCover.single('cover'), async (req, res) => {
  try {
    const comicRes = await pool.query('SELECT * FROM comics WHERE id = $1', [req.params.id]);
    const comic = comicRes.rows[0];
    if (!comic) return res.status(404).json({ error: 'Not found' });

    const { title, author, artist, description, genres, status, featured } = req.body;
    const coverImage = req.file ? publicUrl(req.file.key) : comic.cover_image;

    let parsedGenres = JSON.parse(comic.genres);
    try { if (genres) parsedGenres = JSON.parse(genres); } catch {}

    await pool.query(`
      UPDATE comics SET title=$1,author=$2,artist=$3,description=$4,cover_image=$5,genres=$6,status=$7,featured=$8,updated_at=CURRENT_TIMESTAMP
      WHERE id=$9
    `, [title || comic.title, author || comic.author, artist || comic.artist, description !== undefined ? description : comic.description, coverImage, JSON.stringify(parsedGenres), status || comic.status, featured !== undefined ? (featured ? 1 : 0) : comic.featured, req.params.id]);

    bustCache();
    res.json({ message: 'Comic updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete comic
router.delete('/comics/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM comics WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM comics WHERE id = $1', [req.params.id]);
    bustCache();
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add chapter — images
router.post('/comics/:id/chapters', uploadPages.array('pages', 300), async (req, res) => {
  const client = await pool.connect();
  try {
    const { chapter_number, title } = req.body;
    if (!chapter_number) return res.status(400).json({ error: 'Chapter number required' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No pages uploaded' });

    const comicRes = await client.query('SELECT id FROM comics WHERE id = $1', [req.params.id]);
    if (!comicRes.rows[0]) return res.status(404).json({ error: 'Comic not found' });

    await client.query('BEGIN');

    const chRes = await client.query(
      'INSERT INTO chapters (comic_id, chapter_number, title) VALUES ($1,$2,$3) RETURNING id',
      [req.params.id, parseFloat(chapter_number), title || `Chapter ${chapter_number}`]
    );
    const chapterId = chRes.rows[0].id;

    const sorted = [...req.files].sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true }));
    for (let i = 0; i < sorted.length; i++) {
      await client.query(
        'INSERT INTO pages (chapter_id, page_number, image_path) VALUES ($1,$2,$3)',
        [chapterId, i + 1, publicUrl(sorted[i].key)]
      );
    }

    await client.query('UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');

    bustCache();
    res.json({ id: chapterId, message: `Chapter ${chapter_number} added with ${req.files.length} pages` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Add chapter — PDF
router.post('/comics/:id/chapters/pdf', uploadPdf.single('pdf'), async (req, res) => {
  try {
    const { chapter_number, title } = req.body;
    if (!chapter_number) return res.status(400).json({ error: 'Chapter number required' });
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const comicRes = await pool.query('SELECT id FROM comics WHERE id = $1', [req.params.id]);
    if (!comicRes.rows[0]) return res.status(404).json({ error: 'Comic not found' });

    const { rows } = await pool.query(
      'INSERT INTO chapters (comic_id, chapter_number, title, pdf_url) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.params.id, parseFloat(chapter_number), title || `Chapter ${chapter_number}`, publicUrl(req.file.key)]
    );

    await pool.query('UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.params.id]);
    bustCache();
    res.json({ id: rows[0].id, message: `Chapter ${chapter_number} added as PDF` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete chapter
router.delete('/chapters/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM chapters WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM chapters WHERE id = $1', [req.params.id]);
    bustCache();
    res.json({ message: 'Chapter deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
