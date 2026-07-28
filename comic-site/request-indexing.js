#!/usr/bin/env node
/**
 * request-indexing.js — asks Google to index each book URL via the Search Console
 * URL Inspection tool, driven through your own logged-in Chrome profile.
 *
 * READ THIS FIRST
 * ---------------
 * Google caps "Request Indexing" at roughly 10-13 URLs per day per property. That
 * is a server-side quota; no amount of throttling gets around it. With 74 books
 * this takes about a week of daily runs.
 *
 * Submitting sitemap.xml in Search Console is strictly higher leverage: one action
 * covers all 74 books AND the 6,051 chapter URLs, and a healthy site usually sees
 * them crawled within days. Use this script for titles you want pushed sooner,
 * not as the primary indexing mechanism.
 *
 * HOW IT AUTHENTICATES
 * --------------------
 * It opens your real Chrome profile (launchPersistentContext), so it reuses the
 * Google session you are already signed into. It never sees or handles a password.
 * Chrome must be FULLY CLOSED first — Chrome holds an exclusive lock on the profile
 * and the launch will fail while it is running.
 *
 *   node request-indexing.js                     dry run — lists what it would submit
 *   node request-indexing.js --go                submit, default 10 URLs
 *   node request-indexing.js --go --limit 5      submit fewer
 *   node request-indexing.js --status            show progress across runs
 *   node request-indexing.js --go --top-first    most-viewed first (default is least)
 *   node request-indexing.js --go --profile "Profile 1"
 *
 * Order: least-viewed first by default. See the note in bookUrls() — the popular titles
 * are already indexed, so spending quota top-down wastes it on pages Google has.
 *
 * Progress is written to .indexing-state.json so repeat runs resume where the last
 * one stopped rather than burning quota on URLs already submitted.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function loadPlaywright() {
  for (const c of ['playwright', path.join(__dirname, '..', 'twitter-bot', 'node_modules', 'playwright')]) {
    try { return require(c); } catch {}
  }
  console.error('playwright not found.');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const GO       = has('go');
const LIMIT    = parseInt(val('limit', '10'), 10);
const PROFILE  = val('profile', 'Default');
const SITE     = 'https://mangvault.com';
// Verified by HTML meta tag, so this is a URL-prefix property, not sc-domain:.
const RESOURCE = val('resource', 'https://mangvault.com/');
const USER_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const STATE    = path.join(__dirname, '.indexing-state.json');

const readState  = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { done: [], failed: [] }; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

async function bookUrls() {
  const xml = await fetch(`${SITE}/sitemap-comics.xml`).then(r => r.text());
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1])
    .filter(u => u !== `${SITE}/` && u !== `${SITE}/browse`);

  // sitemap-comics.xml is ordered by views DESC, and spending a ~10/day quota in that
  // order is backwards. Checking eight titles by hand in Search Console on 2026-07-28
  // found the high-view ones (solo-leveling, and noblesse via search) already indexed,
  // while every low-view title — the-max-level-returner, the-hero-returns, nano-machine,
  // star-embracing-swordmaster, academys-genius-swordmaster, pick-me-up-infinite-gacha,
  // revenge-of-the-iron-blooded-sword-hound — came back "URL is unknown to Google".
  // Popular titles get found on their own; the tail is what needs the push. So default
  // to least-viewed first and keep --top-first as the escape hatch.
  return has('top-first') ? urls : urls.reverse();
}

(async () => {
  const all = await bookUrls();
  const state = readState();
  const pending = all.filter(u => !state.done.includes(u));

  console.log(`\n${all.length} book URLs total`);
  console.log(`  already submitted: ${state.done.length}`);
  console.log(`  pending:           ${pending.length}`);

  if (has('status')) {
    if (state.failed.length) console.log(`\n  failed previously: ${state.failed.length}`);
    console.log('');
    return;
  }

  const batch = pending.slice(0, LIMIT);
  if (!batch.length) { console.log('\nNothing pending — all books submitted.\n'); return; }

  if (!GO) {
    console.log(`\nDRY RUN — would submit these ${batch.length}:`);
    batch.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. ${u.replace(SITE, '')}`));
    console.log(`\nRe-run with --go to submit. Close Chrome first.\n`);
    return;
  }

  console.log(`\nOpening your Chrome profile "${PROFILE}"…`);
  console.log(`(if this hangs or errors, Chrome is still running — close it fully)\n`);

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(USER_DIR, {
      channel: 'chrome',
      headless: false,
      args: [`--profile-directory=${PROFILE}`],
      viewport: { width: 1400, height: 900 },
    });
  } catch (e) {
    console.error(`Could not open the profile: ${e.message}`);
    console.error(`Close every Chrome window (check the tray) and try again.`);
    process.exit(1);
  }

  const page = ctx.pages()[0] || await ctx.newPage();
  let submitted = 0;

  for (const url of batch) {
    const inspect = `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(RESOURCE)}&id=${encodeURIComponent(url)}`;
    process.stdout.write(`  ${url.replace(SITE, '').padEnd(44)}`);

    try {
      await page.goto(inspect, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);

      const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

      if (body.includes('sign in') || page.url().includes('accounts.google.com')) {
        console.log('NOT SIGNED IN — stopping.');
        console.log('\n  Sign into Search Console in this Chrome profile, then re-run.');
        break;
      }
      if (body.includes('quota') || body.includes('try again tomorrow')) {
        console.log('DAILY QUOTA REACHED — stopping.');
        console.log(`\n  ${submitted} submitted this run. Re-run tomorrow to continue.`);
        break;
      }

      const btn = page.getByRole('button', { name: /request indexing/i }).first();
      if (!(await btn.isVisible().catch(() => false))) {
        console.log('no "Request indexing" button (may already be indexed)');
        state.done.push(url); writeState(state);
        continue;
      }

      await btn.click();
      // Google runs a live test before accepting; it takes 10-30s.
      await page.waitForTimeout(3000);
      const done = page.getByText(/indexing requested|added to a priority crawl queue/i).first();
      await done.waitFor({ timeout: 90000 }).catch(() => {});

      const after = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (after.includes('quota') || after.includes('try again tomorrow')) {
        console.log('QUOTA REACHED mid-request — stopping.');
        break;
      }

      console.log('requested');
      state.done.push(url); writeState(state);
      submitted++;

      // Human-ish spacing between requests.
      await page.waitForTimeout(8000 + Math.random() * 7000);
    } catch (e) {
      console.log(`ERROR ${e.message.slice(0, 60)}`);
      state.failed = [...new Set([...state.failed, url])];
      writeState(state);
    }
  }

  console.log(`\n${submitted} submitted. ${all.length - state.done.length} still pending.`);
  console.log(`State: ${STATE}\n`);
  await ctx.close();
})().catch(e => { console.error(e); process.exit(1); });
