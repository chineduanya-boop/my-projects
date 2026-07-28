require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

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
const IS_PROD = process.env.NODE_ENV === 'production';

// Cloudflare -> Railway -> here, so the socket address is always a proxy. Without this
// req.ip is the proxy for every visitor, which would put all login attempts in one
// rate-limit bucket, and `cookie.secure` would never send a cookie at all because
// express-session cannot see that the original request was HTTPS.
app.set('trust proxy', true);

// ── Credentials ───────────────────────────────────────────────────────────────
// These used to fall back to 'changeme' / 'mv-super-secret-session-key-2024'. If an env
// var ever went missing on Railway the site would keep serving happily with credentials
// that are published in this repo's history — a silent full compromise of the admin panel.
//
// Failing the whole process instead would crash-loop the public site (restartPolicyType is
// ALWAYS), taking down 74 comics because of an admin misconfiguration. So these fail
// *secure* rather than loud: the reader-facing site stays up and only admin login is
// disabled until the environment is fixed.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_LOGIN_ENABLED = ADMIN_PASSWORD.length >= 8 && ADMIN_PASSWORD !== 'changeme';
if (!ADMIN_LOGIN_ENABLED) {
  console.error('[security] ADMIN_PASSWORD is missing, too short, or the known default — '
    + 'admin login is DISABLED until it is set (min 8 chars). The public site is unaffected.');
}

// A predictable session secret lets anyone mint a cookie that passes as an admin session.
// A random one per boot is strictly safer than a published constant: the only cost is that
// existing sessions are invalidated on restart, which for a single admin means re-logging in.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
  console.error('[security] SESSION_SECRET is not set — using a random per-boot secret. '
    + 'Admin sessions will not survive a restart until this is configured.');
}

app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'mv.sid',
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // secure was hardcoded false, so the admin session cookie was allowed to travel over
    // plain HTTP. 'auto' rather than IS_PROD deliberately: .env sets NODE_ENV=production
    // on the dev machine too, so keying off that flag marked the cookie HTTPS-only over
    // local http and locked admin login out of localhost entirely. 'auto' asks the actual
    // request instead — HTTPS in production (via X-Forwarded-Proto, hence `trust proxy`
    // above), plain http on localhost.
    secure: 'auto',
    // Without sameSite the cookie rode along on cross-site requests, making every
    // state-changing admin route (upload, delete) CSRF-able from any page the admin
    // visited while logged in. 'lax' still allows the top-level redirect after login.
    sameSite: 'lax',
  },
}));
// index: false is load-bearing. express.static otherwise answers "/" with the raw
// public/index.html before the SSR route below ever runs, which served Google an
// empty shell â€” no hero, no comic cards, no <h1>.
// maxAge was a flat '1h' for everything. That silently broke deploys: a returning reader
// kept running the previous build's JS/CSS for up to an hour with no way to revalidate,
// because these URLs are unversioned. Split by asset type instead —
//   js/css: revalidate every time. ETag makes the common case a cheap empty 304, and a
//           deploy takes effect on the next navigation instead of an hour later.
//   images/fonts: content-addressed in practice (covers live on R2, these are static
//           chrome), so a long TTL is safe and worth having.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// ── Traffic logging ───────────────────────────────────────────────────────────
// Writes are buffered and flushed as one multi-row INSERT. A per-request INSERT would
// be a second round trip on every page load against a pool capped at 10 clients
// (Supabase session-mode limit), which is what caused EMAXCONNSESSION before.
const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pagespeed|curl|wget|python-requests|axios|monitor|uptime/i;

