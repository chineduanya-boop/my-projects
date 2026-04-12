require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');
const session = require('express-session');
const { initDb, pool } = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = 'https://mangvault.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mv-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: false },
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/admin/login');
}

// ── Login / Logout ────────────────────────────────────────────────────────────
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.use('/api', require('./routes/comics'));
app.use('/api/admin', requireAdmin, require('./routes/admin'));

// ── Sitemap ───────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, slug, title, cover_image, updated_at FROM comics ORDER BY id');
    const urls = [
      `<url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
      `<url><loc>${SITE_URL}/browse</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
      `<url><loc>${SITE_URL}/browse?sort=views</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`,
      `<url><loc>${SITE_URL}/browse?sort=updated</loc><changefreq>daily</changefreq><priority>0.7</priority></url>`,
      ...rows.map(c => {
        const loc = c.slug ? `${SITE_URL}/${c.slug}` : `${SITE_URL}/comic/${c.id}`;
        const date = c.updated_at ? new Date(c.updated_at).toISOString().split('T')[0] : '';
        const safeTitle = c.title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        const image = c.cover_image
          ? `<image:image><image:loc>${c.cover_image}</image:loc><image:title>${safeTitle}</image:title><image:caption>Read ${safeTitle} free online on MangVault</image:caption></image:image>`
          : '';
        return `<url><loc>${loc}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.8</priority>${image}</url>`;
      }),
    ];
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>`);
  } catch (err) {
    res.status(500).send('Error generating sitemap');
  }
});

// ── Helper: escape HTML attribute values ──────────────────────────────────────
function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Static HTML templates (read once at startup) ──────────────────────────────
const comicHtml  = fs.readFileSync(path.join(__dirname, 'public', 'comic.html'),  'utf8');
const indexHtml  = fs.readFileSync(path.join(__dirname, 'public', 'index.html'),  'utf8');
const browseHtml = fs.readFileSync(path.join(__dirname, 'public', 'browse.html'), 'utf8');

function formatDateSSR(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── SSR helpers: mirror the client-side card/hero builders ────────────────────
function ssrComicCard(c) {
  const cover = c.cover_image
    ? `<img src="${esc(c.cover_image)}" alt="${esc(c.title)}" loading="lazy" />`
    : `<div class="no-cover"><i class="fa fa-book-open"></i><span>No Cover</span></div>`;
  const statusClass = { Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' }[c.status] || 'status-ongoing';
  const url = `/${c.slug || c.id}`;
  return `<a class="comic-card" href="${url}">
      <div class="comic-card-cover">
        ${cover}
        <span class="comic-status-badge ${statusClass}">${esc(c.status || '')}</span>
        <span class="comic-chapters-badge">${c.chapter_count || 0} ch</span>
      </div>
      <div class="comic-card-info">
        <div class="comic-card-title">${esc(c.title)}</div>
        <div class="comic-card-meta">${esc(c.author || 'Unknown')}</div>
      </div>
    </a>`;
}

function ssrRow(comics) {
  return comics.length
    ? comics.map(ssrComicCard).join('')
    : '<p style="color:var(--text3);padding:20px">No comics yet.</p>';
}

function ssrHero(comics) {
  if (!comics.length) return `<div class="hero-empty"><i class="fa fa-book-open"></i><p>No comics yet.</p></div>`;
  const slides = comics.map(c => {
    let genres = [];
    try { genres = JSON.parse(c.genres); } catch {}
    const cover = c.cover_image || '';
    const url = `/${c.slug || c.id}`;
    const coverImg = cover
      ? `<img src="${esc(cover)}" alt="${esc(c.title)}" style="width:100%;aspect-ratio:2/3;object-fit:cover;display:block" />`
      : `<div style="width:100%;aspect-ratio:2/3;background:var(--bg3);border-radius:8px;display:flex;align-items:center;justify-content:center"><i class="fa fa-book" style="color:var(--text3);font-size:32px"></i></div>`;
    return `<div class="hero-slide">
        <div class="hero-slide-bg" style="background-image:url('${esc(cover)}')"></div>
        <div class="hero-slide-inner">
          <div class="hero-cover"><a href="${url}">${coverImg}</a></div>
          <div class="hero-info">
            <div class="hero-genres">${genres.slice(0, 3).map(g => `<span class="hero-genre-tag">${esc(g)}</span>`).join('')}</div>
            <div class="hero-title">${esc(c.title)}</div>
            <div class="hero-meta"><i class="fa fa-user"></i> ${esc(c.author || 'Unknown')} &bull; ${c.chapter_count || 0} Chapters &bull; <i class="fa fa-eye"></i> ${c.views || 0}</div>
            <div class="hero-desc">${esc(c.description || '')}</div>
            <div class="hero-actions">
              <a href="${url}" class="btn-read"><i class="fa fa-book-open"></i> Read Now</a>
              <a href="${url}" class="btn-details">Details</a>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
  const dots = comics.map((_, i) => `<div class="hero-dot${i === 0 ? ' active' : ''}" data-i="${i}"></div>`).join('');
  return `<div class="hero-slider" id="heroSlider">${slides}</div>
    ${comics.length > 1 ? `<div class="hero-dots">${dots}</div>` : ''}`;
}

