// engage.js — Interact with other X users
// Handles: reply to mentions, like+reply to hashtag posts, follow back followers
//
// Usage:
//   node engage.js                  → run all engagement tasks
//   node engage.js --mentions       → reply to mentions only
//   node engage.js --hashtags       → engage with hashtag posts only
//   node engage.js --followback     → follow back followers only

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === 'true';
const ENGAGE_STATE_FILE = path.join(__dirname, 'engage-state.json');

// ── Mention replies ───────────────────────────────────────────────────────────

const MENTION_REPLIES = [
  "You've got great taste 🔥 Check out more free titles at https://mangvault.com",
  "Facts! MangVault has all the best titles free — https://mangvault.com",
  "The manhwa community is built different 🙌 Read more free at https://mangvault.com",
  "Agreed! Start from chapter 1 free at https://mangvault.com",
  "Welcome to the rabbit hole 😅 More free manga/manhwa → https://mangvault.com",
  "You're not alone 😂 MangVault has 40+ free titles to keep you busy → https://mangvault.com",
  "The best stories are free at MangVault → https://mangvault.com",
];

// ── Hashtag reply templates ───────────────────────────────────────────────────

const HASHTAG_REPLIES = {
  SoloLeveling: [
    "Sung Jinwoo's glow-up never gets old 🔥 Read it free from ch.1 → https://mangvault.com/solo-leveling",
    "Shadow Monarch arc hits different in the manhwa 👑 Free at https://mangvault.com/solo-leveling",
  ],
  manhwa: [
    "If you haven't tried MangVault yet — 40+ manhwa titles, 100% free, no sign-up → https://mangvault.com",
    "The manhwa scene is seriously underrated 🔥 Read free at https://mangvault.com",
  ],
  manga: [
    "Great picks! MangVault has 40+ manga & manhwa titles all free → https://mangvault.com",
    "Manga readers know what's up 🙌 More free titles at https://mangvault.com",
  ],
  TowerOfGod: [
    "Bam's journey is one of the greatest stories ever written 🗼 Read free → https://mangvault.com/tower-of-god",
    "Tower of God has 600+ chapters of pure insanity — all free at https://mangvault.com/tower-of-god",
  ],
  ORV: [
    "ORV will break your heart in the best way 📖 Free at https://mangvault.com/omniscient-readers-viewpoint",
    "Kim Dokja is the most underrated protagonist in fiction. Change my mind. Free read → https://mangvault.com/omniscient-readers-viewpoint",
  ],
  anime: [
    "If you love anime, the manhwa source material goes even deeper 🔥 Free at https://mangvault.com",
    "Anime fans — the manga/manhwa versions go WAY harder. Free read → https://mangvault.com",
  ],
};

const DEFAULT_HASHTAG_REPLIES = [
  "Great taste! Check out more free manga & manhwa at https://mangvault.com 🔥",
  "The manhwa community is thriving 🙌 40+ free titles → https://mangvault.com",
];

// ── State ─────────────────────────────────────────────────────────────────────

function loadEngageState() {
  if (!fs.existsSync(ENGAGE_STATE_FILE)) {
    return { lastMentionId: null, likedTweets: [], repliedTweets: [], followedUsers: [] };
  }
  return JSON.parse(fs.readFileSync(ENGAGE_STATE_FILE, 'utf8'));
}