// Bucket the path so daily aggregates stay readable at 10k+ chapter URLs.
function classifyPath(p) {
  if (p === '/') return 'home';
  if (p === '/browse') return 'browse';
  if (p.startsWith('/genre/')) return 'genre';
  if (/^\/[^/]+\/chapter-/.test(p)) return 'chapter';
  if (/^\/(reader|comic)\//.test(p)) return 'legacy';
  if (/^\/[^/]+$/.test(p)) return 'comic';
  return 'other';
}

let _trafficBuf = [];
const TRAFFIC_MAX_BUF = 200;

async function flushTraffic() {
  if (!_trafficBuf.length) return;
  const batch = _trafficBuf;
  _trafficBuf = [];
  // 5 columns per row -> $1..$5, $6..$10, ...
  const values = batch.map((_, i) =>
    `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ');
  const params = batch.flatMap(r => [r.path, r.kind, r.ref, r.bot, r.at]);
  try {
    await pool.query(
      `INSERT INTO traffic_log (path, kind, referrer_host, is_bot, created_at) VALUES ${values}`,
      params
    );
  } catch (err) {
    // Losing a traffic sample must never affect the response the reader already got.
    console.error('[traffic flush]', err.message);
  }
}

app.use((req, res, next) => {
  // Only page requests. Assets are already answered by express.static above; this
  // skips the API, admin and anything with a file extension.
  if (req.method !== 'GET') return next();
  const p = req.path;
  if (p.startsWith('/api') || p.startsWith('/admin') || p.startsWith('/uploads')
      || p.startsWith('/health') || p.startsWith('/sitemap') || p.includes('.')) return next();

  let ref = '';
  try {
    const r = req.get('referer');
    if (r) {
      const h = new URL(r).hostname.replace(/^www\./, '');
      // Our own pages are navigation, not acquisition — track only external referrers.
      // Compare against the request's own host rather than a hardcoded domain, so
      // localhost self-referrals don't show up as an acquisition source in dev.
      const self = (req.get('host') || '').replace(/^www\./, '').split(':')[0];
      if (h !== self && h !== 'mangvault.com') ref = h.slice(0, 120);
    }
  } catch {}

  _trafficBuf.push({
    path: p.slice(0, 300),
    kind: classifyPath(p),
    ref,
    bot: BOT_RE.test(req.get('user-agent') || '') ? 1 : 0,
    at: new Date(),
  });

  if (_trafficBuf.length >= TRAFFIC_MAX_BUF) flushTraffic();
  next();
});

setInterval(flushTraffic, 30 * 1000).unref();

// Keep the table bounded — six months is plenty to spot a trend.
setInterval(() => {
  pool.query("DELETE FROM traffic_log WHERE created_at < NOW() - INTERVAL '180 days'")
    .catch(err => console.error('[traffic prune]', err.message));
}, 24 * 60 * 60 * 1000).unref();

// Don't drop the tail of the buffer on a Railway redeploy.
process.on('SIGTERM', () => { flushTraffic().finally(() => process.exit(0)); });

// â”€â”€ Auth middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  // originalUrl, not path: this middleware is mounted at /api/admin, and inside a mounted
  // router req.path is relative to the mount point ('/comics'), so it never started with
  // '/api'. Every unauthenticated admin API call was answered with a 302 to the HTML login
  // page, which a fetch() then tried to parse as JSON.
  if (req.originalUrl.startsWith('/api')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/admin/login');
}

// â”€â”€ Login / Logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── Login throttling ──────────────────────────────────────────────────────────
// /admin/login accepted unlimited attempts from the open internet against a single
// password, so the admin panel — which can upload and delete every comic and chapter —
// was brute-forceable at whatever rate an attacker cared to send.
//
// Hand-rolled rather than express-rate-limit because E: has no room to install anything,
// and this is one endpoint. Two independent buckets:
//   per-IP    stops the obvious case.
//   global    stops the same attacker rotating IPs (X-Forwarded-For is spoofable once
//             `trust proxy` is on, so per-IP alone is not a real ceiling).
const LOGIN_MAX_PER_IP = 5;
const LOGIN_MAX_GLOBAL = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const _loginFails = new Map();   // ip -> { n, first }
let _globalFails = { n: 0, first: Date.now() };

// Cloudflare sets CF-Connecting-IP and it is the most trustworthy hop available here.
const clientIp = (req) => req.get('cf-connecting-ip') || req.ip || 'unknown';

function loginBlocked(ip) {
  const now = Date.now();
  if (now - _globalFails.first > LOGIN_WINDOW_MS) _globalFails = { n: 0, first: now };
  if (_globalFails.n >= LOGIN_MAX_GLOBAL) return true;
  const e = _loginFails.get(ip);
  if (!e) return false;
  if (now - e.first > LOGIN_WINDOW_MS) { _loginFails.delete(ip); return false; }
  return e.n >= LOGIN_MAX_PER_IP;
}

function noteLoginFail(ip) {
  const now = Date.now();
  const e = _loginFails.get(ip);
  if (!e || now - e.first > LOGIN_WINDOW_MS) _loginFails.set(ip, { n: 1, first: now });
  else e.n += 1;
  _globalFails.n += 1;
  console.warn(`[security] failed admin login from ${ip} (${_loginFails.get(ip).n}/${LOGIN_MAX_PER_IP})`);
}

// Unbounded otherwise: one entry per attacking IP would sit in memory forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _loginFails) if (now - e.first > LOGIN_WINDOW_MS) _loginFails.delete(ip);
}, LOGIN_WINDOW_MS).unref();

// A plain === leaks the length and returns early on the first differing byte. The signal
// is tiny over a network, but constant-time comparison costs nothing here.
function passwordMatches(supplied) {
  const crypto = require('crypto');
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(ADMIN_PASSWORD, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/admin/login', (req, res) => {
  const ip = clientIp(req);

  if (!ADMIN_LOGIN_ENABLED) {
    console.error('[security] admin login attempt while ADMIN_PASSWORD is unset — rejected.');
    return res.redirect('/admin/login?error=disabled');
  }
  if (loginBlocked(ip)) {
    console.warn(`[security] admin login throttled for ${ip}`);
    // Not res.status(429).redirect() — express's redirect() resets statusCode to 302, so
    // the 429 would be silently discarded. Redirect for the human, and let the log carry
    // the throttle signal.
    return res.redirect('/admin/login?error=throttled');
  }

  if (passwordMatches(req.body.password)) {
    _loginFails.delete(ip);
    // Prevent session fixation: a pre-login cookie must not be the one that ends up
    // carrying admin rights.
    return req.session.regenerate((err) => {
      if (err) { console.error('[security] session regenerate failed', err.message); return res.redirect('/admin/login?error=1'); }
      req.session.isAdmin = true;
      res.redirect('/admin');
    });
  }

  noteLoginFail(ip);
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.use('/api', require('./routes/comics'));
app.use('/api/admin', requireAdmin, require('./routes/admin'));

// â”€â”€ Sitemaps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A sitemap index rather than one flat file: chapter URLs run into five figures and
// a single sitemap is capped at 50,000 URLs / 50 MB. Only comics flagged seo_indexed
// contribute chapter URLs, which is what makes the staged rollout controllable.
const SITEMAP_PAGE_SIZE = 5000;
const SITEMAP_TTL = 60 * 60 * 1000;
const _sitemapCache = new Map();

const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const isoDay = (d) => (d ? new Date(d).toISOString().split('T')[0] : '');

function sendXml(res, key, build) {
  const hit = _sitemapCache.get(key);
  if (hit && Date.now() - hit.ts < SITEMAP_TTL) {
    res.set('Content-Type', 'application/xml');
    return res.send(hit.xml);
  }
  return build().then(xml => {
    _sitemapCache.set(key, { xml, ts: Date.now() });
    res.set('Content-Type', 'application/xml');
    res.send(xml);
  });
}

const urlset = (urls, extraNs = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${extraNs}>\n${urls.join('\n')}\n</urlset>`;

async function countIndexableChapters() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT ch.comic_id, ch.chapter_number FROM chapters ch
       JOIN comics c ON c.id = ch.comic_id
       WHERE c.seo_indexed = 1 AND ${SAFE} AND c.slug IS NOT NULL AND c.slug <> ''
     ) t`
  );
  return parseInt(rows[0].n, 10);
}

app.get('/sitemap.xml', async (req, res) => {
  try {
    await sendXml(res, 'index', async () => {
      const total = await countIndexableChapters();
      const pages = Math.max(1, Math.ceil(total / SITEMAP_PAGE_SIZE));
      const today = isoDay(Date.now());
      const maps = [
        `${SITE_URL}/sitemap-comics.xml`,
        `${SITE_URL}/sitemap-genres.xml`,
        `${SITE_URL}/sitemap-mature.xml`,
        ...Array.from({ length: pages }, (_, i) => `${SITE_URL}/sitemap-chapters-${i + 1}.xml`),
      ];
      return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
        maps.map(m => `<sitemap><loc>${m}</loc><lastmod>${today}</lastmod></sitemap>`).join('\n')
      }\n</sitemapindex>`;
    });
  } catch (err) {
    console.error('[sitemap index]', err.message);
    res.status(500).send('Error generating sitemap');
  }
});

