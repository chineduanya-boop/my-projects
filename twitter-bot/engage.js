// engage.js — Interact with our audience
// Handles: reply to mentions, follow back
//
// Usage:
//   node engage.js                  → run all engagement tasks
//   node engage.js --mentions       → reply to mentions only
//   node engage.js --followback     → follow back followers only

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === 'true';
const ENGAGE_STATE_FILE = path.join(__dirname, 'engage-state.json');

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

async function generateReply(tweetText, authorUsername, includeUrl = false) {
  const urlInstruction = includeUrl
    ? 'Find a natural, non-forced way to drop a link to https://mangvault.com or mention MangVault at the end.'
    : 'Do NOT include any URL or mention MangVault. Just be funny, engaging, and build rapport. The link comes later.';

  const prompt = `Someone mentioned @manhwaxcomics. They said: "${tweetText}"

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
    return { lastMentionId: null, repliedTweets: [], followedUsers: [] };
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
        replyText = await generateReply(mention.text, authorUsername, includeUrl);
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
  if (runAll || args.includes('--followback')) await followBackFollowers(client, state);

  console.log('\n✓ Engagement run complete.');
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
