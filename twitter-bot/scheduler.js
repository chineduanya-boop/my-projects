// scheduler.js — Auto-post tweets on a cron schedule
// Usage: node scheduler.js
//
// Default schedule: 5 posts/day at peak Twitter hours (UTC)
//   07:00 UTC = 8am WAT (Nigeria)  / 2am EST
//   09:00 UTC = 10am WAT           / 4am EST
//   12:00 UTC = 1pm WAT            / 7am EST
//   16:00 UTC = 5pm WAT            / 11am EST
//   20:00 UTC = 9pm WAT            / 3pm EST

require('dotenv').config();
const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const tweets = require('./tweets');
const { attachImage } = require('./media');

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

    const mediaId = await attachImage(client, tweet.id);
    const tweetPayload = mediaId
      ? { text: tweet.text, media: { media_ids: [mediaId] } }
      : tweet.text;

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
// Times are UTC — adjust if your server runs in a different timezone.
// Nigeria (WAT) is UTC+1. These fire at 9am, 12pm, 5pm, 9pm WAT.

const SCHEDULES = [
  { label: '8am WAT',  cron: '0 7 * * *'  },
  { label: '10am WAT', cron: '0 9 * * *'  },
  { label: '1pm WAT',  cron: '0 12 * * *' },
  { label: '5pm WAT',  cron: '0 16 * * *' },
  { label: '9pm WAT',  cron: '0 20 * * *' },
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

const ENGAGE_SCHEDULES = [
  { label: 'Engage 7am WAT',   cron: '0 6 * * *'   },
  { label: 'Engage 9am WAT',   cron: '30 8 * * *'  },
  { label: 'Engage 11am WAT',  cron: '0 10 * * *'  },
  { label: 'Engage 1pm WAT',   cron: '0 12 * * *'  },
  { label: 'Engage 3pm WAT',   cron: '30 14 * * *' },
  { label: 'Engage 5pm WAT',   cron: '0 16 * * *'  },
  { label: 'Engage 7pm WAT',   cron: '0 18 * * *'  },
  { label: 'Engage 9pm WAT',   cron: '0 20 * * *'  },
  { label: 'Engage 11pm WAT',  cron: '0 22 * * *'  },
  { label: 'Engage 1am WAT',   cron: '0 0 * * *'   },
];

const QT_SCHEDULE = { label: 'Quote-tweet 2pm WAT', cron: '0 13 * * *' };

if (process.env.ENABLE_ENGAGEMENT !== 'false') {
  console.log('\nEngagement times (WAT / UTC+1):');
  ENGAGE_SCHEDULES.forEach(({ label, cron: schedule }) => {
    console.log(`  • ${label}  [${schedule}]`);
    cron.schedule(schedule, () => runScript('engage.js'), { timezone: 'UTC' });
  });

  console.log(`  • ${QT_SCHEDULE.label}  [${QT_SCHEDULE.cron}]`);
  cron.schedule(QT_SCHEDULE.cron, () => runScript('quote-tweet.js'), { timezone: 'UTC' });
}

console.log('\nBot is running. Press Ctrl+C to stop.\n');

// Optional: post immediately on startup for testing
if (process.argv.includes('--post-now')) {
  console.log('[--post-now] Firing one tweet immediately...');
  postTweet();
}

if (process.argv.includes('--engage-now')) {
  console.log('[--engage-now] Running engagement immediately...');
  runScript('engage.js');
}

if (process.argv.includes('--quote-now')) {
  console.log('[--quote-now] Running quote-tweet immediately...');
  runScript('quote-tweet.js');
}
