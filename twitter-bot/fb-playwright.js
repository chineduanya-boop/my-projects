// fb-playwright.js — Post to Facebook Groups via browser automation (Playwright)
// No API tokens needed. Uses a saved browser session (fb-session.json).
//
// Local setup:  node fb-login.js  (once, to save your session)
// Cloud setup:  set FB_SESSION env var to the base64 value printed by fb-login.js

require('dotenv').config();
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'fb-session.json');
const HEADLESS     = process.env.FB_HEADLESS !== 'false'; // default: true

// On Linux (Railway/cloud), Chrome requires --no-sandbox
const LAUNCH_ARGS = process.platform === 'linux'
  ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  : [];

// ── Session bootstrap ─────────────────────────────────────────────────────────
// If running on a cloud server, the session comes from the FB_SESSION env var
// (base64-encoded JSON set in Railway). Write it to disk once per process start.

function loadSession() {
  if (!fs.existsSync(SESSION_FILE) && process.env.FB_SESSION) {
    console.log('[FB] Restoring session from FB_SESSION env var...');
    const json = Buffer.from(process.env.FB_SESSION, 'base64').toString('utf-8');
    fs.writeFileSync(SESSION_FILE, json, 'utf-8');
  }

  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(
      'No saved Facebook session found.\n' +
      'Run:  node fb-login.js  to log in and save your session, then set\n' +
      'FB_SESSION in your Railway environment variables.'
    );
  }
}

// ── Core posting logic ────────────────────────────────────────────────────────

async function postToGroup(page, groupId, text) {
  await page.goto(`https://www.facebook.com/groups/${groupId}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Open the post composer
  await page.getByRole('button', { name: 'Write something...' }).click();

  // Wait for the dialog to appear
  const dialog = page.getByRole('dialog', { name: 'Create post' });
  await dialog.waitFor({ timeout: 10000 });

  // Type into the contenteditable textbox
  const textbox = dialog.getByRole('textbox');
  await textbox.click();
  await page.keyboard.type(text, { delay: 8 });

  // Wait for the Post button to become enabled (Facebook enables it after input)
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('[role="dialog"] button'));
    const postBtn = btns.find(b => b.textContent.trim() === 'Post');
    return postBtn && !postBtn.disabled && postBtn.getAttribute('aria-disabled') !== 'true';
  }, { timeout: 10000 });

  await page.getByRole('dialog', { name: 'Create post' })
            .getByRole('button', { name: 'Post' })
            .click();

  // Wait for dialog to close — confirmation that post was submitted
  await dialog.waitFor({ state: 'hidden', timeout: 20000 });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function postToGroups(text) {
  loadSession();

  const groupIds = (process.env.FB_GROUP_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (groupIds.length === 0) {
    throw new Error('FB_GROUP_IDS not set in .env');
  }

  const browser = await chromium.launch({ headless: HEADLESS, args: LAUNCH_ARGS });
  const context = await browser.newContext({ storageState: SESSION_FILE });
  const page    = await context.newPage();

  page.on('dialog', d => d.dismiss().catch(() => {}));

  const results = [];

  try {
    for (let i = 0; i < groupIds.length; i++) {
      const groupId = groupIds[i];
      try {
        await postToGroup(page, groupId, text);
        console.log(`  ✓ Posted to group ${groupId}`);
        results.push({ groupId, ok: true });
      } catch (err) {
        console.error(`  ✗ Failed for group ${groupId}: ${err.message}`);
        results.push({ groupId, ok: false, error: err.message });
      }

      if (i < groupIds.length - 1) {
        await page.waitForTimeout(4000 + Math.floor(Math.random() * 3000));
      }
    }

    // Refresh session cookies so they don't expire
    await context.storageState({ path: SESSION_FILE });
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { postToGroups };
