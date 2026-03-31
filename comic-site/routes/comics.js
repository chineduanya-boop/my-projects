const express = require('express');
const router = express.Router();
const db = require('../database/db');

router.get('/comics', (req, res) => {
  try {
    const { genre, status, search, sort = 'updated', limit = 24, offset = 0 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (genre) { where += ' AND c.genres LIKE ?'; params.push(`%"${genre}"%`); }
    if (status) { where += ' AND c.status = ?'; params.push(status); }
    if (search) { where += ' AND (c.title LIKE ? OR c.author LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const sortMap = { updated: 'c.updated_at DESC', views: 'c.views DESC', newest: 'c.created_at DESC', title: 'c.title ASC' };
    const orderBy = sortMap[sort] || 'c.updated_at DESC';

    const comics = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) as chapter_count
      FROM comics c ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    const total = db.prepare(`SELECT COUNT(*) as n FROM comics c ${where}`).get(...params).n;
    res.json({ comics, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/featured', (req, res) => {
  try {
    const comics = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) as chapter_count
      FROM comics c WHERE c.featured = 1 ORDER BY c.views DESC LIMIT 6
    `).all();
    res.json(comics);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/popular', (req, res) => {
  try {
    const comics = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) as chapter_count
      FROM comics c ORDER BY c.views DESC LIMIT 12
    `).all();
    res.json(comics);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/new-releases', (req, res) => {
  try {
    const comics = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) as chapter_count,
        (SELECT created_at FROM chapters WHERE comic_id = c.id ORDER BY created_at DESC LIMIT 1) as last_chapter_date
      FROM comics c
      WHERE (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) > 0
      ORDER BY last_chapter_date DESC LIMIT 12
    `).all();
    res.json(comics);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/:id', (req, res) => {
  try {
    const comic = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) as chapter_count
      FROM comics c WHERE c.id = ?
    `).get(req.params.id);
    if (!comic) return res.status(404).json({ error: 'Comic not found' });
    db.prepare('UPDATE comics SET views = views + 1 WHERE id = ?').run(req.params.id);
    res.json(comic);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/:id/chapters', (req, res) => {
  try {
    const chapters = db.prepare(`
      SELECT *, (SELECT COUNT(*) FROM pages WHERE chapter_id = chapters.id) as page_count
      FROM chapters WHERE comic_id = ? ORDER BY chapter_number ASC
    `).all(req.params.id);
    res.json(chapters);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chapters/:id/pages', (req, res) => {
  try {
    const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });
    db.prepare('UPDATE chapters SET views = views + 1 WHERE id = ?').run(req.params.id);
    const pages = db.prepare('SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_number ASC').all(req.params.id);
    const prev = db.prepare('SELECT id FROM chapters WHERE comic_id = ? AND chapter_number < ? ORDER BY chapter_number DESC LIMIT 1').get(chapter.comic_id, chapter.chapter_number);
    const next = db.prepare('SELECT id FROM chapters WHERE comic_id = ? AND chapter_number > ? ORDER BY chapter_number ASC LIMIT 1').get(chapter.comic_id, chapter.chapter_number);
    res.json({ chapter, pages, prevChapter: prev || null, nextChapter: next || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/genres', (req, res) => {
  try {
    const rows = db.prepare('SELECT genres FROM comics').all();
    const set = new Set();
    rows.forEach(r => { try { JSON.parse(r.genres).forEach(g => set.add(g)); } catch {} });
    res.json([...set].sort());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
