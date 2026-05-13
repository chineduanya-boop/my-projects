// fb-scheduler.js — Independent scheduler for posting to Facebook Groups
// Usage: node fb-scheduler.js
//
// Runs completely separately from the Twitter bot (scheduler.js).
// Pulls posts from the same tweets.js bank and posts to every group
// listed in FB_GROUP_IDS at the same WAT peak-hour slots.
//
// Schedule: 3 posts/day at peak WAT hours (UTC+1), each with ±20-min jitter
//   09:00 UTC = 10am WAT   13:00 UTC = 2pm WAT   20:00 UTC = 9pm WAT

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const tweets            = require('./tweets');
const { appendHashtags } = require('./hashtags');
const { postToGroups }  = require('./fb-playwright');

const STATE_FILE = path.join(__dirname, 'fb-groups-state.json');
const DRY_RUN    = process.env.DRY_RUN === 'true';

// ── State ──────────────────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { posted: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Select next post ───────────────────────────────────────────────────────────

function selectNextPost(state) {
  let unposted = tweets.filter(t => !state.posted.find(p => p.id === t.id));
  if (unposted.length === 0) {
    console.log('[FB Scheduler] All posts cycled — resetting queue for next round.');
    state.posted = [];
    saveState(state);
    unposted = tweets;
  }
  return unposted[Math.floor(Math.random() * unposted.length)];
}

// ── Post to all groups ─────────────────────────────────────────────────────────

async function postToAllGroups() {
  const state = loadState();
  const post  = selectNextPost(state);
  const now   = new Date().toISOString();

  console.log(`\n[${now}] Posting to Facebook groups — post ${post.id}...`);
  console.log(post.text.substring(0, 80) + '...\n');

  if (DRY_RUN) {
    console.log('[DRY RUN] Not sending. Set DRY_RUN=false to go live.');
    state.posted.push({ id: post.id, postedAt: now, dryRun: true });
    saveState(state);
    return;
  }

  try {
    // Facebook has no 280-char limit — pass full text with hashtags
    const postText = appendHashtags(post.text, post.tags);
    const results  = await postToGroups(postText);

    const successCount = results.filter(r => r.ok).length;
    console.log(`✓ Posted to ${successCount}/${results.length} groups`);

    state.posted.push({
      id: post.id,
      postedAt: now,
      preview: post.text.substring(0, 60),
      groups: results,
    });
    saveState(state);
    console.log(`  Queue: ${state.posted.length}/${tweets.length} this cycle`);
  } catch (err) {
    console.error(`✗ Failed to post: ${err.message}`);
  }
}

// ── Schedule ───────────────────────────────────────────────────────────────────

const POST_SLOTS = ['09:00', '13:00', '20:00']; // 10am, 2pm, 9pm WAT

console.log('╔══════════════════════════════════════════╗');
console.log('║  MangVault Facebook Groups Scheduler v2  ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`Mode  : ${DRY_RUN ? 'DRY RUN (no real posts)' : 'LIVE'}`);
console.log(`Posts : ${tweets.length} total loaded`);
console.log(`Groups: ${(process.env.FB_GROUP_IDS || '').split(',').filter(Boolean).length} configured`);
console.log('');
console.log('Scheduled post times (WAT / UTC+1, ±20 min jitter):');
POST_SLOTS.forEach(t => console.log(`  • ${t} UTC`));
console.log('');

const firedSlots = new Set();

setInterval(() => {
  const now     = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const timeKey = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const slotKey = `${dateKey} ${timeKey}`;

  if (firedSlots.has(slotKey)) return;

  if (POST_SLOTS.includes(timeKey)) {
    firedSlots.add(slotKey);
    const jitterMs = Math.floor(Math.random() * 20 * 60 * 1000);
    console.log(`[${new Date().toISOString()}] Post slot ${timeKey} UTC — firing in ${Math.round(jitterMs / 60000)}min`);
    setTimeout(() => postToAllGroups(), jitterMs);
  }

  // Trim old slot keys at midnight
  if (timeKey === '00:01') {
    for (const key of firedSlots) {
      if (!key.startsWith(dateKey)) firedSlots.delete(key);
    }
  }
}, 60 * 1000);

console.log('Bot is running. Press Ctrl+C to stop.\n');

// Optional: fire immediately for testing
if (process.argv.includes('--post-now')) {
  console.log('[--post-now] Firing one post immediately...');
  postToAllGroups();
}
