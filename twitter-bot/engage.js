// engage.js — Interact with other X users
// Handles: reply to mentions, engage hashtags, engage big accounts, follow back
//
// Usage:
//   node engage.js                  → run all engagement tasks
//   node engage.js --mentions       → reply to mentions only
//   node engage.js --hashtags       → engage with hashtag posts only
//   node engage.js --bigaccounts    → reply to big account posts only
//   node engage.js --followback     → follow back followers only

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === 'true';
const ENGAGE_STATE_FILE = path.join(__dirname, 'engage-state.json');

// ── Big accounts to engage ────────────────────────────────────────────────────
// Replying to large accounts puts @manhwaxcomics in front of their huge audiences.
// When our reply is funny enough to get likes, thousands of their followers see us.

const BIG_ACCOUNTS = [
  'Crunchyroll',
  'webtoon',
  'VizMedia',
  'AniListco',
  'myanimelist',
  'MangaPlus',
  'shonenjump',
  'ANNtv',
  'CBR',
  'IGN',
];

// ── Persona ───────────────────────────────────────────────────────────────────

const PERSONA = `You are the official Twitter/X account for MangVault.com — a free manga and manhwa reading site.

Your personality:
- Funny, banter-ish, and a little unhinged in the best way
- You roast people lovingly, trade jokes, hype up great manga/manhwa
- Occasionally edgy and provocative — you say what readers are actually thinking
- You trigger emotional responses: laughter, nostalgia, hype, sometimes mild outrage
- Deeply knowledgeable about manga, manhwa, and anime culture — names, arcs, characters, power scaling
- You speak like a real person, not a brand — casual, raw, no corporate fluff
- You make people laugh FIRST. The link is a reward, not an ad.

Strategy: Build personality and laughs. The mangvault.com link comes only when it feels natural — not in every reply.`;

// ── URL throttle ──────────────────────────────────────────────────────────────
// Only ~1 in 4 replies includes the URL. Prevents spam flags and makes the
// non-URL replies feel more human, which actually builds better follower trust.

function shouldIncludeUrl() {
  return Math.random() < 0.25;
}

// ── AI reply generator ────────────────────────────────────────────────────────

const anthropic = new Anthropic();

