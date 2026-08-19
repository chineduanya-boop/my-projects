# comic-site (MangVault)

A Node.js/Express web platform for hosting and reading manga/manhwa/manhua comics, deployed at **mangvault.com**.

## Tech Stack

- **Backend:** Node.js + Express (`server.js`)
- **Database:** PostgreSQL via Supabase (`pg` pool, `DATABASE_URL`)
- **File Storage:** Cloudflare R2 (S3-compatible) for covers, page images, and PDFs
- **Session Auth:** `express-session` — single admin password (`ADMIN_PASSWORD` env var)
- **Frontend:** Vanilla HTML/CSS/JS in `public/`
- **Deployment:** Railway (`railway.json`)

## Project Structure

```
server.js              — Express app entry point, routes, SEO meta injection
database/db.js         — PostgreSQL pool, schema init, slugify helper
routes/comics.js       — Public API (GET comics, chapters, pages, genres)
routes/admin.js        — Admin API (CRUD comics/chapters, file uploads to R2)
public/                — Static frontend (HTML, CSS, JS)
  index.html           — Home page
  browse.html          — Browse/search page
  comic.html           — Comic detail page
  reader.html          — Chapter reader (image-based)
  admin.html           — Admin panel
  login.html           — Admin login
uploads/pdfs/          — Legacy local PDF storage (older scripts only)
upload-*.js            — One-time import scripts (see below)
```

## Database Schema

Three tables:

- **comics** — `id, title, author, artist, description, cover_image, genres (JSON array TEXT), status, views, featured, is_adult, slug, created_at, updated_at`
- **chapters** — `id, comic_id, chapter_number (REAL), title, views, pdf_url, created_at`
- **pages** — `id, chapter_id, page_number, image_path`

Chapters support two modes: **image-based** (rows in `pages` table) or **PDF-based** (`pdf_url` column on the chapter).

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```
DATABASE_URL=postgresql://...          # Supabase connection string
R2_ACCOUNT_ID=...                      # Cloudflare account ID
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
R2_PUBLIC_URL=https://pub-xxxx.r2.dev  # Public R2 bucket URL
ADMIN_PASSWORD=...                     # Admin panel password
SESSION_SECRET=...                     # Express session secret
NODE_ENV=production
```

## Running Locally

```bash
npm install
cp .env.example .env   # fill in your credentials
npm start              # http://localhost:3000
npm run dev            # with nodemon auto-reload
```

Admin panel: `http://localhost:3000/admin` (password from `ADMIN_PASSWORD`)

## API Endpoints

### Public (`/api`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/comics` | List comics (query: `genre`, `status`, `search`, `sort`, `limit`, `offset`, `adult`) |
| GET | `/api/comics/featured` | Featured comics |
| GET | `/api/comics/popular` | Popular comics by views |
| GET | `/api/comics/new-releases` | Recently updated comics |
| GET | `/api/comics/:id` | Single comic (by numeric ID or slug) |
| GET | `/api/comics/:id/chapters` | Chapter list for a comic |
| GET | `/api/chapters/:id/pages` | Pages + prev/next for a chapter |
| GET | `/api/genres` | All unique genres |

### Admin (`/api/admin` — requires login session)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/comics` | All comics |
| POST | `/api/admin/comics` | Create comic (multipart: `cover` image + fields) |
| PUT | `/api/admin/comics/:id` | Update comic |
| DELETE | `/api/admin/comics/:id` | Delete comic |
| POST | `/api/admin/comics/:id/chapters` | Add chapter with image pages (multipart: `pages[]`) |
| POST | `/api/admin/comics/:id/chapters/pdf` | Add chapter as PDF (multipart: `pdf`) |
| DELETE | `/api/admin/chapters/:id` | Delete chapter |

## Uploading Comics

### Via Admin Panel (recommended for small uploads)
Go to `/admin`, log in, and use the UI to create comics and upload chapters.

### Via Upload Scripts (for bulk imports from local PDFs)
The repo contains per-comic scripts following a standard pattern:

```bash
node upload-<comic-name>.js
```

Each script:
1. Reads PDFs from a local source directory (hardcoded `SOURCE_DIR`)
2. Uploads the cover image to R2 under `covers/`
3. Upserts the comic record in Supabase
4. Uploads each PDF to R2 under `pdfs/` and inserts a chapter row
5. Skips chapters already in the database (idempotent)

**To add a new comic via script**, copy an existing upload script (e.g. `upload-solo-leveling.js`) and update:
- `SOURCE_DIR` — path to local folder of chapter PDFs
- `COVER_FILE` — filename of the cover image in `SOURCE_DIR`
- Comic metadata: `title`, `author`, `artist`, `description`, `status`, `genres`
- The `parseChapterNum()` regex if the filename pattern differs
- The R2 key prefix (e.g. `pdfs/my-comic-ch${chNum}-${Date.now()}.pdf`)

Run with: `node upload-<name>.js` (requires `.env` with valid credentials)

### PDF Filename Patterns Seen in This Repo
- `Ch - 001.pdf`
- `Chapter 10.pdf`
- `CH - 194 - Side Story 15.pdf`
- `Chapter 180 - Side Story 1.pdf`

Adjust `parseChapterNum()` in your script to match your source files.

## Slug System

Slugs are auto-generated from comic titles on creation (`slugify()` in `db.js`). URLs use slugs: `mangvault.com/<slug>`. Numeric IDs redirect to slug URLs (301).

## Adult Content

Comics have an `is_adult` flag. **It does not affect what readers see.** The catalogue is
served whole — home rows, browse grid, genre grids, search and related-series all list all
74 titles identically. There is no 18+ toggle, interstitial, cover blur or badge on the
public site, and `/api/comics` takes no `adult` param (a stale one is ignored).

The flag now controls **search-engine exposure only**, via two predicates in `server.js`:

- `BROWSE_ALL` (`1=1`) — every reader-facing query
- `INDEX_SAFE` (`c.is_adult = 0`) — sitemap-comics.xml, the chapter sitemaps, and the
  site-wide og:image fallback

Adult book pages stay `index, follow, max-image-preview:none` (findable by name, cover art
kept out of Google Images) and their URLs live in `sitemap-mature.xml`. Their chapter pages
stay `noindex`. That posture is unchanged from when the wall existed — opening the site to
readers was deliberately not extended to widening search exposure.

Known tradeoff: because SSR HTML is what readers and Googlebot both receive, adult titles'
*names* now appear in indexed grid HTML. Titles are never rewritten — they are the search
queries that bring readers in. `sanitize-descriptions.js` is the mitigation on the text
side; run it after adding any title whose synopsis leans suggestive.

The admin panel still exposes the 18+ checkbox so the flag stays editable.

## Caching

`routes/comics.js` uses a simple in-memory TTL cache (5 min) for featured/popular/new-releases/genres endpoints. Call `bustCache()` after any write — already wired into all admin mutations.

## Deployment (Railway)

Defined in `railway.json`. Set all env vars in the Railway dashboard. The app binds to `process.env.PORT`.
