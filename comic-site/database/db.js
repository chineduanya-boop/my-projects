const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,           // up to 20 concurrent DB connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
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

  // Add pdf_url column if it doesn't exist (safe to run on existing DBs)
  await pool.query(`
    ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pdf_url TEXT DEFAULT NULL;
  `);
}

module.exports = { pool, initDb };
