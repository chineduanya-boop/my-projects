// thread.js — Generate and post multi-tweet threads
// Threads 2x/week (Tue + Fri). These build followers fast — one viral thread
// can bring thousands of new followers in a single day.
//
// Usage:
//   node thread.js              → generate and post a thread
//   node thread.js --preview    → generate and preview without posting

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { TwitterApi } = require('twitter-api-v2');

const DRY_RUN = process.env.DRY_RUN === 'true';

// ── Thread topics ─────────────────────────────────────────────────────────────
// Mix of: listicles, hot takes, beginner guides, debates.
// These formats consistently perform well — people share lists and argue over ranks.

const THREAD_TOPICS = [
  'Top 5 manhwa to read after Solo Leveling — a thread 🧵',
  'The 5 most overpowered protagonists in manhwa ranked — power scaling thread 🧵',
  "New to manhwa? Read in this exact order — a beginner's guide 🧵",
  'Why manhwa is beating manga right now — an honest breakdown 🧵',
  'The best free manhwa you can read right now — a thread 🧵',
  'Manhwa moments that broke my brain (no spoilers) — a thread 🧵',
  'Every manhwa genre explained in one tweet — thread for newcomers 🧵',
  'Why the Solo Leveling manhwa is better than the anime — an honest comparison 🧵',
  'Tower of God: how to survive the first 100 chapters without quitting 🧵',
  'The murim martial arts manhwa tier list nobody asked for but everyone needs 🧵',
  'ORV deserves more hype and I will explain why in 6 tweets 🧵',
  '5 manhwa characters who are genuinely terrifying once you understand their power 🧵',
  'Anime only vs manhwa reader — the experience gap is massive, here is why 🧵',
  'The best plot twists in manhwa that you never saw coming (spoiler-free) 🧵',
  'Why manhwa art has gotten so good it is embarrassing other mediums 🧵',
];

// ── Generate thread ───────────────────────────────────────────────────────────

const anthropic = new Anthropic();

async function generateThread(topic) {
  const prompt = `Write a Twitter thread about: "${topic}"

The account is @manhwaxcomics for MangVault.com — a free manga/manhwa reading site.

Format: exactly 6 tweets.
- Tweet 1: the hook — grabs attention, matches topic, makes people want to read on
- Tweets 2-5: the substance — each stands alone, punchy, specific (name actual series/characters/arcs)
- Tweet 6: the close — wrap up + naturally mention https://mangvault.com or mangvault.com

Rules:
- Each tweet max 250 characters
- Number them: 1/ 2/ 3/ etc. at start
- Casual Twitter voice — no corporate speak
- Funny where appropriate, passionate throughout
- Tweets 2-5 should NOT include any URL — save mangvault for tweet 6
- Be specific — real series names, character names, arc names
- Make tweet 1 strong enough to go viral on its own

Output exactly this format, no extra commentary:
---TWEET---
<tweet 1>
---TWEET---
<tweet 2>
---TWEET---
<tweet 3>
---TWEET---
<tweet 4>
---TWEET---
<tweet 5>
---TWEET---
<tweet 6>
---END---`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    system: 'You are a viral social media copywriter for manga/manhwa fans. Write punchy, authentic content that gets shared and sparks discussion.',
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].text;
  const tweets = raw.split('---TWEET---').slice(1).map(t => {
    const text = t.split('---END---')[0].trim();
    return text.length > 280 ? text.substring(0, 277) + '...' : text;
  }).filter(Boolean);

  return tweets;
}

// ── Post thread ───────────────────────────────────────────────────────────────

async function postThread(tweets) {
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });

  let lastId = null;
  for (let i = 0; i < tweets.length; i++) {
    const payload = lastId
      ? { text: tweets[i], reply: { in_reply_to_tweet_id: lastId } }
      : { text: tweets[i] };

    const result = await client.v2.tweet(payload);
    lastId = result.data.id;
    console.log(`  [${i + 1}/${tweets.length}] https://twitter.com/i/web/status/${lastId}`);

    if (i < tweets.length - 1) await sleep(2000);
  }
  return lastId;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const preview = args.includes('--preview');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }

  const topic = THREAD_TOPICS[Math.floor(Math.random() * THREAD_TOPICS.length)];

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MangVault Bot — Thread Generator       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Mode: ${DRY_RUN || preview ? 'PREVIEW' : 'LIVE'}`);
  console.log(`Topic: ${topic}\n`);

  console.log('[AI] Generating thread...');
  const tweets = await generateThread(topic);

  if (tweets.length === 0) {
    console.error('No tweets generated.');
    process.exit(1);
  }

  console.log(`\n── ${tweets.length} tweets generated ─────────────────────────\n`);
  tweets.forEach((t, i) => {
    console.log(`[${i + 1}] (${t.length} chars)`);
    console.log(t);
    console.log('');
  });

  if (preview || DRY_RUN) {
    console.log('[PREVIEW] Not posting. Remove --preview or set DRY_RUN=false to go live.');
    return;
  }

  console.log('Posting thread...');
  await postThread(tweets);
  console.log('\n✓ Thread posted!');
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