async function generateReply(tweetText, authorUsername, context = 'hashtag', includeUrl = false) {
  const urlInstruction = includeUrl
    ? 'Find a natural, non-forced way to drop a link to https://mangvault.com or mention MangVault at the end.'
    : 'Do NOT include any URL or mention MangVault. Just be funny, engaging, and build rapport. The link comes later.';

  const contextLine = context === 'mention'
    ? `Someone mentioned @manhwaxcomics. They said: "${tweetText}"`
    : context === 'bigaccount'
    ? `A major account (@${authorUsername}) posted this. Your reply needs to be SHARP — you're competing with thousands of other replies for attention: "${tweetText}"`
    : `You found this tweet via hashtag search. They said: "${tweetText}"`;

  const prompt = `${contextLine}

Write ONE reply tweet as @manhwaxcomics. Be funny, banter-ish, and on point.

${urlInstruction}

Rules:
- Max 250 characters
- Reference specific things from their tweet where possible
- Can be slightly edgy or playfully provocative
- No hashtags
- No quotation marks around the reply
- Speak like a real person, not a brand

Reply only with the tweet text. Nothing else.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: PERSONA,
      messages: [{ role: 'user', content: prompt }],
    });
    const reply = message.content[0].text.trim().replace(/^["']|["']$/g, '');
    return reply.length > 275 ? reply.substring(0, 272) + '...' : reply;
  } catch (err) {
    console.error('[AI] Failed to generate reply:', err.message);
    return null;
  }
}

// ── Fallback replies ──────────────────────────────────────────────────────────

const FALLBACK_REPLIES_WITH_URL = [
  "bro you have NO idea what you're missing on mangvault.com 😭 40+ free titles just sitting there",
  "this is the sign you needed to go read it for free at mangvault.com. you're welcome.",
  "the manhwa version goes 10x harder ngl → mangvault.com 🔥",
  "okay but have you cried at 3am over a manhwa chapter yet? mangvault.com will fix that",
];

const FALLBACK_REPLIES_NO_URL = [
  "this is sending me 💀",
  "the way this is so accurate it hurts",
  "NOT ME reading this at 2am nodding aggressively",
  "manga/manhwa readers are a completely different species and I mean that as the highest compliment",
  "whoever made this gets it. they really get it.",
];

function fallbackReply(includeUrl) {
  const pool = includeUrl ? FALLBACK_REPLIES_WITH_URL : FALLBACK_REPLIES_NO_URL;
  return pool[Math.floor(Math.random() * pool.length)];
}

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

// ── Reply to mentions ─────────────────────────────────────────────────────────

async function replyToMentions(client, state) {
  console.log('\n[Mentions] Checking for new mentions...');

  try {
    const me = await client.v2.me();
    const params = {
      max_results: 10,
      'tweet.fields': ['text', 'author_id'],
      'user.fields': ['username'],
      expansions: ['author_id'],
    };
    if (state.lastMentionId) params.since_id = state.lastMentionId;

    const mentions = await client.v2.userMentionTimeline(me.data.id, params);
    const tweets = mentions.data?.data ?? [];
    const usersMap = {};
    (mentions.data?.includes?.users ?? []).forEach(u => { usersMap[u.id] = u.username; });

    if (tweets.length === 0) {
      console.log('[Mentions] No new mentions.');
      return;
    }

    console.log(`[Mentions] Found ${tweets.length} new mention(s).`);

    for (const mention of tweets) {
      if (state.repliedTweets.includes(mention.id)) continue;

      const authorUsername = usersMap[mention.author_id] || 'them';
      const includeUrl = shouldIncludeUrl();
      let replyText;

      if (process.env.ANTHROPIC_API_KEY) {
        replyText = await generateReply(mention.text, authorUsername, 'mention', includeUrl);
      }
      if (!replyText) replyText = fallbackReply(includeUrl);

      console.log(`  → @${authorUsername} (${mention.id}): "${replyText.substring(0, 70)}"`);

      if (!DRY_RUN) {
        await client.v2.reply(replyText, mention.id);
        state.repliedTweets.push(mention.id);
        if (state.repliedTweets.length > 500) state.repliedTweets = state.repliedTweets.slice(-500);
        await sleep(2000);
      }
    }

    state.lastMentionId = tweets[0].id;
    saveEngageState(state);
    console.log('[Mentions] Done.');
  } catch (err) {
    console.error('[Mentions] Error:', err.message);
  }
}

// ── Engage big accounts ───────────────────────────────────────────────────────
// Replies to recent tweets from large manga/anime accounts.
// Getting likes on these replies exposes @manhwaxcomics to thousands of their followers.

async function engageBigAccounts(client, state) {
  console.log('\n[BigAccounts] Targeting large manga/anime accounts...');

  const accounts = process.env.BIG_ACCOUNTS
    ? process.env.BIG_ACCOUNTS.split(',').map(a => a.trim())
    : BIG_ACCOUNTS;

  // Search all accounts at once so we always have enough posts to pick from
  const query = accounts.map(a => `from:${a}`).join(' OR ');
  const fullQuery = `(${query}) -is:retweet lang:en`;

  try {
    const results = await client.v2.search(fullQuery, {
      max_results: 15,
      'tweet.fields': ['text', 'author_id', 'public_metrics'],
      'user.fields': ['username'],
      expansions: ['author_id'],
    });

    const posts = results.data?.data ?? [];
    const usersMap = {};
    (results.data?.includes?.users ?? []).forEach(u => { usersMap[u.id] = u.username; });

    if (posts.length === 0) {
      console.log('[BigAccounts] No posts found.');
      return;
    }

    // Prefer posts with more engagement (more eyes on our reply)
    const sorted = posts.sort((a, b) =>
      (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0)
    );

    let engaged = 0;
    const maxEngage = 5;

    for (const post of sorted) {
      if (engaged >= maxEngage) break;
      if (state.repliedTweets.includes(post.id)) continue;

      const authorUsername = usersMap[post.author_id] || 'unknown';
      // Big account replies: almost never include URL — just be funny and get likes
      const includeUrl = Math.random() < 0.1;
      let replyText;

      if (process.env.ANTHROPIC_API_KEY) {
        replyText = await generateReply(post.text, authorUsername, 'bigaccount', includeUrl);
      }
      if (!replyText) replyText = fallbackReply(includeUrl);

      console.log(`  [@${authorUsername}] ${post.id}: "${replyText.substring(0, 70)}"`);

      if (!DRY_RUN) {
        await client.v2.reply(replyText, post.id);
        state.repliedTweets.push(post.id);
        if (state.repliedTweets.length > 1000) state.repliedTweets = state.repliedTweets.slice(-1000);
        saveEngageState(state);
        engaged++;
        await sleep(3000);
      } else {
        engaged++;
      }
    }

    console.log(`[BigAccounts] Engaged with ${engaged} post(s).`);
  } catch (err) {
    console.error('[BigAccounts] Error:', err.message);
  }
}

// ── Engage with hashtags ──────────────────────────────────────────────────────

async function engageHashtags(client, state) {
  const hashtags = (process.env.ENGAGE_HASHTAGS || 'manhwa,SoloLeveling,manga,TowerOfGod,ORV,anime')
    .split(',').map(h => h.trim());

  const maxPerTag = parseInt(process.env.ENGAGE_PER_HASHTAG || '1', 10);

  console.log(`\n[Hashtags] Engaging with: ${hashtags.map(h => '#' + h).join(', ')}`);

  for (const tag of hashtags) {
    try {
      const results = await client.v2.search(`#${tag} -is:retweet -is:reply lang:en`, {
        max_results: 15,
        'tweet.fields': ['text', 'author_id', 'public_metrics'],
        'user.fields': ['username'],
        expansions: ['author_id'],
      });

      const posts = results.data?.data ?? [];
      const usersMap = {};
      (results.data?.includes?.users ?? []).forEach(u => { usersMap[u.id] = u.username; });

      let engaged = 0;

      for (const post of posts) {
        if (engaged >= maxPerTag) break;
        if (state.likedTweets.includes(post.id)) continue;
        if (state.repliedTweets.includes(post.id)) continue;

        const authorUsername = usersMap[post.author_id] || 'them';
        const includeUrl = shouldIncludeUrl();
        let replyText;

        if (process.env.ANTHROPIC_API_KEY) {
          replyText = await generateReply(post.text, authorUsername, 'hashtag', includeUrl);
        }
        if (!replyText) replyText = fallbackReply(includeUrl);

        console.log(`  [#${tag}] @${authorUsername}: "${replyText.substring(0, 60)}"`);

        if (!DRY_RUN) {
          await client.v2.like(await getMyId(client), post.id);
          state.likedTweets.push(post.id);

          await client.v2.reply(replyText, post.id);
          state.repliedTweets.push(post.id);

          engaged++;
          await sleep(3000);
        } else {
          engaged++;
        }
      }

      if (state.likedTweets.length > 1000) state.likedTweets = state.likedTweets.slice(-1000);
      if (state.repliedTweets.length > 1000) state.repliedTweets = state.repliedTweets.slice(-1000);

      saveEngageState(state);
      console.log(`  [#${tag}] Engaged with ${engaged} post(s).`);

      await sleep(4000);
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
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`AI replies: ${process.env.ANTHROPIC_API_KEY ? 'ENABLED (Claude Haiku)' : 'DISABLED (fallback)'}\n`);

  const client = getClient();
  const state = loadEngageState();

  if (runAll || args.includes('--mentions')) await replyToMentions(client, state);
  if (runAll || args.includes('--bigaccounts')) await engageBigAccounts(client, state);
  if (runAll || args.includes('--hashtags')) await engageHashtags(client, state);
  if (runAll || args.includes('--followback')) await followBackFollowers(client, state);

  console.log('\n✓ Engagement run complete.');
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
