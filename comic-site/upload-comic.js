// One-time script to import "My High School Bully" PDFs into the local database
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SOURCE_DIR = 'C:/Users/Administrator/Downloads/Telegram Desktop/My High School Bully';
const DB_PATH = path.join(__dirname, 'database/comics.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads/pdfs');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Add pdf_url column if not already there
try { db.exec('ALTER TABLE chapters ADD COLUMN pdf_url TEXT DEFAULT NULL'); }
catch {}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Create the comic record
const existing = db.prepare("SELECT id FROM comics WHERE title = 'My High School Bully'").get();
let comicId;
if (existing) {
  comicId = existing.id;
  console.log(`Comic already exists with ID: ${comicId}`);
} else {
  const r = db.prepare(`
    INSERT INTO comics (title, author, description, status, genres, featured)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'My High School Bully',
    'Yunni & Married',
    'A story about a girl who is bullied by the most popular guy in school — but things are not what they seem.',
    'Ongoing',
    JSON.stringify(['Romance', 'Drama', 'Manhwa']),
    1
  );
  comicId = r.lastInsertRowid;
  console.log(`Created comic with ID: ${comicId}`);
}

// Parse chapter number from filename
function parseChapterNum(filename) {
  // Match "Chapter 241", "Ch-241", "Ch 241"
  const m = filename.match(/(?:chapter|ch)[-\s]?(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

const files = fs.readdirSync(SOURCE_DIR)
  .filter(f => f.toLowerCase().endsWith('.pdf'))
  .sort();

const seen = new Set();
let added = 0, skipped = 0;

for (const file of files) {
  const chNum = parseChapterNum(file);
  if (!chNum) { console.log(`  SKIP (no chapter number): ${file}`); skipped++; continue; }
  if (seen.has(chNum)) { console.log(`  SKIP (duplicate ch ${chNum}): ${file}`); skipped++; continue; }

  // Check if chapter already in DB
  const exists = db.prepare('SELECT id FROM chapters WHERE comic_id = ? AND chapter_number = ?').get(comicId, chNum);
  if (exists) { console.log(`  SKIP (already in DB): Chapter ${chNum}`); seen.add(chNum); skipped++; continue; }

  const destFile = `comic${comicId}-ch${chNum}.pdf`;
  const destPath = path.join(UPLOADS_DIR, destFile);
  fs.copyFileSync(path.join(SOURCE_DIR, file), destPath);

  db.prepare('INSERT INTO chapters (comic_id, chapter_number, title, pdf_url) VALUES (?,?,?,?)')
    .run(comicId, chNum, `Chapter ${chNum}`, `/uploads/pdfs/${destFile}`);

  seen.add(chNum);
  console.log(`  Added chapter ${chNum}`);
  added++;
}

db.prepare('UPDATE comics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(comicId);

console.log(`\nDone! Added ${added} chapters, skipped ${skipped}.`);
console.log(`View at: http://localhost:3000/comic/${comicId}`);
