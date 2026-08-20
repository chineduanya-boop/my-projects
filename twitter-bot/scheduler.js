// scheduler.js — Auto-post tweets on a schedule
// Usage: node scheduler.js
//
// 7-day weekly cycle, 4 posts/day. All times UTC (WAT = UTC+1).
// After Sunday the cycle repeats from Monday.

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const tweets = require('./tweets');
const { attachImage } = require('./media');
const { appendHashtags } = require('./hashtags');
const { postToFacebook } = require('./facebook');

const PLATFORM = process.env.PLATFORM || 'twitter';

// State lives on a persistent volume when STATE_DIR is set (Railway mounts one at
// /data). Without it the container filesystem is ephemeral and every redeploy would
// restart the tweet queue from the top and re-post what already went out.
const STATE_DIR = process.env.STATE_DIR || __dirname;
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const DRY_RUN = process.env.DRY_RUN === 'true';
// Engagement (likes / follow-backs / auto-threads) is opt-in: the account owner
// handles all of that manually. The bot only publishes its 4 scheduled posts/day.
const ENGAGEMENT_ON = process.env.ENABLE_ENGAGEMENT === 'true';

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { posted: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Select tweet ──────────────────────────────────────────────────────────────

function selectNextTweet(state) {
  let unposted = tweets.filter(t => !state.posted.find(p => p.id === t.id));
  if (unposted.length === 0) {
    console.log('[Scheduler] All tweets cycled — resetting queue for next round.');
    state.posted = [];
    saveState(state);
    unposted = tweets;
  }
  // Pick randomly from unposted to vary the feed
  return unposted[Math.floor(Math.random() * unposted.length)];
}

// ── Post tweet ────────────────────────────────────────────────────────────────

async function postTweet() {
  const state = loadState();
  const tweet = selectNextTweet(state);
  const now = new Date().toISOString();

  console.log(`\n[${now}] Posting tweet ${tweet.id}...`);
  console.log(tweet.text.substring(0, 80) + '...\n');

  if (DRY_RUN) {
    console.log('[DRY RUN] Not sending. Set DRY_RUN=false to go live.');
    state.posted.push({ id: tweet.id, postedAt: now, dryRun: true });
    saveState(state);
    return;
  }

  try {
    const postText = appendHashtags(tweet.text, tweet.tags);

    if (PLATFORM === 'facebook') {
      const fbPostId = await postToFacebook(postText);
      console.log(`✓ Posted to Facebook: ${fbPostId}`);
      state.posted.push({
        id: tweet.id,
        fbPostId,
        postedAt: now,
        preview: tweet.text.substring(0, 60),
      });
    } else {
      const client = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
      });

      const mediaId = await attachImage(client, tweet.id);
      const tweetPayload = mediaId
        ? { text: postText, media: { media_ids: [mediaId] } }
        : postText;

      const result = await client.v2.tweet(tweetPayload);
      console.log(`✓ Posted${mediaId ? ' with image' : ''}: https://twitter.com/i/web/status/${result.data.id}`);
      state.posted.push({
        id: tweet.id,
        tweetId: result.data.id,
        postedAt: now,
        preview: tweet.text.substring(0, 60),
      });
    }

    saveState(state);
    console.log(`  Queue: ${state.posted.length}/${tweets.length} this cycle`);
  } catch (err) {
    console.error(`✗ Failed to post: ${err.message}`);
  }
}

// ── Schedule config (all times UTC, WAT = UTC+1) ─────────────────────────────

