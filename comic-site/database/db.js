const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[pg pool error]', err.message);
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comics (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT DEFAULT 'Unknown',
      artist TEXT DEFAULT 'Unknown',
      description TEXT DEFAULT '',
      cover_image TEXT DEFAULT '',
      genres TEXT DEFAULT '[]',
      status TEXT DEFAULT 'Ongoing',
      views INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id SERIAL PRIMARY KEY,
      comic_id INTEGER NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
      chapter_number REAL NOT NULL,
      title TEXT DEFAULT '',
      views INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pages (
      id SERIAL PRIMARY KEY,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      image_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chapters_comic ON chapters(comic_id);
    CREATE INDEX IF NOT EXISTS idx_pages_chapter ON pages(chapter_id);
  `);

  // Add pdf_url column if it doesn't exist
  await pool.query(`ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pdf_url TEXT DEFAULT NULL;`);

  // Add is_adult column if it doesn't exist
  await pool.query(`ALTER TABLE comics ADD COLUMN IF NOT EXISTS is_adult INTEGER DEFAULT 0;`);

  // Add slug column if it doesn't exist
  await pool.query(`ALTER TABLE comics ADD COLUMN IF NOT EXISTS slug TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comics_slug ON comics(slug);`);

  // Auto-generate slugs for any comics that don't have one yet
  const { rows } = await pool.query('SELECT id, title FROM comics WHERE slug IS NULL OR slug = \'\'');
  for (const comic of rows) {
    const slug = slugify(comic.title);
    // Handle duplicates by appending the id if slug already taken
    const existing = await pool.query('SELECT id FROM comics WHERE slug = $1', [slug]);
    const finalSlug = existing.rows.length ? `${slug}-${comic.id}` : slug;
    await pool.query('UPDATE comics SET slug = $1 WHERE id = $2', [finalSlug, comic.id]);
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports.slugify = slugify;

module.exports = { pool, initDb, slugify };
