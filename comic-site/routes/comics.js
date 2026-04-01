const express = require('express');
const router = express.Router();
const { pool } = require('../database/db');

router.get('/comics', async (req, res) => {
  try {
    const { genre, status, search, sort = 'updated', limit = 24, offset = 0 } = req.query;
    const params = [];
    let p = 1;
    let where = 'WHERE 1=1';

    if (genre)  { where += ` AND c.genres LIKE $${p++}`;                                     params.push(`%"${genre}"%`); }
    if (status) { where += ` AND c.status = $${p++}`;                                        params.push(status); }
    if (search) { where += ` AND (c.title ILIKE $${p} OR c.author ILIKE $${p+1})`; p += 2;  params.push(`%${search}%`, `%${search}%`); }

    const sortMap = { updated: 'c.updated_at DESC', views: 'c.views DESC', newest: 'c.created_at DESC', title: 'c.title ASC' };
    const orderBy = sortMap[sort] || 'c.updated_at DESC';

    const [comicsRes, countRes] = await Promise.all([
      pool.query(`SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count FROM comics c ${where} ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p+1}`, [...params, parseInt(limit), parseInt(offset)]),
      pool.query(`SELECT COUNT(*) AS n FROM comics c ${where}`, params),
    ]);
    res.json({ comics: comicsRes.rows, total: parseInt(countRes.rows[0].n) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/featured', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count
      FROM comics c WHERE c.featured = 1 ORDER BY c.views DESC LIMIT 6
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/popular', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count
      FROM comics c ORDER BY c.views DESC LIMIT 12
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/new-releases', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count,
        (SELECT created_at FROM chapters WHERE comic_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_chapter_date
      FROM comics c
      WHERE (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) > 0
      ORDER BY last_chapter_date DESC LIMIT 12
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count
      FROM comics c WHERE c.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Comic not found' });
    pool.query('UPDATE comics SET views = views + 1 WHERE id = $1', [req.params.id]).catch(() => {});
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/comics/:id/chapters', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *, (SELECT COUNT(*) FROM pages WHERE chapter_id = chapters.id) AS page_count
      FROM chapters WHERE comic_id = $1 ORDER BY chapter_number ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/chapters/:id/pages', async (req, res) => {
  try {
    const chRes = await pool.query('SELECT * FROM chapters WHERE id = $1', [req.params.id]);
    const chapter = chRes.rows[0];
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    pool.query('UPDATE chapters SET views = views + 1 WHERE id = $1', [req.params.id]).catch(() => {});

    const [pagesRes, prevRes, nextRes] = await Promise.all([
      pool.query('SELECT * FROM pages WHERE chapter_id = $1 ORDER BY page_number ASC', [req.params.id]),
      pool.query('SELECT id FROM chapters WHERE comic_id = $1 AND chapter_number < $2 ORDER BY chapter_number DESC LIMIT 1', [chapter.comic_id, chapter.chapter_number]),
      pool.query('SELECT id FROM chapters WHERE comic_id = $1 AND chapter_number > $2 ORDER BY chapter_number ASC LIMIT 1',  [chapter.comic_id, chapter.chapter_number]),
    ]);
    res.json({ chapter, pages: pagesRes.rows, prevChapter: prevRes.rows[0] || null, nextChapter: nextRes.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/genres', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT genres FROM comics');
    const set = new Set();
    rows.forEach(r => { try { JSON.parse(r.genres).forEach(g => set.add(g)); } catch {} });
    res.json([...set].sort());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