async function serveComicPage(comic, comicId, req, res) {
  let genres = [];
  try { genres = JSON.parse(comic.genres); } catch {}

  // Count this page view (comic.js skips the API call on SSR pages)
  pool.query('UPDATE comics SET views = views + 1 WHERE id = $1', [comic.id]).catch(() => {});

  // Fetch chapters for SSR — Google needs real content in the initial HTML
  const { rows: chapters } = await pool.query(
    `SELECT *, (SELECT COUNT(*) FROM pages WHERE chapter_id = chapters.id) AS page_count
     FROM chapters WHERE comic_id = $1 ORDER BY chapter_number ASC`,
    [comic.id]
  );

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
    "@type": "ComicSeries",
    "name": "${esc(comic.title)}",
    "alternateName": "${esc(comic.title)}",
    "author": { "@type": "Person", "name": "${esc(comic.author || 'Unknown')}" },
    "description": "${esc(desc)}",
    "genre": ${JSON.stringify(genres)},
    "url": "${canonicalUrl}",
    "mainEntityOfPage": "${canonicalUrl}",
    "publisher": { "@type": "Organization", "name": "MangVault", "url": "${SITE_URL}" }${coverImage ? `,\n    "image": "${esc(coverImage)}"` : ''}
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE_URL}/" },
      { "@type": "ListItem", "position": 2, "name": "Browse", "item": "${SITE_URL}/browse" },
      { "@type": "ListItem", "position": 3, "name": "${esc(comic.title)}", "item": "${canonicalUrl}" }
    ]
  }
  </script>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#e53935" />
  <link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin />
  <script>window.COMIC_ID = ${comicId}; window.COMIC_IS_ADULT = ${comic.is_adult ? 1 : 0}; window.COMIC_SSR = true;</script>`;

  // ── Build SSR body content (mirrors comic.js) so Google sees real content ──
  const statusClass = { Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' }[comic.status] || 'status-ongoing';
  const firstChapter = chapters[0];
  const lastChapter  = chapters[chapters.length - 1];

  const coverHtml = coverImage
    ? `<img src="${esc(coverImage)}" alt="${esc(comic.title)}" />`
    : `<div class="no-cover"><i class="fa fa-book-open fa-3x"></i></div>`;

  const chapterListHtml = chapters.length
    ? [...chapters].reverse().map(ch => `
        <a class="chapter-item" href="/reader/${ch.id}">
          <div class="chapter-item-left">
            <span class="chapter-item-num">Chapter ${ch.chapter_number}${ch.title ? ` - ${esc(ch.title)}` : ''}</span>
            <span class="chapter-item-title">${ch.page_count || 0} pages</span>
          </div>
          <div class="chapter-item-right">
            <span class="chapter-item-date">${formatDateSSR(ch.created_at)}</span>
            <span class="chapter-read-btn"><i class="fa fa-book-open"></i> Read</span>
          </div>
        </a>`).join('')
    : `<div style="color:var(--text3);padding:24px;text-align:center"><i class="fa fa-clock" style="font-size:32px;margin-bottom:12px"></i><p>No chapters uploaded yet.</p></div>`;

  const ssrBody = `
    <div class="comic-detail-hero">
      <div class="comic-detail-cover">${coverHtml}</div>
      <div class="comic-detail-info">
        <h1 class="comic-detail-title">${esc(comic.title)}</h1>
        <div class="comic-detail-meta">
          <span class="comic-meta-item"><i class="fa fa-user"></i> ${esc(comic.author || 'Unknown')}</span>
          <span class="comic-meta-item"><i class="fa fa-pen-nib"></i> ${esc(comic.artist || comic.author || 'Unknown')}</span>
          <span class="comic-meta-item"><span class="comic-status-badge ${statusClass}" style="position:static">${esc(comic.status)}</span></span>
          <span class="comic-meta-item"><i class="fa fa-book"></i> ${chapters.length} Chapters</span>
          <span class="comic-meta-item"><i class="fa fa-eye"></i> ${comic.views || 0} Views</span>
        </div>
        ${genres.length ? `<div class="comic-detail-genres">${genres.map(g => `<a class="detail-genre-tag" href="/browse?genre=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}</div>` : ''}
        <p class="comic-detail-desc">${esc(comic.description || 'No description available.')}</p>
        <div class="comic-detail-actions">
          ${firstChapter ? `<a href="/reader/${firstChapter.id}" class="btn-read"><i class="fa fa-book-open"></i> Read First Chapter</a>` : ''}
          ${lastChapter && lastChapter.id !== (firstChapter && firstChapter.id) ? `<a href="/reader/${lastChapter.id}" class="btn-details"><i class="fa fa-forward"></i> Latest Chapter</a>` : ''}
        </div>
      </div>
    </div>
    <div class="chapters-section">
      <h2><span class="accent-bar"></span> Chapters <span style="font-size:14px;color:var(--text3);font-weight:400">(${chapters.length})</span></h2>
      <div class="chapter-list">${chapterListHtml}</div>
    </div>`;

  const html = comicHtml
    .replace('<title>Comic - MangVault</title>', '')
    .replace('</head>', metaTags + '\n</head>')
    .replace('<div class="detail-loading"><i class="fa fa-spinner fa-spin fa-2x"></i></div>', ssrBody);

  res.send(html);
}

// ── /comic/:id — redirect numeric IDs to slug URL ────────────────────────────
app.get('/comic/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.redirect(301, '/');
    const { rows } = await pool.query(
      'SELECT id, title, description, cover_image, author, genres, slug, is_adult FROM comics WHERE id = $1',
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

// ── Home page — SSR all sections so Google sees real content ──────────────────
app.get('/', async (req, res) => {
  try {
    const cc = `(SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count`;
    const [heroRes, newRelRes, actionRes, romanceRes, fantasyRes, dramaRes, mostViewedRes, popularRes, genreRes] = await Promise.all([
      pool.query(`SELECT c.*, ${cc} FROM comics c ORDER BY c.views DESC LIMIT 6`),
      pool.query(`SELECT c.*, ${cc}, (SELECT created_at FROM chapters WHERE comic_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_chapter_date FROM comics c WHERE (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) > 0 ORDER BY last_chapter_date DESC LIMIT 12`),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Action"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Romance"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Fantasy"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Drama"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c ORDER BY c.views DESC LIMIT 12`),
      pool.query(`SELECT c.*, ${cc} FROM comics c ORDER BY c.views DESC LIMIT 24`),
      pool.query('SELECT genres FROM comics'),
    ]);

    const genreSet = new Set();
    genreRes.rows.forEach(r => { try { JSON.parse(r.genres).forEach(g => genreSet.add(g)); } catch {} });
    const allGenres = [...genreSet].sort();
    const genreTagsHtml = allGenres.length
      ? allGenres.map(g => `<a href="/browse?genre=${encodeURIComponent(g)}" class="genre-tag-btn">${esc(g)}</a>`).join('')
      : '<p style="color:var(--text3)">No genres yet.</p>';

    const html = indexHtml
      .replace('<!--SSR:heroSection-->',    ssrHero(heroRes.rows))
      .replace('<!--SSR:newReleasesRow-->', ssrRow(newRelRes.rows))
      .replace('<!--SSR:actionRow-->',      ssrRow(actionRes.rows))
      .replace('<!--SSR:romanceRow-->',     ssrRow(romanceRes.rows))
      .replace('<!--SSR:fantasyRow-->',     ssrRow(fantasyRes.rows))
      .replace('<!--SSR:dramaRow-->',       ssrRow(dramaRes.rows))
      .replace('<!--SSR:mostViewedRow-->',  ssrRow(mostViewedRes.rows))
      .replace('<!--SSR:popularGrid-->',    ssrRow(popularRes.rows))
      .replace('<!--SSR:genreTags-->',      genreTagsHtml)
      .replace('</body>', '<script>window.HOME_SSR=true;</script>\n</body>');

    res.send(html);
  } catch (err) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ── Browse page — SSR initial grid so Google sees real comic links ─────────────
