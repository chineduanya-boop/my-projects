// fb-login.js — One-time Facebook login to save a browser session
// Run this once:  node fb-login.js
//
// A browser window will open. Log in to Facebook normally.
// When done, the session is saved to fb-session.json AND printed as a
// base64 string so you can paste it into Railway as the FB_SESSION env var.

require('dotenv').config();
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'fb-session.json');

(async () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        Facebook Session Login            ║');
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('Opening browser... Log in to Facebook, then come back here.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });

  console.log('Waiting for login... (you have 3 minutes)');
  await page.waitForSelector('[aria-label="Your profile"]', { timeout: 180000 });

  console.log('\n✓ Logged in! Saving session...');
  await context.storageState({ path: SESSION_FILE });
  await browser.close();

  const sessionJson = fs.readFileSync(SESSION_FILE, 'utf-8');
  const encoded     = Buffer.from(sessionJson).toString('base64');

  console.log(`✓ Session saved to fb-session.json\n`);
  console.log('══════════════════════════════════════════════════════════');
  console.log('  RAILWAY SETUP — copy the value below into Railway as:');
  console.log('  Variable name:  FB_SESSION');
  console.log('══════════════════════════════════════════════════════════');
  console.log(encoded);
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('Next steps:');
  console.log('  Local test : node fb-scheduler.js --post-now');
  console.log('  Railway    : paste FB_SESSION value above into your Railway service env vars');
})();
