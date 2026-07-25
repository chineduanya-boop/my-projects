#!/usr/bin/env node
/**
 * submit-sitemap.js — submits sitemap.xml to Google Search Console using your own
 * logged-in Chrome profile.
 *
 * One submission covers the whole index: sitemap-comics.xml, sitemap-genres.xml and
 * every sitemap-chapters-N.xml. This is the mechanism that gets the site crawled;
 * per-URL indexing requests are capped near 10/day and are a supplement at best.
 *
 * KNOWN LIMITATION — this cannot drive your everyday Chrome session.
 * Modern Chrome refuses remote debugging on the default user-data-dir:
 *   "DevTools remote debugging requires a non-default data directory."
 *
 * The restriction is on the DATA DIRECTORY, not the profile inside it, so
 * --profile "Profile 1" does not help — every profile under your normal Chrome
 * directory is equally blocked. A fresh --user-data-dir launches fine but starts
 * signed out, and signing in would mean typing a password into an automated
 * browser, which defeats the point.
 *
 * Do NOT work around this by copying the profile directory or flipping the
 * RemoteDebuggingAllowed policy. The control exists to stop session theft, and it
 * protects every site you are signed into — not just Search Console.
 *
 * Practical options:
 *   1. Submit by hand: Search Console -> Sitemaps -> "sitemap.xml" -> Submit.
 *   2. Use the Claude in Chrome extension (claude.ai/chrome), which works with the
 *      live session through the extension API rather than CDP.
 *   3. Search Console API with a service account, if this ever needs to be
 *      genuinely automated on a schedule.
 *
 * Chrome must be FULLY CLOSED — it holds an exclusive lock on the profile directory.
 * The script reuses the Google session already signed into that profile and never
 * handles credentials.
 *
 *   node submit-sitemap.js              open the Sitemaps page and report state
 *   node submit-sitemap.js --go         actually submit
 *   node submit-sitemap.js --go --profile "Profile 1"
 */

const path = require('path');
const os = require('os');

function loadPlaywright() {
  for (const c of ['playwright', path.join(__dirname, '..', 'twitter-bot', 'node_modules', 'playwright')]) {
    try { return require(c); } catch {}
  }
  console.error('playwright not found.'); process.exit(1);
}
const { chromium } = loadPlaywright();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => { const i = argv.indexOf(`--${f}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const GO       = has('go');
const PROFILE  = val('profile', 'Default');
const RESOURCE = val('resource', 'https://mangvault.com/');
const SITEMAP  = val('sitemap', 'sitemap.xml');
const USER_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const SHOT     = val('shot', path.join(process.env.TEMP || '.', 'gsc-sitemap.png'));

(async () => {
  console.log(`\nOpening Chrome profile "${PROFILE}"…`);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(USER_DIR, {
      channel: 'chrome',
      headless: false,
      args: [`--profile-directory=${PROFILE}`],
      viewport: { width: 1400, height: 950 },
    });
  } catch (e) {
    console.error(`Could not open the profile: ${e.message}`);
    console.error('Close every Chrome window (check the system tray) and retry.');
    process.exit(1);
  }

  const page = ctx.pages()[0] || await ctx.newPage();
  const url = `https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(RESOURCE)}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    if (page.url().includes('accounts.google.com')) {
      console.log('\nNot signed in to Google in this profile.');
      console.log('Sign in to Search Console in this window, then re-run with --go.');
      await page.waitForTimeout(30000);
      await ctx.close();
      return;
    }

    const body = await page.locator('body').innerText().catch(() => '');
    if (/don't have access|no access|not verified/i.test(body)) {
      console.log(`\nThis profile has no access to ${RESOURCE} in Search Console.`);
      console.log('Try a different profile with --profile "Profile 1".');
      await ctx.close();
      return;
    }

    console.log('Search Console Sitemaps page loaded.');
    console.log('\nExisting submissions:');
    console.log(body.split('\n').filter(Boolean).slice(0, 25).map(l => '  ' + l).join('\n'));

    if (!GO) {
      await page.screenshot({ path: SHOT });
      console.log(`\nScreenshot: ${SHOT}`);
      console.log('Re-run with --go to submit.\n');
      await page.waitForTimeout(5000);
      await ctx.close();
      return;
    }

    // The "Add a new sitemap" field. GSC's DOM is generated, so try a few handles.
    const input = page.locator('input[type="text"]').first();
    await input.waitFor({ timeout: 20000 });
    await input.click();
    await input.fill(SITEMAP);
    console.log(`\nEntered "${SITEMAP}".`);

    const submit = page.getByRole('button', { name: /^submit$/i }).first();
    await submit.waitFor({ timeout: 15000 });
    await submit.click();
    console.log('Clicked Submit — waiting for Google to fetch it…');

    await page.waitForTimeout(12000);
    const after = await page.locator('body').innerText().catch(() => '');

    if (/success/i.test(after)) console.log('\nSubmitted successfully.');
    else if (/couldn't fetch|could not fetch|error/i.test(after)) console.log('\nGoogle reported a fetch problem — see the screenshot.');
    else console.log('\nSubmitted; Google has not reported a status yet (this is normal).');

    await page.screenshot({ path: SHOT });
    console.log(`Screenshot: ${SHOT}`);
    console.log('\nRelevant page text:');
    console.log(after.split('\n').filter(Boolean).slice(0, 30).map(l => '  ' + l).join('\n'));

    await page.waitForTimeout(4000);
  } catch (e) {
    console.error(`\nFailed: ${e.message}`);
    await page.screenshot({ path: SHOT }).catch(() => {});
    console.error(`Screenshot: ${SHOT}`);
  } finally {
    await ctx.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