function saveEngageState(state) {
  fs.writeFileSync(ENGAGE_STATE_FILE, JSON.stringify(state, null, 2));
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

// ── Reply to mentions ─────────────────────────────────────────────────────────

async function replyToMentions(client, state) {
  console.log('\n[Mentions] Checking for new mentions...');

  try {
    const me = await client.v2.me();
    const params = { max_results: 10 };
    if (state.lastMentionId) params.since_id = state.lastMentionId;

    const mentions = await client.v2.userMentionTimeline(me.data.id, params);
    const tweets = mentions.data?.data ?? [];

    if (tweets.length === 0) {
      console.log('[Mentions] No new mentions.');
      return;
    }

    console.log(`[Mentions] Found ${tweets.length} new mention(s).`);

    for (const mention of tweets) {
      if (state.repliedTweets.includes(mention.id)) continue;

      const replyText = randomFrom(MENTION_REPLIES);
      console.log(`  → Replying to tweet ${mention.id}: "${replyText.substring(0, 60)}..."`);

      if (!DRY_RUN) {
        await client.v2.reply(replyText, mention.id);
        state.repliedTweets.push(mention.id);
        // Keep list bounded
        if (state.repliedTweets.length > 500) state.repliedTweets = state.repliedTweets.slice(-500);
      }
    }

    // Track highest ID so we don't re-process
    state.lastMentionId = tweets[0].id;
    saveEngageState(state);
    console.log('[Mentions] Done.');
  } catch (err) {
    console.error('[Mentions] Error:', err.message);
  }
}

// ── Engage with hashtags ──────────────────────────────────────────────────────

async function engageHashtags(client, state) {
  const hashtags = (process.env.ENGAGE_HASHTAGS || 'manhwa,SoloLeveling,manga,TowerOfGod,ORV,anime')
    .split(',').map(h => h.trim());

  const maxPerTag = parseInt(process.env.ENGAGE_PER_HASHTAG || '3', 10);

  console.log(`\n[Hashtags] Engaging with: ${hashtags.map(h => '#' + h).join(', ')}`);

  for (const tag of hashtags) {
    try {
      const results = await client.v2.search(`#${tag} -is:retweet -is:reply lang:en`, {
        max_results: 10,
        'tweet.fields': ['author_id', 'public_metrics'],
      });

      const posts = results.data?.data ?? [];
      let engaged = 0;

      for (const post of posts) {
        if (engaged >= maxPerTag) break;
        if (state.likedTweets.includes(post.id)) continue;
        if (state.repliedTweets.includes(post.id)) continue;

        const replies = HASHTAG_REPLIES[tag] || DEFAULT_HASHTAG_REPLIES;
        const replyText = randomFrom(replies);

        console.log(`  [#${tag}] Liking + replying to ${post.id}: "${replyText.substring(0, 50)}..."`);

        if (!DRY_RUN) {
          await client.v2.like(await getMyId(client), post.id);
          state.likedTweets.push(post.id);

          await client.v2.reply(replyText, post.id);
          state.repliedTweets.push(post.id);

          engaged++;
          // Throttle to avoid rate limits
          await sleep(2000);
        } else {
          engaged++;
        }
      }

      // Keep lists bounded
      if (state.likedTweets.length > 1000) state.likedTweets = state.likedTweets.slice(-1000);
      if (state.repliedTweets.length > 1000) state.repliedTweets = state.repliedTweets.slice(-1000);

      saveEngageState(state);
      console.log(`  [#${tag}] Engaged with ${engaged} post(s).`);

      await sleep(3000);
    } catch (err) {
      console.error(`  [#${tag}] Error:`, err.message);
    }
  }
}

// ── Follow back followers ─────────────────────────────────────────────────────

async function followBackFollowers(client, state) {
  console.log('\n[Follow-back] Checking followers...');

  try {
    const me = await client.v2.me();
    const followers = await client.v2.followers(me.data.id, { max_results: 100 });
    const followerList = followers.data?.data ?? [];

    if (followerList.length === 0) {
      console.log('[Follow-back] No followers found.');
      return;
    }

    let followed = 0;
    for (const user of followerList) {
      if (state.followedUsers.includes(user.id)) continue;

      console.log(`  → Following back @${user.username || user.id}`);

      if (!DRY_RUN) {
        await client.v2.follow(me.data.id, user.id);
        state.followedUsers.push(user.id);
        followed++;
        await sleep(1500);
      } else {
        followed++;
      }
    }

    if (state.followedUsers.length > 5000) state.followedUsers = state.followedUsers.slice(-5000);
    saveEngageState(state);
    console.log(`[Follow-back] Followed back ${followed} user(s).`);
  } catch (err) {
    console.error('[Follow-back] Error:', err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _myId = null;
async function getMyId(client) {
  if (!_myId) {
    const me = await client.v2.me();
    _myId = me.data.id;
  }
  return _myId;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const runAll = args.length === 0;

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MangVault Bot — Engagement Engine      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const client = getClient();
  const state = loadEngageState();

  if (runAll || args.includes('--mentions')) {
    await replyToMentions(client, state);
  }
  if (runAll || args.includes('--hashtags')) {
    await engageHashtags(client, state);
  }
  if (runAll || args.includes('--followback')) {
    await followBackFollowers(client, state);
  }

  console.log('\n✓ Engagement run complete.');
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
