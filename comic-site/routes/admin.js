const express = require('express');
const router = express.Router();
const db = require('../database/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'temp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp|gif)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// Get all comics
router.get('/comics', (req, res) => {
  try {
    const comics = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) as chapter_count
      FROM comics c ORDER BY c.created_at DESC
    `).all();
    res.json(comics);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create comic
router.post('/comics', upload.single('cover'), (req, res) => {
  try {
    const { title, author, artist, description, genres, status, featured } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    let coverPath = '';
    if (req.file) {
      const dest = path.join(__dirname, '..', 'uploads', 'covers', req.file.filename);
      fs.renameSync(req.file.path, dest);
      coverPath = `/uploads/covers/${req.file.filename}`;
    }

    let parsedGenres = [];
    try { parsedGenres = genres ? JSON.parse(genres) : []; } catch { parsedGenres = []; }

    const result = db.prepare(`
      INSERT INTO comics (title, author, artist, description, cover_image, genres, status, featured)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, author || 'Unknown', artist || author || 'Unknown', description || '', coverPath, JSON.stringify(parsedGenres), status || 'Ongoing', featured ? 1 : 0);

    res.json({ id: result.lastInsertRowid, message: 'Comic created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update comic
router.put('/comics/:id', upload.single('cover'), (req, res) => {
  try {
    const comic = db.prepare('SELECT * FROM comics WHERE id = ?').get(req.params.id);
    if (!comic) return res.status(404).json({ error: 'Not found' });
    const { title, author, artist, description, genres, status, featured } = req.body;

    let coverPath = comic.cover_image;
    if (req.file) {
      const dest = path.join(__dirname, '..', 'uploads', 'covers', req.file.filename);
      fs.renameSync(req.file.path, dest);
      coverPath = `/uploads/covers/${req.file.filename}`;
    }

    let parsedGenres = JSON.parse(comic.genres);
    try { if (genres) parsedGenres = JSON.parse(genres); } catch {}

    db.prepare(`UPDATE comics SET title=?,author=?,artist=?,description=?,cover_image=?,genres=?,status=?,featured=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(title || comic.title, author || comic.author, artist || comic.artist, description !== undefined ? description : comic.description, coverPath, JSON.stringify(parsedGenres), status || comic.status, featured !== undefined ? (featured ? 1 : 0) : comic.featured, req.params.id);

    res.json({ message: 'Comic updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete comic
router.delete('/comics/:id', (req, res) => {
  try {
    if (!db.prepare('SELECT id FROM comics WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM comics WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add chapter
router.post('/comics/:id/chapters', upload.array('pages', 300), (req, res) => {
  try {
    const { chapter_number, title } = req.body;
    if (!chapter_number) return res.status(400).json({ error: 'Chapter number required' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No pages uploaded' });
    if (!db.prepare('SELECT id FROM comics WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Comic not found' });

    const chapterDir = path.join(__dirname, '..', 'uploads', 'comics', `c${req.params.id}`, `ch${chapter_number}`);
    fs.mkdirSync(chapterDir, { recursive: true });

    const chResult = db.prepare('INSERT INTO chapters (comic_id, chapter_number, title) VALUES (?,?,?)').run(req.params.id, parseFloat(chapter_number), title || `Chapter ${chapter_number}`);
    const chapterId = chResult.lastInsertRowid;

    const insertPage = db.prepare('INSERT INTO pages (chapter_id, page_number, image_path) VALUES (?,?,?)');
    const sorted = [...req.files].sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true }));

    sorted.forEach((file, i) => {
      const dest = path.join(chapterDir, file.filename);
      fs.renameSync(file.path, dest);
      insertPage.run(chapterId, i + 1, `/uploads/comics/c${req.params.id}/ch${chapter_number}/${file.filename}`);
    });

    db.prepare('UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ id: chapterId, message: `Chapter ${chapter_number} added with ${req.files.length} pages` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete chapter
router.delete('/chapters/:id', (req, res) => {
  try {
    if (!db.prepare('SELECT id FROM chapters WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM chapters WHERE id = ?').run(req.params.id);
    res.json({ message: 'Chapter deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
