// post-now.js — Post one tweet immediately
// Usage:
//   node post-now.js              → posts next unposted tweet in the queue
//   node post-now.js --id sl-01  → posts a specific tweet by ID
//   node post-now.js --random    → posts a random unposted tweet

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');
const tweets = require('./tweets');
const { attachImage } = require('./media');

const STATE_FILE = path.join(__dirname, 'state.json');
const DRY_RUN = process.env.DRY_RUN === 'true';

// ── State management ──────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { posted: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function markPosted(state, id, text) {
  state.posted.push({ id, text: text.substring(0, 60) + '...', postedAt: new Date().toISOString() });
  saveState(state);
}

// ── Tweet selection ───────────────────────────────────────────────────────────

function selectTweet(state) {
  const args = process.argv.slice(2);

  // --id <tweet-id>
  const idFlag = args.indexOf('--id');
  if (idFlag !== -1 && args[idFlag + 1]) {
    const tweet = tweets.find(t => t.id === args[idFlag + 1]);
    if (!tweet) { console.error(`Tweet ID "${args[idFlag + 1]}" not found.`); process.exit(1); }
    return tweet;
  }

  const unposted = tweets.filter(t => !state.posted.find(p => p.id === t.id));

  if (unposted.length === 0) {
    console.log('All tweets have been posted! Resetting the queue...');
    state.posted = [];
    saveState(state);
    return tweets[0];
  }

  // --random
  if (args.includes('--random')) {
    return unposted[Math.floor(Math.random() * unposted.length)];
  }

  // Default: next in queue
  return unposted[0];
}

// ── Twitter client ────────────────────────────────────────────────────────────

function getClient() {
  const required = ['TWITTER_API_KEY', 'TWITTER_API_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing.join(', '));
    console.error('Copy .env.example to .env and fill in your Twitter credentials.');
    process.exit(1);
  }
  return new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  const tweet = selectTweet(state);

  console.log('\n─────────────────────────────────────────');
  console.log(`Tweet ID : ${tweet.id}`);
  console.log(`Tags     : ${(tweet.tags || []).map(t => '#' + t).join(' ')}`);
  console.log('─────────────────────────────────────────');
  console.log(tweet.text);
  console.log('─────────────────────────────────────────\n');

  if (DRY_RUN) {
    console.log('[DRY RUN] Tweet NOT sent. Set DRY_RUN=false in .env to post for real.');
    return;
  }

  const client = getClient();
  const mediaId = await attachImage(client, tweet.id);
  const tweetPayload = mediaId
    ? { text: tweet.text, media: { media_ids: [mediaId] } }
    : tweet.text;

  const result = await client.v2.tweet(tweetPayload);
  console.log(`✓ Posted${mediaId ? ' with image' : ''}! Tweet ID: ${result.data.id}`);
  console.log(`  https://twitter.com/i/web/status/${result.data.id}`);

  markPosted(state, tweet.id, tweet.text);
  console.log(`  Queue: ${state.posted.length}/${tweets.length} posted`);
}

main().catch(err => {
  console.error('Error posting tweet:', err.message || err);
  if (err.data) console.error('Twitter error detail:', JSON.stringify(err.data, null, 2));
  if (err.code) console.error('HTTP code:', err.code);
  process.exit(1);
});
