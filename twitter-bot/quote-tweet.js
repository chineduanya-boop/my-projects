// quote-tweet.js — Find trending manga/anime content and quote-tweet it
// Searches for popular posts in the niche and quote-tweets with a MangVault angle
//
// Usage:
//   node quote-tweet.js             → quote-tweet one post
//   node quote-tweet.js --count 3   → quote-tweet up to 3 posts

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === 'true';
const QT_STATE_FILE = path.join(__dirname, 'engage-state.json');

// ── Quote-tweet templates ─────────────────────────────────────────────────────
// Use {url} as placeholder for the tweet being quoted

const QT_TEMPLATES = [
  "This is exactly why manhwa is eating 🔥 Read the full series free at https://mangvault.com",
  "The manga/manhwa community never misses 🙌 More free titles at https://mangvault.com",
  "Facts. And you can read it all free at https://mangvault.com 👇",
  "The algorithm buried this but you deserve to see it. Also — free manga/manhwa → https://mangvault.com",
  "Manhwa readers stay winning 🏆 Catch up on all the best titles free → https://mangvault.com",
  "This thread is giving everything ✨ The manhwa version goes even harder — https://mangvault.com",
  "If you know, you know 🔥 For those who don't — start here free → https://mangvault.com",
  "The manhwa community is undefeated. Free titles at https://mangvault.com 👑",
];

// Search queries that find high-quality niche content to quote-tweet
const SEARCH_QUERIES = [
  'manhwa recommendation -is:retweet lang:en min_faves:50',
  'solo leveling manhwa -is:retweet lang:en min_faves:100',
  'best manga 2024 -is:retweet lang:en min_faves:50',
  'tower of god manhwa -is:retweet lang:en min_faves:50',
  'manhwa better than anime -is:retweet lang:en min_faves:30',
  'manga recommendation thread -is:retweet lang:en min_faves:50',
];

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(QT_STATE_FILE)) {
    return { lastMentionId: null, likedTweets: [], repliedTweets: [], followedUsers: [], quotedTweets: [] };
  }
  return JSON.parse(fs.readFileSync(QT_STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(QT_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Client ────────────────────────────────────────────────────────────────────

function getClient() {
  const required = ['TWITTER_API_KEY', 'TWITTER_API_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing env vars:', missing.join(', '));
    process.exit(1);
  }
  return new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Quote-tweet ───────────────────────────────────────────────────────────────

async function findAndQuoteTweet(client, state, maxCount) {
  const query = randomFrom(SEARCH_QUERIES);
  console.log(`\n[Quote-tweet] Searching: "${query}"`);

  const results = await client.v2.search(query, {
    max_results: 15,
    'tweet.fields': ['author_id', 'public_metrics'],
  });

  const posts = results.data?.data ?? [];

  if (posts.length === 0) {
    console.log('[Quote-tweet] No posts found for this query.');
    return 0;
  }

  // Filter out already-quoted posts
  const candidates = posts.filter(p => !state.quotedTweets.includes(p.id));

  if (candidates.length === 0) {
    console.log('[Quote-tweet] All results already quoted. Try again later.');
    return 0;
  }

  let count = 0;
  for (const post of candidates) {
    if (count >= maxCount) break;

    const tweetUrl = `https://twitter.com/i/web/status/${post.id}`;
    const quoteText = randomFrom(QT_TEMPLATES);

    console.log(`  → Quote-tweeting ${post.id}`);
    console.log(`     "${quoteText.substring(0, 70)}..."`);

    if (!DRY_RUN) {
      await client.v2.tweet({ text: quoteText, quote_tweet_id: post.id });
      state.quotedTweets.push(post.id);
      if (state.quotedTweets.length > 500) state.quotedTweets = state.quotedTweets.slice(-500);
      saveState(state);
      count++;
      await sleep(3000);
    } else {
      console.log(`     [DRY RUN] Not sending.`);
      count++;
    }
  }

  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const countFlag = args.indexOf('--count');
  const maxCount = countFlag !== -1 && args[countFlag + 1] ? parseInt(args[countFlag + 1], 10) : 1;

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MangVault Bot — Quote-Tweet Engine     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | Max: ${maxCount} quote-tweet(s)\n`);

  const client = getClient();
  const state = loadState();

  const count = await findAndQuoteTweet(client, state, maxCount);
  console.log(`\n✓ Quote-tweeted ${count} post(s).`);
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