app.get('/sitemap-comics.xml', async (req, res) => {
  try {
    await sendXml(res, 'comics', async () => {
      const { rows } = await pool.query(
        `SELECT slug, title, cover_image, updated_at FROM comics c
         WHERE ${SAFE} AND slug IS NOT NULL AND slug <> '' ORDER BY views DESC`
      );
      const urls = [
        `<url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
        `<url><loc>${SITE_URL}/browse</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
        ...rows.map(c => {
          const date = isoDay(c.updated_at);
          const t = xmlEsc(c.title);
          const image = c.cover_image
            ? `<image:image><image:loc>${xmlEsc(c.cover_image)}</image:loc><image:title>${t}</image:title><image:caption>Read ${t} free online on MangVault</image:caption></image:image>`
            : '';
          // 0.9, above the 0.5 on chapter URLs. Book pages are the proven earners here
          // (/noblesse and /madam rank; no chapter page does) and there are 43 of them
          // against 8,537 chapters, so this is where crawl attention should go. Priority
          // is a weak hint at best — the real weighting is the content on the page — but
          // it should at least point the same direction.
          return `<url><loc>${SITE_URL}/${c.slug}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.9</priority>${image}</url>`;
        }),
      ];
      return urlset(urls, ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    });
  } catch (err) {
    console.error('[sitemap comics]', err.message);
    res.status(500).send('Error generating sitemap');
  }
});

// Adult book URLs live in their own sitemap rather than sitemap-comics.xml. They are
// submitted so the titles stay findable by name, but kept out of the main file so the
// clean catalogue's sitemap carries no adult signal. No cover <image:image> entries
// here â€” that pairs with max-image-preview:none on the pages themselves.
app.get('/sitemap-mature.xml', async (req, res) => {
  try {
    await sendXml(res, 'mature', async () => {
      const { rows } = await pool.query(
        `SELECT slug, updated_at FROM comics
         WHERE is_adult = 1 AND slug IS NOT NULL AND slug <> '' ORDER BY views DESC`
      );
      return urlset(rows.map(c => {
        const date = isoDay(c.updated_at);
        return `<url><loc>${SITE_URL}/${c.slug}</loc>${date ? `<lastmod>${date}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.4</priority></url>`;
      }));
    });
  } catch (err) {
    console.error('[sitemap mature]', err.message);
    res.status(500).send('Error generating sitemap');
  }
});

app.get('/sitemap-genres.xml', async (req, res) => {
  try {
    await sendXml(res, 'genres', async () => {
      const map = await getGenreMap();
      const urls = [...map.entries()]
        .filter(([, g]) => g.count >= GENRE_INDEX_MIN)
        .map(([slug]) => `<url><loc>${SITE_URL}/genre/${slug}</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
      return urlset(urls);
    });
  } catch (err) {
    console.error('[sitemap genres]', err.message);
    res.status(500).send('Error generating sitemap');
  }
});

app.get('/sitemap-chapters-:page.xml', async (req, res) => {
  try {
    const page = parseInt(req.params.page, 10);
    if (!Number.isInteger(page) || page < 1) return send404(res);

    await sendXml(res, `chapters-${page}`, async () => {
      const { rows } = await pool.query(
        `SELECT DISTINCT c.slug, ch.chapter_number, MAX(ch.created_at) AS created_at
         FROM chapters ch JOIN comics c ON c.id = ch.comic_id
         WHERE c.seo_indexed = 1 AND ${SAFE} AND c.slug IS NOT NULL AND c.slug <> ''
         GROUP BY c.slug, ch.chapter_number
         ORDER BY c.slug, ch.chapter_number
         LIMIT $1 OFFSET $2`,
        [SITEMAP_PAGE_SIZE, (page - 1) * SITEMAP_PAGE_SIZE]
      );
      const urls = rows.map(r => {
        const date = isoDay(r.created_at);
        // 0.5, below the 0.9 on book pages — see the note in sitemap-comics.
        return `<url><loc>${SITE_URL}${chapterUrl(r.slug, r.chapter_number)}</loc>${
          date ? `<lastmod>${date}</lastmod>` : ''}<changefreq>monthly</changefreq><priority>0.5</priority></url>`;
      });
      return urlset(urls);
    });
  } catch (err) {
    console.error('[sitemap chapters]', err.message);
    res.status(500).send('Error generating sitemap');
  }
});

// â”€â”€ Helper: escape HTML attribute values â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// JSON-LD lives inside <script>, where the HTML entities esc() emits are not decoded.
// Use JSON.stringify (minus its outer quotes) so schema strings stay literal, and
// neutralise "</script>" so a description can never break out of the block.
function jsonStr(str) {
  return JSON.stringify(String(str == null ? '' : str)).slice(1, -1).replace(/<\//g, '<\\/');
}

const STATUS_CLASS = { Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' };
const statusClassFor = (s) => STATUS_CLASS[s] || 'status-ongoing';

// â”€â”€ Error pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Always noindex â€” soft 404s and indexed error pages are a common crawl-budget sink.
function errorHtml(heading, body = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(heading)} - MangVault</title><meta name="robots" content="noindex, follow" />
<link rel="stylesheet" href="/css/style.css?v=18" /></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center">
<div><h1 style="font-size:28px;margin-bottom:12px">${esc(heading)}</h1>
<p style="color:#9ca3af;margin-bottom:20px">${esc(body)}</p>
<a href="/" style="color:#e63946;font-weight:600">&larr; Back to MangVault</a></div></body></html>`;
}

const send404 = (res) =>
  res.status(404).send(errorHtml('404 - Page Not Found', 'This page does not exist or has been removed.'));

// â”€â”€ SERP-fit helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Google truncates titles around 60 characters and descriptions around 160. Long
// series names ("The Great Mage Returns After 4000 Years") blow past that once a
// suffix is appended, so drop to a shorter suffix instead of cutting the title â€”
// the title is the part carrying the keyword.
const TITLE_MAX = 60;
function fitTitle(core, suffixes) {
  for (const s of suffixes) if ((core + s).length <= TITLE_MAX) return core + s;
  return core + suffixes[suffixes.length - 1];
}

function fitDesc(str, max = 160) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,.;:\s]+$/, '') + 'â€¦';
}

// â”€â”€ Chapter URL helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// chapter_number is REAL: 512 -> "512", 43.5 -> "43-5". A dot is legal in a URL path
// but reads as a file extension to some crawlers and log parsers, so we canonicalise
// to a dash and still accept the dotted form on the way in.
function chapterSlugPart(num) {
  const n = Number(num);
  return Number.isInteger(n) ? String(n) : String(n).replace('.', '-');
}

function parseChapterSlugPart(part) {
  if (!/^\d+(?:[-.]\d+)?$/.test(part)) return null;
  const n = Number(part.replace('-', '.'));
  return Number.isFinite(n) ? n : null;
}

const chapterUrl = (slug, num) => `/${slug}/chapter-${chapterSlugPart(num)}`;

// How many chapters the comic page renders as HTML. Tower of God has 648, which dumped
// 267 KB into every response and left no way to reach chapter 400 but scrolling. The
// remainder ship as a compact JSON payload that comic.js filters and pages. The rendered
// slice stays real <a href>, so crawlable internal linking survives â€” and the
// nearby-chapter block in serveChapterPage already covers deeper discovery.
const SSR_CHAPTERS = 60;

// Upload scripts often set title to a redundant "Chapter 12"; treat that as no title.
const cleanChapterTitle = (ch) =>
  ch.title && !/^chapter\s*[\d.]+$/i.test(ch.title.trim()) ? ch.title : '';

// â”€â”€ Adult content containment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Adult titles are excluded from every server-rendered surface, not just from the
// sitemaps. Their names alone ("Father's Lust", "Sexual Exploits") are enough for
// Google to classify the *containing* page as adult, and the home page, browse grid
// and genre grids are all indexed. Keeping them out of the SSR HTML is what protects
// the 41 clean titles from SafeSearch suppression.
//
// They remain fully reachable: direct URL works, and the API still serves them via
// ?adult=1 / ?adult=all for client-side browsing.
const SAFE = 'c.is_adult = 0';

// â”€â”€ Genre helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const genreSlug = (g) => g.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// A genre needs a real shelf behind it to deserve an indexable landing page;
// below this it is rendered but left noindex so we don't ship thin pages.
const GENRE_INDEX_MIN = 3;

// ── Related series ────────────────────────────────────────────────────────────
// Two problems, one block. Chapter pages average ~207 words, which is thin for the
// 8,537 of them now indexable; and two titles carry 89% of all views, so almost every
// internal link points at the same places.
//
// Ordering by views ASC is deliberate — the point is to give exposure to titles that
// currently have none, not to re-promote Noblesse on 10,000 more pages. Cached per
// comic because this renders on the highest-traffic route on the site.
const _relatedCache = new Map();
const RELATED_TTL = 10 * 60 * 1000;

async function getRelatedComics(comicId, genres, limit = 6) {
  const key = `${comicId}`;
  const hit = _relatedCache.get(key);
  if (hit && Date.now() - hit.ts < RELATED_TTL) return hit.rows;

  const primary = (genres || []).filter(g => g !== 'Manhwa' && g !== 'Manga').slice(0, 3);
  const params = [comicId, limit];
  let genreClause = '';
  if (primary.length) {
    genreClause = 'AND (' + primary.map((_, i) => `c.genres LIKE $${i + 3}`).join(' OR ') + ')';
    primary.forEach(g => params.push(`%"${g}"%`));
  }

  try {
    let { rows } = await pool.query(
      `SELECT c.title, c.slug, c.cover_image, c.views,
              (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count
         FROM comics c
        WHERE ${SAFE} AND c.id <> $1 AND c.slug IS NOT NULL AND c.slug <> ''
          AND (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) > 0
          ${genreClause}
        ORDER BY c.views ASC
        LIMIT $2`, params);
    // A niche-genre title can come back short; top up ignoring genre so the block is
    // never half-empty.
    if (rows.length < limit) {
      const have = new Set(rows.map(r => r.slug));
      const { rows: extra } = await pool.query(
        `SELECT c.title, c.slug, c.cover_image, c.views,
                (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count
           FROM comics c
          WHERE ${SAFE} AND c.id <> $1 AND c.slug IS NOT NULL AND c.slug <> ''
            AND (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) > 0
          ORDER BY c.views ASC LIMIT $2`, [comicId, limit * 3]);
      for (const r of extra) {
        if (rows.length >= limit) break;
        if (!have.has(r.slug)) { rows.push(r); have.add(r.slug); }
      }
    }
    _relatedCache.set(key, { rows, ts: Date.now() });
    return rows;
  } catch (err) {
    console.error('[related]', err.message);
    return [];
  }
}

let _genreMap = null;
let _genreMapTs = 0;
async function getGenreMap() {
  if (_genreMap && Date.now() - _genreMapTs < 5 * 60 * 1000) return _genreMap;
  // Adult titles must not contribute to genre counts, copy or schema â€” those strings
  // render on indexed pages.
  const { rows } = await pool.query('SELECT genres FROM comics c WHERE ' + SAFE);
  const counts = new Map();
  rows.forEach(r => {
    try { JSON.parse(r.genres).forEach(g => counts.set(g, (counts.get(g) || 0) + 1)); } catch {}
  });
  _genreMap = new Map([...counts].map(([name, n]) => [genreSlug(name), { name, count: n }]));
  _genreMapTs = Date.now();
  return _genreMap;
}

// The header genre dropdown used to be built by JS only, so the raw HTML every
// crawler sees contained none of these links. Rendering it server-side puts ~37
// internal links to the genre landing pages on every page of the site.
async function genreNavHtml() {
  const map = await getGenreMap();
  return [...map.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([slug, g]) => `<a href="/genre/${slug}">${esc(g.name)}</a>`)
    .join('');
}

// â”€â”€ Static HTML templates (read once at startup) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const comicHtml  = fs.readFileSync(path.join(__dirname, 'public', 'comic.html'),  'utf8');
const indexHtml  = fs.readFileSync(path.join(__dirname, 'public', 'index.html'),  'utf8');
const browseHtml = fs.readFileSync(path.join(__dirname, 'public', 'browse.html'), 'utf8');

// â”€â”€ Cached most-popular cover (used as OG image fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _popularCover = null;
let _popularCoverTs = 0;
async function getPopularCover() {
  if (_popularCover && Date.now() - _popularCoverTs < 5 * 60 * 1000) return _popularCover;
  const { rows } = await pool.query(
    // Never let an adult cover become the site-wide og:image fallback.
    `SELECT cover_image FROM comics c WHERE ${SAFE} AND cover_image IS NOT NULL AND cover_image <> '' ORDER BY views DESC LIMIT 1`
  );
  _popularCover = rows[0]?.cover_image || '';
  _popularCoverTs = Date.now();
  return _popularCover;
}

function formatDateSSR(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// â”€â”€ SSR helpers: mirror the client-side card/hero builders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ssrComicCard(c) {
  const cover = c.cover_image
    ? `<img src="${esc(c.cover_image)}" alt="${esc(c.title)}" loading="lazy" />`
    : `<div class="no-cover"><i class="fa fa-book-open"></i><span>No Cover</span></div>`;
  const statusClass = statusClassFor(c.status);
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

  // Fetch chapters for SSR â€” Google needs real content in the initial HTML.
  // getChapterList deduplicates, so the page can't list the same chapter four times.
  const chapters = await getChapterList(comic.id);

  const slug = comic.slug || comicId;
  const canonicalUrl = `${SITE_URL}/${slug}`;
  const pageTitle = fitTitle(comic.title, [
    ' - Read Free Online | MangVault', ' - Read Free | MangVault', ' | MangVault', '',
  ]);
  const desc = fitDesc(comic.description
    || `Read ${comic.title} free online on MangVault. ${genres.slice(0, 3).join(', ')} comic.`);
  const coverImage = comic.cover_image || await getPopularCover();

  const metaTags = `
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="keywords" content="${esc([comic.title, comic.author, ...genres, 'read free', 'manga', 'manhua', 'manhwa', 'MangVault'].join(', '))}" />
  <!-- Adult book pages ARE indexable: people search these titles by name, and the
       protection for the clean catalogue comes from keeping them off the home, browse
       and genre pages (the SAFE predicate), not from hiding the book page itself.
       max-image-preview:none is the important part â€” it keeps explicit cover art out
       of search result thumbnails and Google Images, which is the strongest adult
       signal a page can emit. Their chapter pages stay noindex. -->
  <meta name="robots" content="${comic.is_adult ? 'index, follow, max-image-preview:none' : 'index, follow, max-image-preview:large'}" />
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
  <script>
    window.COMIC_ID = ${comicId};
    window.COMIC_SLUG = ${JSON.stringify(slug)};
    window.COMIC_TITLE = ${JSON.stringify(comic.title)};
    window.COMIC_COVER = ${JSON.stringify(coverImage || '')};
    window.COMIC_IS_ADULT = ${comic.is_adult ? 1 : 0};
    window.COMIC_CHAPTER_TOTAL = ${chapters.length};
    window.COMIC_SSR_CHAPTERS = ${SSR_CHAPTERS};
    window.COMIC_SSR = true;
  </script>`;

  // â”€â”€ Build SSR body content (mirrors comic.js) so Google sees real content â”€â”€
  const statusClass = statusClassFor(comic.status);
  const firstChapter = chapters[0];
  const lastChapter  = chapters[chapters.length - 1];

  const coverHtml = coverImage
    ? `<img src="${esc(coverImage)}" alt="${esc(comic.title)}" />`
    : `<div class="no-cover"><i class="fa fa-book-open fa-3x"></i></div>`;

  const newestFirst = [...chapters].reverse();
  const chapterListHtml = chapters.length
    ? newestFirst.slice(0, SSR_CHAPTERS).map(ch => {
        const t = cleanChapterTitle(ch);
        return `
        <a class="chapter-item" href="${chapterUrl(slug, ch.chapter_number)}" data-num="${ch.chapter_number}">
          <div class="chapter-item-left">
            <span class="chapter-item-num">Chapter ${ch.chapter_number}${t ? ` - ${esc(t)}` : ''}</span>
          </div>
          <div class="chapter-item-right">
            <span class="chapter-item-date">${formatDateSSR(ch.created_at)}</span>
            <span class="chapter-read-btn"><i class="fa fa-book-open"></i> Read</span>
          </div>
        </a>`;
      }).join('')
    : `<div style="color:var(--text3);padding:24px;text-align:center"><i class="fa fa-clock" style="font-size:32px;margin-bottom:12px"></i><p>No chapters uploaded yet.</p></div>`;

  // [number, title, dateMs] tuples rather than objects â€” roughly a third of the bytes
  // across 648 chapters, and comic.js expands them on load.
  const chapterData = JSON.stringify(newestFirst.map(ch => [
    Number(ch.chapter_number),
    cleanChapterTitle(ch),
    ch.created_at ? new Date(ch.created_at).getTime() : 0,
  ]));

  const chapterToolbar = chapters.length > SSR_CHAPTERS ? `
      <div class="chapter-tools">
        <div class="chapter-jump-box">
          <i class="fa fa-hashtag"></i>
          <input type="number" id="chapterJump" placeholder="Go to chapterâ€¦" min="1" aria-label="Jump to chapter number" />
        </div>
        <div class="chapter-filter-box">
          <i class="fa fa-magnifying-glass"></i>
          <input type="search" id="chapterFilter" placeholder="Filter chaptersâ€¦" aria-label="Filter chapters" />
        </div>
        <button type="button" id="chapterOrder" class="chapter-order-btn" aria-label="Reverse chapter order">
          <i class="fa fa-arrow-down-wide-short"></i> <span>Newest</span>
        </button>
      </div>` : '';

  // ── Book-page weighting ─────────────────────────────────────────────────────
  // Book pages are where this site actually ranks: /noblesse and /madam appear in
  // Google today, while zero chapter pages do. Chapter pages are ~264 near-identical
  // words each and there are 8,537 of them, which is the pattern Google indexes
  // selectively at best. So the content investment goes here, on the 43 pages that
  // have already proven they can rank, rather than spread across the long tail.
  //
  // Everything below is generated from data we hold — no invented facts — and answers
  // the questions people actually type: how many chapters, is it finished, where do I
  // start, when was it last updated.
  const primaryGenres = genres.filter(g => g !== 'Manhwa' && g !== 'Manga');
  const isComplete = /complete/i.test(comic.status || '');
  const latestDate = chapters.length ? chapters.reduce(
    (a, c) => (c.created_at && (!a || new Date(c.created_at) > new Date(a)) ? c.created_at : a), null) : null;
  const aOrAn = (w) => (/^[aeiou]/i.test(String(w || '')) ? 'an' : 'a');

  // Chapter numbering is not dense: Solo Leveling holds 172 chapters numbered 0â€“200.
  // Quoting the count and the range side by side reads like a contradiction, and worse,
  // announcing a "complete" series as readable start-to-finish when 28 chapters are
  // missing sends the reader straight to a competitor. Detect the gap and say the true
  // thing instead. Tolerance of 1 absorbs half-chapters (43.5) and 0-indexed prologues.
  const span = firstChapter && lastChapter
    ? Number(lastChapter.chapter_number) - Number(firstChapter.chapter_number) + 1 : 0;
  const hasGaps = span - chapters.length > 1;

  const overview = `
    <section class="book-overview">
      <h2><span class="accent-bar"></span> About ${esc(comic.title)}</h2>
      <p>${esc(comic.title)} is ${aOrAn(primaryGenres[0] || (genres.includes('Manhwa') ? 'manhwa' : 'comic'))}${
        primaryGenres.length ? ' ' + esc(primaryGenres.slice(0, 2).join(', ').toLowerCase()) : ''} ${
        esc(genres.includes('Manhwa') ? 'manhwa' : genres.includes('Manga') ? 'manga' : 'comic')
      }${comic.author && comic.author !== 'Unknown' ? ` by ${esc(comic.author)}` : ''}${
        comic.artist && comic.artist !== 'Unknown' && comic.artist !== comic.author ? `, illustrated by ${esc(comic.artist)}` : ''
      }. ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} ${chapters.length === 1 ? 'is' : 'are'} available to read free on MangVault, with no account required${
        isComplete ? ', and the series has finished publishing' : ', and the series is still ongoing'
      }.${latestDate ? ` The most recent chapter here was added on ${formatDateSSR(latestDate)}.` : ''}</p>
      ${primaryGenres.length ? `<p>Readers who enjoy ${esc(primaryGenres.slice(0, 3).join(', '))} titles tend to like this one. You can browse more in ${
        primaryGenres.slice(0, 3).map(g => `<a href="/genre/${genreSlug(g)}">${esc(g)}</a>`).join(', ')
      }.</p>` : ''}
    </section>

    <section class="book-faq">
      <h2><span class="accent-bar"></span> Reading ${esc(comic.title)}</h2>
      <dl>
        <dt>How many chapters does ${esc(comic.title)} have?</dt>
        <dd>${chapters.length} chapter${chapters.length === 1 ? '' : 's'} ${chapters.length === 1 ? 'is' : 'are'} available to read here${
          lastChapter ? `, up to chapter ${lastChapter.chapter_number}` : ''}.${
          hasGaps ? ' Some chapters in that range are not available yet.' : ''}</dd>
        <dt>Is ${esc(comic.title)} finished?</dt>
        <dd>${isComplete
          ? `${esc(comic.title)} has finished publishing${hasGaps
              ? `, and ${chapters.length} of its chapters are available here.`
              : ', so you can read it start to finish here.'}`
          : `Not yet. ${esc(comic.title)} is ongoing, and new chapters are added here as they release.`}</dd>
        <dt>Where should I start?</dt>
        <dd>${firstChapter
          ? `Begin with <a href="${chapterUrl(slug, firstChapter.chapter_number)}">chapter ${firstChapter.chapter_number}</a>. If you are catching up, the <a href="${chapterUrl(slug, lastChapter.chapter_number)}">latest chapter</a> is ${lastChapter.chapter_number}.`
          : 'Chapters are being added — check back shortly.'}</dd>
        <dt>Is it free to read?</dt>
        <dd>Yes. Every chapter of ${esc(comic.title)} is free on MangVault, with no subscription or sign-up.</dd>
      </dl>
    </section>`;

  const bookRelated = await getRelatedComics(comic.id, genres);
  const bookRelatedHtml = bookRelated.length ? `
    <div class="chapters-section related-section">
      <h2><span class="accent-bar"></span> Similar series</h2>
      <p class="related-intro">Free series on MangVault that readers of ${esc(comic.title)} often start next.</p>
      <div class="related-grid">
        ${bookRelated.map(r => `<a class="related-card" href="/${r.slug}">
          ${r.cover_image ? `<img src="${esc(r.cover_image)}" alt="${esc(r.title)} cover" loading="lazy" width="86" height="122" />` : '<span class="related-card-noimg"></span>'}
          <span class="related-card-title">${esc(r.title)}</span>
          <span class="related-card-meta">${r.chapter_count} chapters</span>
        </a>`).join('')}
      </div>
    </div>` : '';

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
        ${genres.length ? `<div class="comic-detail-genres">${genres.map(g => `<a class="detail-genre-tag" href="/genre/${genreSlug(g)}">${esc(g)}</a>`).join('')}</div>` : ''}
        <p class="comic-detail-desc">${esc(comic.description || 'No description available.')}</p>
        <div class="comic-detail-actions">
          ${firstChapter ? `<a href="${chapterUrl(slug, firstChapter.chapter_number)}" class="btn-read"><i class="fa fa-book-open"></i> Read First Chapter</a>` : ''}
          ${lastChapter && lastChapter.id !== (firstChapter && firstChapter.id) ? `<a href="${chapterUrl(slug, lastChapter.chapter_number)}" class="btn-details"><i class="fa fa-forward"></i> Latest Chapter</a>` : ''}
        </div>
      </div>
    </div>
    ${overview}
    <div class="chapters-section">
      <h2><span class="accent-bar"></span> Chapters <span style="font-size:14px;color:var(--text3);font-weight:400">(${chapters.length})</span></h2>
      ${chapterToolbar}
      <div class="chapter-list" id="chapterList">${chapterListHtml}</div>
      <p class="chapter-empty" id="chapterEmpty" hidden>No chapters match that filter.</p>
      ${chapters.length > SSR_CHAPTERS ? `<button type="button" id="chapterMore" class="load-more-btn">Show more chapters</button>` : ''}
    </div>
    ${chapters.length > SSR_CHAPTERS ? `
    <nav class="chapter-archive" aria-label="All chapters">
      <h2><span class="accent-bar"></span> All Chapters</h2>
      <div class="chapter-archive-grid">${
        newestFirst.map(ch => `<a href="${chapterUrl(slug, ch.chapter_number)}">${ch.chapter_number}</a>`).join('')
      }</div>
    </nav>` : ''}
    ${bookRelatedHtml}
    <script type="application/json" id="chapterData">${chapterData.replace(/</g, '\\u003c')}</script>`;

  const html = comicHtml
    // Replace the whole placeholder line, not just the <title>. The static file also
    // carries a `robots: index, follow` tag; leaving it in emitted TWO robots metas per
    // page, and on adult titles the stray one contradicted max-image-preview:none.
    .replace(/<!--SSR:head-->.*/, '')
    .replace('</head>', metaTags + '\n</head>')
    .replace('<div class="detail-loading"><i class="fa fa-spinner fa-spin fa-2x"></i></div>', ssrBody);

  res.send(html);
}

// â”€â”€ Chapter list, deduplicated and cached â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 133 (comic_id, chapter_number) groups currently hold duplicate rows from
// concurrent upload runs. DISTINCT ON collapses each to a single canonical row â€”
// highest views first so engagement is preserved, lowest id as a stable tiebreak â€”
// which keeps one chapter number mapped to exactly one URL.
const _chapterListCache = new Map();
async function getChapterList(comicId) {
  const hit = _chapterListCache.get(comicId);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.rows;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (chapter_number) id, chapter_number, title, pdf_url, created_at
     FROM chapters WHERE comic_id = $1
     ORDER BY chapter_number ASC, views DESC, id ASC`,
    [comicId]
  );
  _chapterListCache.set(comicId, { rows, ts: Date.now() });
  return rows;
}

const readerHtml = fs.readFileSync(path.join(__dirname, 'public', 'reader.html'), 'utf8');

async function serveChapterPage(comic, chapter, chapters, req, res) {
  let genres = [];
  try { genres = JSON.parse(comic.genres); } catch {}

  const num       = Number(chapter.chapter_number);
  const idx       = chapters.findIndex(c => Number(c.chapter_number) === num);
  const prev      = idx > 0 ? chapters[idx - 1] : null;
  const next      = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  const first     = chapters[0];
  const last      = chapters[chapters.length - 1];
  const total     = chapters.length;
  const label     = Number.isInteger(num) ? `Chapter ${num}` : `Chapter ${num}`;
  const comicUrl  = `/${comic.slug}`;
  const canonical = `${SITE_URL}${chapterUrl(comic.slug, num)}`;

  pool.query('UPDATE chapters SET views = views + 1 WHERE id = $1', [chapter.id]).catch(() => {});

  // Staged rollout gate, plus a hard adult exclusion â€” see the SAFE note above.
  const indexable = comic.seo_indexed === 1 && !comic.is_adult;

  // A distinct chapter title (not just "Chapter 12") is worth putting in the <title>.
  const hasRealTitle = chapter.title && !/^chapter\s*[\d.]+$/i.test(chapter.title.trim());
  const pageTitle = fitTitle(
    `${comic.title} Chapter ${num}${hasRealTitle ? `: ${chapter.title}` : ''}`,
    [' - Read Free Online | MangVault', ' - Read Free | MangVault', ' | MangVault', '']
  );

  const genreText = genres.filter(g => g !== 'Manhwa' && g !== 'Manga').slice(0, 2).join(' ');
  const desc = fitDesc([
    `Read ${comic.title} chapter ${num} online free in English at MangVault.`,
    prev ? `Continues from chapter ${prev.chapter_number}.` : 'The opening chapter.',
    next ? `Chapter ${next.chapter_number} next.` : 'Latest chapter.',
    `${genreText} series, ${total} chapters.`,
  ].filter(Boolean).join(' '));

  const coverImage = comic.cover_image || '';

  const metaTags = `<title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(desc)}" />
  <!-- Google ignores keywords entirely; Bing still treats them as a weak signal, and
       Bing is where the non-Google traffic actually comes from (it also feeds Yahoo,
       DuckDuckGo and Ecosia). Cheap to emit, so chapter pages carry them too. -->
  <meta name="keywords" content="${esc([
    `${comic.title} chapter ${num}`, `${comic.title} ch ${num}`, comic.title,
    'read online free', 'english', ...genres.slice(0, 3), 'manhwa', 'MangVault',
  ].join(', '))}" />
  <meta name="robots" content="${indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow'}" />
  <link rel="canonical" href="${canonical}" />
  ${prev ? `<link rel="prev" href="${SITE_URL}${chapterUrl(comic.slug, prev.chapter_number)}" />` : ''}
  ${next ? `<link rel="next" href="${SITE_URL}${chapterUrl(comic.slug, next.chapter_number)}" />` : ''}
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:title" content="${esc(pageTitle)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:site_name" content="MangVault" />${coverImage ? `\n  <meta property="og:image" content="${esc(coverImage)}" />` : ''}
  <meta name="twitter:card" content="${coverImage ? 'summary_large_image' : 'summary'}" />
  <meta name="twitter:title" content="${esc(pageTitle)}" />
  <meta name="twitter:description" content="${esc(desc)}" />${coverImage ? `\n  <meta name="twitter:image" content="${esc(coverImage)}" />` : ''}
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ComicIssue",
    "name": "${jsonStr(`${comic.title} ${label}`)}",
    "issueNumber": ${num},
    "url": "${canonical}",
    "description": "${jsonStr(desc)}",${coverImage ? `\n    "image": "${jsonStr(coverImage)}",` : ''}
    "datePublished": "${chapter.created_at ? new Date(chapter.created_at).toISOString().split('T')[0] : ''}",
    "isPartOf": {
      "@type": "ComicSeries",
      "name": "${jsonStr(comic.title)}",
      "url": "${SITE_URL}${comicUrl}",
      "genre": ${JSON.stringify(genres)},
      "numberOfItems": ${total}
    },
    "publisher": { "@type": "Organization", "name": "MangVault", "url": "${SITE_URL}" }
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE_URL}/" },
      { "@type": "ListItem", "position": 2, "name": "Browse", "item": "${SITE_URL}/browse" },
      { "@type": "ListItem", "position": 3, "name": "${jsonStr(comic.title)}", "item": "${SITE_URL}${comicUrl}" },
      { "@type": "ListItem", "position": 4, "name": "${jsonStr(label)}", "item": "${canonical}" }
    ]
  }
  </script>
  <script>
    window.CHAPTER_ID = ${chapter.id};
    window.CHAPTER_PDF = ${JSON.stringify(chapter.pdf_url || '')};
    window.CHAPTER_SLUG = ${JSON.stringify(comic.slug)};
    window.CHAPTER_NUMBER = ${num};
    window.CHAPTER_COMIC_TITLE = ${JSON.stringify(comic.title)};
    window.CHAPTER_COVER = ${JSON.stringify(coverImage || '')};
    window.CHAPTER_IS_ADULT = ${comic.is_adult ? 1 : 0};
    window.CHAPTER_SSR = true;
  </script>`;

  // â”€â”€ Crawlable navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const navLink = (ch, dir, cls) => ch
    ? `<a href="${chapterUrl(comic.slug, ch.chapter_number)}" class="${cls}" rel="${dir}" title="Chapter ${ch.chapter_number}">${
        dir === 'prev' ? '<i class="fa fa-chevron-left"></i>' : ''}${
        cls === 'reader-bottom-btn' ? (dir === 'prev' ? ' Previous Chapter' : 'Next Chapter ') : ''}${
        dir === 'next' ? '<i class="fa fa-chevron-right"></i>' : ''}</a>`
    : `<span class="${cls} disabled">${
        dir === 'prev' ? '<i class="fa fa-chevron-left"></i>' : ''}${
        cls === 'reader-bottom-btn' ? (dir === 'prev' ? ' Previous Chapter' : 'Next Chapter ') : ''}${
        dir === 'next' ? '<i class="fa fa-chevron-right"></i>' : ''}</span>`;

  const topNav = `${navLink(prev, 'prev', 'reader-nav-btn')}
        <span class="chapter-indicator">Ch. ${num} / ${last ? last.chapter_number : num}</span>
        ${navLink(next, 'next', 'reader-nav-btn')}`;

  const bottomNav = `${navLink(prev, 'prev', 'reader-bottom-btn')}
    <a href="#" class="back-to-top-btn" onclick="window.scrollTo({top:0,behavior:'smooth'});return false;"><i class="fa fa-arrow-up"></i> Top</a>
    ${navLink(next, 'next', 'reader-bottom-btn')}`;

  const seoHead = `<nav class="reader-breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a><span>/</span><a href="/browse">Browse</a><span>/</span><a href="${comicUrl}">${esc(comic.title)}</a><span>/</span>${esc(label)}
    </nav>
    <h1 class="reader-h1"><a href="${comicUrl}">${esc(comic.title)}</a> ${esc(label)}${hasRealTitle ? `: ${esc(chapter.title)}` : ''}</h1>
    <p class="reader-intro">Reading ${esc(comic.title)} chapter ${num} of ${total} in English, free on MangVault.${
      next ? ` Continue to <a href="${chapterUrl(comic.slug, next.chapter_number)}">chapter ${next.chapter_number}</a> when you finish.` : ' This is the latest available chapter.'}</p>`;

  // Nearby chapters give the crawler dense internal links without dumping 600 rows.
  const windowStart = Math.max(0, idx - 8);
  const nearby = chapters.slice(windowStart, windowStart + 17);
  const nearbyHtml = nearby.map(ch => {
    const isCurrent = Number(ch.chapter_number) === num;
    const t = ch.title && !/^chapter\s*[\d.]+$/i.test(ch.title.trim()) ? ` - ${esc(ch.title)}` : '';
    return `<a class="chapter-item${isCurrent ? ' is-current' : ''}" href="${chapterUrl(comic.slug, ch.chapter_number)}"${isCurrent ? ' aria-current="page"' : ''}>
        <div class="chapter-item-left">
          <span class="chapter-item-num">Chapter ${ch.chapter_number}${t}</span>
        </div>
        <div class="chapter-item-right">
          <span class="chapter-item-date">${formatDateSSR(ch.created_at)}</span>
        </div>
      </a>`;
  }).join('');

  // Related series: real editorial value on an otherwise thin page, and the only place
  // on the site where internal links deliberately point away from the two titles that
  // already hold 89% of all views. See getRelatedComics().
  const related = await getRelatedComics(comic.id, genres);
  const relatedHtml = related.length ? `
    <div class="chapters-section related-section">
      <h2><span class="accent-bar"></span> More ${esc(genres.filter(g => g !== 'Manhwa' && g !== 'Manga')[0] || 'series')} to read</h2>
      <p class="related-intro">If you are enjoying ${esc(comic.title)}, these free series on MangVault are worth starting next.</p>
      <div class="related-grid">
        ${related.map(r => `<a class="related-card" href="/${r.slug}">
          ${r.cover_image ? `<img src="${esc(r.cover_image)}" alt="${esc(r.title)} cover" loading="lazy" width="86" height="122" />` : '<span class="related-card-noimg"></span>'}
          <span class="related-card-title">${esc(r.title)}</span>
          <span class="related-card-meta">${r.chapter_count} chapters</span>
        </a>`).join('')}
      </div>
    </div>` : '';

  const context = `<div class="context-comic">
      ${coverImage ? `<div class="context-comic-cover"><a href="${comicUrl}"><img src="${esc(coverImage)}" alt="${esc(comic.title)} cover" loading="lazy" width="92" /></a></div>` : ''}
      <div class="context-comic-body">
        <h3><a href="${comicUrl}">${esc(comic.title)}</a></h3>
        <div class="context-comic-meta">
          <span><i class="fa fa-user"></i> ${esc(comic.author || 'Unknown')}</span>
          <span><i class="fa fa-book"></i> ${total} chapters</span>
          <span><i class="fa fa-circle-notch"></i> ${esc(comic.status || 'Ongoing')}</span>
        </div>
        <p class="context-comic-desc">${esc((comic.description || '').slice(0, 260))}${(comic.description || '').length > 260 ? 'â€¦' : ''}</p>
        ${genres.length ? `<div class="context-genres">${genres.map(g => `<a href="/genre/${genreSlug(g)}">${esc(g)}</a>`).join('')}</div>` : ''}
      </div>
    </div>
    <div class="chapters-section">
      <h2><span class="accent-bar"></span> More ${esc(comic.title)} Chapters</h2>
      <div class="chapter-list">${nearbyHtml}</div>
      <div class="chapter-jump">
        ${first ? `<a href="${chapterUrl(comic.slug, first.chapter_number)}"><i class="fa fa-angles-left"></i> First chapter</a>` : ''}
        <a href="${comicUrl}">All ${total} chapters</a>
        ${last ? `<a href="${chapterUrl(comic.slug, last.chapter_number)}">Latest chapter <i class="fa fa-angles-right"></i></a>` : ''}
      </div>
    </div>${relatedHtml}`;

  const html = readerHtml
    .replace(/<!--SSR:head-->.*/, metaTags)
    .replace('<!--SSR:backHref-->',    comicUrl)
    .replace('<!--SSR:comicTitle-->',  esc(comic.title))
    .replace('<!--SSR:chapterTitle-->', esc(`${label}${hasRealTitle ? ` - ${chapter.title}` : ''}`))
    .replace('<!--SSR:topNav-->',      topNav)
    .replace('<!--SSR:seoHead-->',     seoHead)
    .replace('<!--SSR:bottomNav-->',   bottomNav)
    .replace('<!--SSR:context-->',     context);

  res.send(html);
}

// â”€â”€ /:slug/chapter-:num â€” SEO chapter URLs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/:slug/chapter-:num', async (req, res, next) => {
  try {
    const num = parseChapterSlugPart(req.params.num);
    if (num === null) return next();

    const { rows } = await pool.query(
      'SELECT id, title, description, cover_image, author, artist, status, views, genres, slug, is_adult, seo_indexed FROM comics WHERE slug = $1',
      [req.params.slug]
    );
    if (!rows[0]) return send404(res);
    const comic = rows[0];

    const chapters = await getChapterList(comic.id);
    const chapter = chapters.find(c => Number(c.chapter_number) === num);
    if (!chapter) return send404(res);

    // Canonicalise "chapter-43.5" to "chapter-43-5" so one chapter has one URL.
    const canonicalPart = chapterSlugPart(chapter.chapter_number);
    if (req.params.num !== canonicalPart) {
      return res.redirect(301, chapterUrl(comic.slug, chapter.chapter_number));
    }

    await serveChapterPage(comic, chapter, chapters, req, res);
  } catch (err) {
    console.error('[chapter page]', err.message);
    res.status(500).send(errorHtml('Something went wrong'));
  }
});

// â”€â”€ /reader/:id â€” legacy numeric chapter URLs, 301 to the SEO URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/reader/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.redirect(301, '/');
    const { rows } = await pool.query(
      `SELECT ch.chapter_number, c.slug FROM chapters ch
       JOIN comics c ON c.id = ch.comic_id WHERE ch.id = $1`,
      [req.params.id]
    );
    if (!rows[0] || !rows[0].slug) return send404(res);
    res.redirect(301, chapterUrl(rows[0].slug, rows[0].chapter_number));
  } catch (err) {
    console.error('[reader redirect]', err.message);
    res.status(500).send(errorHtml('Something went wrong'));
  }
});

// â”€â”€ /comic/:id â€” redirect numeric IDs to slug URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/comic/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.redirect(301, '/');
    const { rows } = await pool.query(
      'SELECT id, title, description, cover_image, author, artist, status, views, genres, slug, is_adult FROM comics WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return send404(res);
    const comic = rows[0];
    if (comic.slug) return res.redirect(301, `/${comic.slug}`);
    // No slug yet â€” serve page directly
    await serveComicPage(comic, comic.id, req, res);
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'comic.html'));
  }
});

// â”€â”€ Home page â€” SSR all sections so Google sees real content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/', async (req, res) => {
  try {
    const cc = `(SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count`;
    // Romance fell to 2 books and Drama to 6 once adult titles were excluded, so those
    // rows rendered nearly empty. Adventure (24) and Martial Arts (13) have real depth.
    const [heroRes, newRelRes, actionRes, adventureRes, fantasyRes, martialRes, mostViewedRes, popularRes, genreRes] = await Promise.all([
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE ${SAFE} ORDER BY c.views DESC LIMIT 6`),
      pool.query(`SELECT c.*, ${cc}, (SELECT created_at FROM chapters WHERE comic_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_chapter_date FROM comics c WHERE ${SAFE} AND (SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) > 0 ORDER BY last_chapter_date DESC LIMIT 12`),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE ${SAFE} AND c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Action"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE ${SAFE} AND c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Adventure"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE ${SAFE} AND c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Fantasy"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE ${SAFE} AND c.genres LIKE $1 ORDER BY c.views DESC LIMIT 12`, ['%"Martial Arts"%']),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE ${SAFE} ORDER BY c.views DESC LIMIT 12`),
      pool.query(`SELECT c.*, ${cc} FROM comics c WHERE ${SAFE} ORDER BY c.views DESC LIMIT 24`),
      pool.query('SELECT genres FROM comics c WHERE ' + SAFE),
    ]);

    const genreSet = new Set();
    genreRes.rows.forEach(r => { try { JSON.parse(r.genres).forEach(g => genreSet.add(g)); } catch {} });
    const allGenres = [...genreSet].sort();
    const genreTagsHtml = allGenres.length
      ? allGenres.map(g => `<a href="/genre/${genreSlug(g)}" class="genre-tag-btn">${esc(g)}</a>`).join('')
      : '<p style="color:var(--text3)">No genres yet.</p>';

    const popularCover = heroRes.rows.find(c => c.cover_image)?.cover_image || '';
    const html = indexHtml
      .replace('<!--SSR:heroSection-->',    ssrHero(heroRes.rows))
      .replace('<!--SSR:newReleasesRow-->', ssrRow(newRelRes.rows))
      .replace('<!--SSR:actionRow-->',      ssrRow(actionRes.rows))
      .replace('<!--SSR:adventureRow-->',   ssrRow(adventureRes.rows))
      .replace('<!--SSR:fantasyRow-->',     ssrRow(fantasyRes.rows))
      .replace('<!--SSR:martialArtsRow-->', ssrRow(martialRes.rows))
      .replace('<!--SSR:mostViewedRow-->',  ssrRow(mostViewedRes.rows))
      .replace('<!--SSR:popularGrid-->',    ssrRow(popularRes.rows))
      .replace('<!--SSR:genreTags-->',      genreTagsHtml)
      .replace('<!--SSR:genreNav-->',       await genreNavHtml())
      .replaceAll('__OG_IMAGE__',           esc(popularCover))
      // Must land BEFORE main.js, not before </body>. Injected after the script tag,
      // main.js sees HOME_SSR undefined and re-fetches every row it just received.
      .replace(/<script src="\/js\/main\.js/, '<script>window.HOME_SSR=true;</script>\n  <script src="/js/main.js');

    res.send(html);
  } catch (err) {
    // Falling back to the static shell means Google gets a page with no comics on it,
    // so this must be loud rather than silent.
    console.error('[home SSR failed â€” serving static shell]', err.stack || err.message);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// â”€â”€ Browse page â€” SSR initial grid so Google sees real comic links â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/browse', async (req, res) => {
  try {
    const { genre, status, search, sort = 'updated' } = req.query;
    const params = [];
    let p = 1;
    // Adult titles never appear in the server-rendered browse grid; the client can
    // still request them through /api/comics?adult=1.
    let where = `WHERE ${SAFE}`;
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

    const popularCover = await getPopularCover();
    const html = browseHtml
      .replace('<!--SSR:browseTitle-->', esc(pageTitle))
      .replace('<!--SSR:browseCount-->', esc(countText))
      .replace('<!--SSR:genreIntro-->',  '')
      .replace('<!--SSR:genreRelated-->', '')
      .replace('<!--SSR:genreNav-->',    await genreNavHtml())
      .replace('<!--SSR:browseGrid-->',  gridHtml)
      .replaceAll('__OG_IMAGE__',        esc(popularCover))
      // Must land BEFORE browse.js â€” see the note on the home route.
      .replace(/<script src="\/js\/browse\.js/,
        `<script>window.BROWSE_SSR=true;window.BROWSE_TOTAL=${total};window.BROWSE_LOADED=${comicsRes.rows.length};</script>\n  <script src="/js/browse.js`);

    res.send(html);
  } catch (err) {
    console.error('[browse SSR failed â€” serving static shell]', err.stack || err.message);
    res.sendFile(path.join(__dirname, 'public', 'browse.html'));
  }
});