// 7-day weekly cycle — 4 posts per day, varied times each day
// JS day: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
const WEEKLY_SLOTS = {
  1: ['07:15', '11:40', '16:25', '20:10'], // Monday    → 08:15 12:40 17:25 21:10 WAT
  2: ['08:05', '12:20', '17:10', '21:30'], // Tuesday   → 09:05 13:20 18:10 22:30 WAT
  3: ['06:50', '10:55', '15:45', '19:35'], // Wednesday → 07:50 11:55 16:45 20:35 WAT
  4: ['07:35', '11:15', '16:55', '20:45'], // Thursday  → 08:35 12:15 17:55 21:45 WAT
  5: ['08:25', '13:05', '17:35', '22:00'], // Friday    → 09:25 14:05 18:35 23:00 WAT
  6: ['09:10', '14:30', '18:20', '21:15'], // Saturday  → 10:10 15:30 19:20 22:15 WAT
  0: ['07:55', '12:45', '16:10', '19:50'], // Sunday    → 08:55 13:45 17:10 20:50 WAT
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ENGAGE_SLOTS  = ['09:00', '19:00'];
const THREAD_DAYS   = [2, 5]; // Tue, Fri
const THREAD_SLOT   = '09:00';

console.log('╔══════════════════════════════════════════╗');
console.log('║   MangVault Twitter Bot — Scheduler v4   ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`Mode : ${DRY_RUN ? 'DRY RUN (no real posts)' : 'LIVE'}`);
console.log(`Queue: ${tweets.length} total tweets loaded`);
console.log('');
console.log('Weekly schedule (UTC / WAT = UTC+1):');
const dayOrder = [1,2,3,4,5,6,0];
dayOrder.forEach(d => {
  console.log(`  ${DAY_NAMES[d]}: ${WEEKLY_SLOTS[d].join(', ')} UTC`);
});
console.log('');
if (ENGAGEMENT_ON) {
  console.log('Engagement: ON — times (UTC): ' + ENGAGE_SLOTS.join(', '));
  console.log('Thread schedule (Tue + Fri at 09:00 UTC)');
} else {
  console.log('Engagement: OFF — posting only (likes / follows / replies are handled manually).');
}
console.log(`Next post : ${describeNextSlot()}`);

// Next scheduled slot, searched across the coming week.
function describeNextSlot() {
  const now = new Date();
  for (let ahead = 0; ahead < 8; ahead++) {
    const d = new Date(now.getTime() + ahead * 86400000);
    const day = d.getUTCDay();
    for (const slot of WEEKLY_SLOTS[day] || []) {
      const [h, m] = slot.split(':').map(Number);
      const when = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m));
      if (when > now) {
        const mins = Math.round((when - now) / 60000);
        return `${DAY_NAMES[day]} ${slot} UTC (in ${Math.floor(mins / 60)}h ${mins % 60}m)`;
      }
    }
  }
  return '(none found)';
}

// ── Engagement helpers ────────────────────────────────────────────────────────

function runScript(script, args = []) {
  return new Promise((resolve) => {
    execFile('node', [path.join(__dirname, script), ...args], (err, stdout, stderr) => {
      if (stdout) console.log(stdout.trim());
      if (stderr) console.error(stderr.trim());
      if (err) console.error(`[${script}] Error: ${err.message}`);
      resolve();
    });
  });
}

// ── Main interval loop ────────────────────────────────────────────────────────
// Checks every 60s whether it's time to post. Avoids node-cron timezone bugs
// on Windows by using UTC directly from Date.

// Fired slots are persisted in state.json so a host restart (redeploy, crash-loop)
// during a slot minute cannot fire the same slot a second time.

function hasFired(key) {
  const state = loadState();
  return Array.isArray(state.fired) && state.fired.includes(key);
}

function markFired(key) {
  const state = loadState();
  if (!Array.isArray(state.fired)) state.fired = [];
  state.fired.push(key);
  if (state.fired.length > 60) state.fired = state.fired.slice(-60); // ~2 weeks of slots
  saveState(state);
}

setInterval(() => {
  const now = new Date();
  const dateKey  = now.toISOString().slice(0, 10);              // "2026-08-20"
  const timeKey  = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`; // "07:15"
  const slotKey  = `${dateKey} ${timeKey}`;
  const dayOfWeek = now.getUTCDay(); // 0=Sun … 6=Sat

  const todaySlots = WEEKLY_SLOTS[dayOfWeek] || [];
  if (todaySlots.includes(timeKey) && !hasFired(slotKey)) {
    markFired(slotKey);
    console.log(`[${now.toISOString()}] ${DAY_NAMES[dayOfWeek]} post slot ${timeKey} UTC — firing now`);
    postTweet();
  }

  if (ENGAGEMENT_ON) {
    if (ENGAGE_SLOTS.includes(timeKey) && !hasFired(slotKey + ':engage')) {
      markFired(slotKey + ':engage');
      runScript('engage.js', ['--mentions', '--followback']);
    }
    if (timeKey === THREAD_SLOT && THREAD_DAYS.includes(dayOfWeek) && !hasFired(slotKey + ':thread')) {
      markFired(slotKey + ':thread');
      runScript('thread.js');
    }
  }
}, 60 * 1000);

console.log('\nBot is running. Press Ctrl+C to stop.\n');

// Optional: post immediately on startup for testing
if (process.argv.includes('--post-now')) {
  console.log('[--post-now] Firing one tweet immediately...');
  postTweet();
}

if (process.argv.includes('--engage-now')) {
  console.log('[--engage-now] Running engagement immediately...');
  runScript('engage.js', ['--mentions', '--followback']);
}

if (process.argv.includes('--thread-now')) {
  console.log('[--thread-now] Generating and posting a thread immediately...');
  runScript('thread.js');
}
