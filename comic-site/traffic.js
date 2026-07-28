#!/usr/bin/env node
/**
 * traffic.js — read the first-party traffic log.
 *
 * comics.views and chapters.views are lifetime counters with no timestamp, so they can
 * only ever rise and cannot answer "did traffic drop last week?". traffic_log (written by
 * the middleware in server.js) is the time series that question needs. This reads it
 * directly over the DB, so it needs no admin session and works against production.
 *
 *   node traffic.js                    last 30 days, daily totals
 *   node traffic.js --days 7           last 7 days
 *   node traffic.js --kind             break down by page type
 *   node traffic.js --ref              top external referrers (acquisition)
 *   node traffic.js --pages            most-visited paths
 *   node traffic.js --bots             include bot rows in the daily table
 *
 * Bot traffic is EXCLUDED from every view unless --bots is passed. Crawlers outnumber
 * humans heavily on a site with 8,500+ indexable URLs, and mixing them makes the numbers
 * meaningless.
 */
require('dotenv').config();
const { pool } = require('./database/db');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const num = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  const v = i !== -1 ? parseInt(argv[i + 1], 10) : NaN;
  return Number.isFinite(v) ? v : d;
};

const DAYS = Math.min(Math.max(num('days', 30), 1), 180);
const SINCE = `created_at >= NOW() - INTERVAL '${DAYS} days'`;
const bar = (n, max, w = 28) => '█'.repeat(Math.max(max ? Math.round((n / max) * w) : 0, n > 0 ? 1 : 0));
// Format from local date parts, not toISOString(). pg hands back a `timestamp without
// time zone` as a local-midnight Date, and toISOString() then shifts it back through the
// BST offset — which rolled every date in the daily table to the previous day.
const day = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

async function totals() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE is_bot=0)::int AS humans,
            COUNT(*) FILTER (WHERE is_bot=1)::int AS bots,
            MIN(created_at) AS first, MAX(created_at) AS last
       FROM traffic_log`);
  const t = rows[0];
  if (!t.humans && !t.bots) {
    console.log('\ntraffic_log is EMPTY.\n');
    console.log('The logging middleware ships in server.js but has not been deployed yet,');
    console.log('so production is not writing to it. Deploy, then check back.\n');
    return false;
  }
  console.log(`\nLog spans ${day(t.first)} -> ${day(t.last)}`);
  console.log(`Total rows: ${t.humans.toLocaleString()} human, ${t.bots.toLocaleString()} bot\n`);
  return true;
}

async function daily() {
  const botCol = has('bots') ? '' : 'AND is_bot = 0';
  const { rows } = await pool.query(
    `SELECT created_at::date AS d,
            COUNT(*) FILTER (WHERE is_bot=0)::int AS humans,
            COUNT(*) FILTER (WHERE is_bot=1)::int AS bots
       FROM traffic_log WHERE ${SINCE} GROUP BY d ORDER BY d DESC`);
  if (!rows.length) return console.log(`No rows in the last ${DAYS} days.`);
  const max = Math.max(...rows.map(r => r.humans));
  console.log(`DAILY (last ${DAYS} days, humans)`);
  console.log('date          humans   bots   ');
  rows.forEach(r => console.log(
    `${day(r.d)}  ${String(r.humans).padStart(6)} ${String(r.bots).padStart(6)}   ${bar(r.humans, max)}`));
  const tot = rows.reduce((s, r) => s + r.humans, 0);
  console.log(`\ntotal ${tot.toLocaleString()} human hits over ${rows.length} day(s), avg ${Math.round(tot / rows.length)}/day`);
  void botCol;
}

async function byKind() {
  const { rows } = await pool.query(
    `SELECT kind, COUNT(*)::int AS hits FROM traffic_log
      WHERE ${SINCE} AND is_bot=0 GROUP BY kind ORDER BY hits DESC`);
  if (!rows.length) return console.log('No human rows in range.');
  const max = rows[0].hits;
  console.log(`BY PAGE TYPE (last ${DAYS} days, humans)`);
  rows.forEach(r => console.log(`  ${r.kind.padEnd(9)} ${String(r.hits).padStart(7)}  ${bar(r.hits, max)}`));
}

async function byRef() {
  const { rows } = await pool.query(
    `SELECT referrer_host, COUNT(*)::int AS hits FROM traffic_log
      WHERE ${SINCE} AND is_bot=0 AND referrer_host <> ''
      GROUP BY referrer_host ORDER BY hits DESC LIMIT 30`);
  console.log(`ACQUISITION — external referrers (last ${DAYS} days, humans)`);
  if (!rows.length) {
    return console.log('  none recorded. Every human hit was direct or had no referrer.');
  }
  const max = rows[0].hits;
  rows.forEach(r => console.log(`  ${r.referrer_host.padEnd(26)} ${String(r.hits).padStart(6)}  ${bar(r.hits, max, 20)}`));
}

async function byPage() {
  const { rows } = await pool.query(
    `SELECT path, COUNT(*)::int AS hits FROM traffic_log
      WHERE ${SINCE} AND is_bot=0 GROUP BY path ORDER BY hits DESC LIMIT 30`);
  if (!rows.length) return console.log('No human rows in range.');
  const max = rows[0].hits;
  console.log(`TOP PAGES (last ${DAYS} days, humans)`);
  rows.forEach(r => console.log(`  ${String(r.hits).padStart(6)}  ${bar(r.hits, max, 14)}  ${r.path}`));
}

(async () => {
  try {
    if (!(await totals())) return;
    if (has('kind'))       await byKind();
    else if (has('ref'))   await byRef();
    else if (has('pages')) await byPage();
    else                   await daily();
    console.log('');
  } catch (err) {
    if (/relation "traffic_log" does not exist/i.test(err.message)) {
      console.error('\ntraffic_log does not exist yet. Start the server once so initDb() creates it.\n');
    } else {
      console.error('ERR ' + err.message);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
