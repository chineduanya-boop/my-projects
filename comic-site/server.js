require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');
const { initDb, pool } = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = 'https://mangvault.com';

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use('/api', require('./routes/comics'));
app.use('/api/admin', require('./routes/admin'));

// ── Sitemap ───────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, slug, updated_at FROM comics ORDER BY id');
    const urls = [
      `<url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
      `<url><loc>${SITE_URL}/browse</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
      ...rows.map(c => {
        const loc = c.slug ? `${SITE_URL}/${c.slug}` : `${SITE_URL}/comic/${c.id}`;
        const date = c.updated_at ? new Date(c.updated_at).toISOString().split('T')[0] : '';
        return `<url><loc>${loc}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.8</priority></url>`;
      }),
    ];
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
  } catch (err) {
    res.status(500).send('Error generating sitemap');
  }
});

// ── Helper: escape HTML attribute values ──────────────────────────────────────
function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Helper: build and send comic HTML with injected meta tags ─────────────────
const comicHtml = fs.readFileSync(path.join(__dirname, 'public', 'comic.html'), 'utf8');

async function serveComicPage(comic, comicId, req, res) {
  let genres = [];
  try { genres = JSON.parse(comic.genres); } catch {}

  const slug = comic.slug || comicId;
  const canonicalUrl = `${SITE_URL}/${slug}`;
  const pageTitle = `${comic.title} - Read Free Online | MangVault`;
  const desc = comic.description
    ? comic.description.slice(0, 155) + (comic.description.length > 155 ? '...' : '')
    : `Read ${comic.title} free online on MangVault. ${genres.slice(0, 3).join(', ')} comic.`;
  const coverImage = comic.cover_image || '';

  const metaTags = `
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="keywords" content="${esc([comic.title, comic.author, ...genres, 'read free', 'manga', 'manhua', 'manhwa', 'MangVault'].join(', '))}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta property="og:type" content="book" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:title" content="${esc(pageTitle)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:site_name" content="MangVault" />${coverImage ? `\n  <meta property="og:image" content="${esc(coverImage)}" />` : ''}
  <meta name="twitter:card" content="${coverImage ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${esc(pageTitle)}" />
  <meta name="twitter:description" content="${esc(desc)}" />${coverImage ? `\n  <meta name="twitter:image" content="${esc(coverImage)}" />` : ''}
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Book",
    "name": "${esc(comic.title)}",
    "author": { "@type": "Person", "name": "${esc(comic.author || 'Unknown')}" },
    "description": "${esc(desc)}",
    "genre": ${JSON.stringify(genres)},
    "url": "${canonicalUrl}"${coverImage ? `,\n    "image": "${esc(coverImage)}"` : ''}
  }
  </script>
  <script>window.COMIC_ID = ${comicId};</script>`;

  const html = comicHtml
    .replace('<title>Comic - MangVault</title>', '')
    .replace('</head>', metaTags + '\n</head>');

  res.send(html);
}

// ── /comic/:id — redirect numeric IDs to slug URL ────────────────────────────
app.get('/comic/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.redirect(301, '/');
    const { rows } = await pool.query(
      'SELECT id, title, description, cover_image, author, genres, slug FROM comics WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
    const comic = rows[0];
    if (comic.slug) return res.redirect(301, `/${comic.slug}`);
    // No slug yet — serve page directly
    await serveComicPage(comic, comic.id, req, res);
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'comic.html'));
  }
});

// ── Static routes ─────────────────────────────────────────────────────────────
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/browse',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'browse.html')));
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/reader/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));

// ── /:slug — comic pages by name ──────────────────────────────────────────────
app.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, description, cover_image, author, genres, slug FROM comics WHERE slug = $1',
      [req.params.slug]
    );
    if (!rows[0]) return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
    await serveComicPage(rows[0], rows[0].id, req, res);
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`\n Comic Site running at http://localhost:${PORT}`);
    console.log(` Admin panel: http://localhost:${PORT}/admin\n`);
  }))
  .catch(err => { console.error('Failed to connect to database:', err.message); process.exit(1); });