// â”€â”€ /genre/:slug â€” crawlable genre landing pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Genres previously existed only as ?genre= query params, which Google treats as
// faceted duplicates of /browse and largely declines to index. These are real paths
// with their own title, copy and CollectionPage schema.
app.get('/genre/:slug', async (req, res) => {
  try {
    const map = await getGenreMap();
    const entry = map.get(req.params.slug);
    if (!entry) return send404(res);

    const { name, count } = entry;
    const indexable = count >= GENRE_INDEX_MIN;
    const canonical = `${SITE_URL}/genre/${req.params.slug}`;

    const cc = `(SELECT COUNT(*) FROM chapters WHERE comic_id = c.id) AS chapter_count`;
    const { rows } = await pool.query(
      `SELECT c.*, ${cc} FROM comics c
       WHERE ${SAFE} AND c.genres LIKE $1
       ORDER BY c.views DESC LIMIT 48`,
      [`%"${name}"%`]
    );

    const totalChapters = rows.reduce((n, c) => n + parseInt(c.chapter_count || 0, 10), 0);
    const pageTitle = fitTitle(`${name} Manhwa & Manga`, [
      ' - Read Free Online | MangVault', ' - Read Free | MangVault', ' | MangVault', '',
    ]);
    const desc = fitDesc(`Read free ${name.toLowerCase()} manhwa, manhua and manga at MangVault â€” ${count} series, ${totalChapters.toLocaleString('en-US')} chapters, no signup.`);

    const intro = `Browse every ${esc(name.toLowerCase())} series on MangVault â€” ${count} titles and ${totalChapters.toLocaleString('en-US')} chapters, free to read in English with no account needed. Sorted by popularity, updated as new chapters land.`;

    const related = [...map.entries()]
      .filter(([slug, g]) => slug !== req.params.slug && g.count >= GENRE_INDEX_MIN)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 12)
      .map(([slug, g]) => `<a href="/genre/${slug}">${esc(g.name)}</a>`)
      .join('');

    const popularCover = rows.find(c => c.cover_image)?.cover_image || await getPopularCover();

    const head = `<title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(desc)}" />
  <meta name="keywords" content="${esc([
    `${name.toLowerCase()} manhwa`, `${name.toLowerCase()} manga`, `${name.toLowerCase()} manhua`,
    `read ${name.toLowerCase()} online free`, 'english', 'MangVault',
  ].join(', '))}" />
  <meta name="robots" content="${indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow'}" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:title" content="${esc(pageTitle)}" />
  <meta property="og:description" content="${esc(desc)}" />
  <meta property="og:site_name" content="MangVault" />
  <meta property="og:image" content="${esc(popularCover)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(pageTitle)}" />
  <meta name="twitter:description" content="${esc(desc)}" />
  <meta name="twitter:image" content="${esc(popularCover)}" />
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "${jsonStr(`${name} Manhwa & Manga`)}",
    "description": "${jsonStr(desc)}",
    "url": "${canonical}",
    "isPartOf": { "@type": "WebSite", "name": "MangVault", "url": "${SITE_URL}" },
    "breadcrumb": {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE_URL}/" },
        { "@type": "ListItem", "position": 2, "name": "Browse", "item": "${SITE_URL}/browse" },
        { "@type": "ListItem", "position": 3, "name": "${jsonStr(name)}", "item": "${canonical}" }
      ]
    },
    "mainEntity": {
      "@type": "ItemList",
      "numberOfItems": ${rows.length},
      "itemListElement": [${rows.slice(0, 20).map((c, i) => `
        { "@type": "ListItem", "position": ${i + 1}, "url": "${SITE_URL}/${c.slug}", "name": "${jsonStr(c.title)}" }`).join(',')}
      ]
    }
  }
  </script>`;

    const html = browseHtml
      .replace(/<!--SSR:head-->[\s\S]*?<!--\/SSR:head-->/, head)
      .replace('<!--SSR:browseTitle-->All Comics', esc(`${name} Comics`))
      .replace('<!--SSR:browseCount-->', esc(`${count} ${name.toLowerCase()} series`))
      .replace('<!--SSR:genreIntro-->', intro)
      .replace('<!--SSR:genreNav-->',   await genreNavHtml())
      .replace('<!--SSR:browseGrid-->', rows.map(ssrComicCard).join(''))
      .replace('<!--SSR:genreRelated-->', related ? `<strong style="font-size:12px;color:var(--text3);align-self:center;margin-right:4px">More genres:</strong>${related}` : '')
      .replaceAll('__OG_IMAGE__', esc(popularCover))
      // Must land BEFORE browse.js â€” see the note on the home route.
      .replace(/<script src="\/js\/browse\.js/,
        `<script>window.BROWSE_SSR=true;window.BROWSE_GENRE=${JSON.stringify(name)};window.BROWSE_TOTAL=${count};window.BROWSE_LOADED=${rows.length};</script>\n  <script src="/js/browse.js`);

    res.send(html);
  } catch (err) {
    console.error('[genre page]', err.message);
    res.status(500).send(errorHtml('Something went wrong'));
  }
});

// â”€â”€ Other static routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// â”€â”€ /:slug â€” comic pages by name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, description, cover_image, author, artist, status, views, genres, slug, is_adult FROM comics WHERE slug = $1',
      [req.params.slug]
    );
    if (!rows[0]) return send404(res);
    await serveComicPage(rows[0], rows[0].id, req, res);
  } catch (err) {
    console.error('[comic page]', err.message);
    res.status(500).send(errorHtml('Something went wrong'));
  }
});

// â”€â”€ Catch-all â€” anything unmatched is a real 404, never a soft 200 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use((req, res) => send404(res));

initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`\n Comic Site running at http://localhost:${PORT}`);
    console.log(` Admin panel: http://localhost:${PORT}/admin\n`);
  }))
  .catch(err => { console.error('Failed to connect to database:', err.message); process.exit(1); });
