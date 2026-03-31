const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'comics.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS comics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT DEFAULT 'Unknown',
    artist TEXT DEFAULT 'Unknown',
    description TEXT DEFAULT '',
    cover_image TEXT DEFAULT '',
    genres TEXT DEFAULT '[]',
    status TEXT DEFAULT 'Ongoing',
    views INTEGER DEFAULT 0,
    featured INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comic_id INTEGER NOT NULL,
    chapter_number REAL NOT NULL,
    title TEXT DEFAULT '',
    views INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (comic_id) REFERENCES comics(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chapters_comic ON chapters(comic_id);
  CREATE INDEX IF NOT EXISTS idx_pages_chapter ON pages(chapter_id);
`);

module.exports = db;
