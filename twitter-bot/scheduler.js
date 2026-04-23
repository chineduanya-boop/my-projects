// scheduler.js — Auto-post tweets on a cron schedule
// Usage: node scheduler.js
//
// Schedule: 10 posts/day spread across peak WAT hours (UTC+1)
//   06:00 UTC = 7am WAT    08:00 UTC = 9am WAT
//   09:00 UTC = 10am WAT   11:00 UTC = 12pm WAT
//   12:00 UTC = 1pm WAT    14:00 UTC = 3pm WAT
//   16:00 UTC = 5pm WAT    18:00 UTC = 7pm WAT
//   20:00 UTC = 9pm WAT    22:00 UTC = 11pm WAT

require('dotenv').config();
const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const tweets = require('./tweets');
const { attachImage } = require('./media');
const { appendHashtags } = require('./hashtags');

const STATE_FILE = path.join(__dirname, 'state.json');
const DRY_RUN = process.env.DRY_RUN === 'true';

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
    const client = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY,
      appSecret: process.env.TWITTER_API_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_SECRET,
    });

    const tweetText = appendHashtags(tweet.text, tweet.tags);
    const mediaId = await attachImage(client, tweet.id);
    const tweetPayload = mediaId
      ? { text: tweetText, media: { media_ids: [mediaId] } }
      : tweetText;

    const result = await client.v2.tweet(tweetPayload);
    console.log(`✓ Posted${mediaId ? ' with image' : ''}: https://twitter.com/i/web/status/${result.data.id}`);

    state.posted.push({
      id: tweet.id,
      tweetId: result.data.id,
      postedAt: now,
      preview: tweet.text.substring(0, 60),
    });
    saveState(state);
    console.log(`  Queue: ${state.posted.length}/${tweets.length} this cycle`);
  } catch (err) {
    console.error(`✗ Failed to post: ${err.message}`);
  }
}

// ── Cron schedule ─────────────────────────────────────────────────────────────
// Times are UTC. Nigeria (WAT) is UTC+1.

const SCHEDULES = [
  { label: '7am WAT',  cron: '0 6 * * *'  },
  { label: '9am WAT',  cron: '0 8 * * *'  },
  { label: '10am WAT', cron: '0 9 * * *'  },
  { label: '12pm WAT', cron: '0 11 * * *' },
  { label: '1pm WAT',  cron: '0 12 * * *' },
  { label: '3pm WAT',  cron: '0 14 * * *' },
  { label: '5pm WAT',  cron: '0 16 * * *' },
  { label: '7pm WAT',  cron: '0 18 * * *' },
  { label: '9pm WAT',  cron: '0 20 * * *' },
  { label: '11pm WAT', cron: '0 22 * * *' },
];

console.log('╔══════════════════════════════════════════╗');
console.log('║   MangVault Twitter Bot — Scheduler v2   ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`Mode : ${DRY_RUN ? 'DRY RUN (no real posts)' : 'LIVE'}`);
console.log(`Queue: ${tweets.length} total tweets loaded`);
console.log('');
console.log('Scheduled post times (WAT / UTC+1):');


SCHEDULES.forEach(({ label, cron: schedule }) => {
  console.log(`  • ${label}  [${schedule}]`);
  cron.schedule(schedule, () => postTweet(), { timezone: 'UTC' });
});

// ── Engagement schedule ───────────────────────────────────────────────────────
// Runs engagement (mentions, hashtags, follow-back) 3x/day
// Runs quote-tweet once/day

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

// Engagement: replies to mentions + follow-back, 2x/day
const ENGAGE_SCHEDULES = [
  { label: 'Engage 10am WAT', cron: '0 9 * * *'  },
  { label: 'Engage 8pm WAT',  cron: '0 19 * * *' },
];

// Threads 2x/week — Tue and Fri at 10am WAT. High-engagement content that builds followers fast.
const THREAD_SCHEDULES = [
  { label: 'Thread Tuesday 10am WAT', cron: '0 9 * * 2' },
  { label: 'Thread Friday 10am WAT',  cron: '0 9 * * 5' },
];

if (process.env.ENABLE_ENGAGEMENT !== 'false') {
  console.log('\nEngagement times (WAT / UTC+1):');
  ENGAGE_SCHEDULES.forEach(({ label, cron: schedule }) => {
    console.log(`  • ${label}  [${schedule}]`);
    cron.schedule(schedule, () => runScript('engage.js', ['--mentions', '--followback']), { timezone: 'UTC' });
  });

  console.log('\nThread schedule (2x/week):');
  THREAD_SCHEDULES.forEach(({ label, cron: schedule }) => {
    console.log(`  • ${label}  [${schedule}]`);
    cron.schedule(schedule, () => runScript('thread.js'), { timezone: 'UTC' });
  });
}

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
