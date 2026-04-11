require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function backfillSlugs() {
  const { rows } = await pool.query(
    "SELECT id, title FROM comics WHERE slug IS NULL OR slug = '' ORDER BY id"
  );

  if (!rows.length) {
    console.log('All comics already have slugs. Nothing to do.');
    await pool.end();
    return;
  }

  console.log(`Found ${rows.length} comic(s) without slugs. Backfilling...\n`);

  for (const comic of rows) {
    const baseSlug = slugify(comic.title);
    const existing = await pool.query(
      'SELECT id FROM comics WHERE slug = $1 AND id != $2',
      [baseSlug, comic.id]
    );
    const finalSlug = existing.rows.length ? `${baseSlug}-${comic.id}` : baseSlug;
    await pool.query('UPDATE comics SET slug = $1 WHERE id = $2', [finalSlug, comic.id]);
    console.log(`  [${comic.id}] "${comic.title}" → /${finalSlug}`);
  }

  console.log(`\nDone. ${rows.length} slug(s) updated.`);
  await pool.end();
}

backfillSlugs().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