app.get('/browse', async (req, res) => {
  try {
    const { genre, status, search, sort = 'updated' } = req.query;
    const params = [];
    let p = 1;
    let where = 'WHERE 1=1';
    if (genre)  { where += ` AND c.genres LIKE $${p++}`;                                     params.push(`%"${genre}"%`); }
    if (status) { where += ` AND c.status = $${p++}`;                                        params.push(status); }
    if (search) { where += ` AND (c.title ILIKE $${p} OR c.author ILIKE $${p+1})`; p += 2;  params.push(`%${search}%`, `%${search}%`); }
    const sortMap = { updated: 'c.updated_at DESC', views: 'c.views DESC', newest: 'c.created_at DESC', title: 'c.title ASC' };
    const orderBy = sortMap[sort] || 'c.updated_at DESC';
    const cc = `(SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count`;

    const [comicsRes, countRes] = await Promise.all([
      pool.query(`SELECT c.*, ${cc} FROM comics c ${where} ORDER BY ${orderBy} LIMIT 24 OFFSET 0`, params),
      pool.query(`SELECT COUNT(*) AS n FROM comics c ${where}`, params),
    ]);
    const total = parseInt(countRes.rows[0].n);

    const pageTitle = genre ? genre : search ? `Search: "${search}"` : 'All Comics';
    const countText = `${total} comic${total !== 1 ? 's' : ''} found`;
    const gridHtml  = comicsRes.rows.length ? comicsRes.rows.map(ssrComicCard).join('') : '';

    const html = browseHtml
      .replace('<!--SSR:browseTitle-->', esc(pageTitle))
      .replace('<!--SSR:browseCount-->', esc(countText))
      .replace('<!--SSR:browseGrid-->',  gridHtml)
      .replace('</body>', `<script>window.BROWSE_SSR=true;window.BROWSE_TOTAL=${total};window.BROWSE_LOADED=${comicsRes.rows.length};</script>\n</body>`);

    res.send(html);
  } catch (err) {
    res.sendFile(path.join(__dirname, 'public', 'browse.html'));
  }
});

// ── Other static routes ───────────────────────────────────────────────────────
app.get('/admin',      requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/reader/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));

// ── /:slug — comic pages by name ──────────────────────────────────────────────
app.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, description, cover_image, author, genres, slug, is_adult FROM comics WHERE slug = $1',
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
