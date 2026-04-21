// generate.js — AI-powered tweet generation using Claude
// Generates fresh MangVault promo tweets on demand and optionally adds them to tweets.js
//
// Usage:
//   node generate.js                      → generate 5 tweets (preview only)
//   node generate.js --count 10           → generate 10 tweets
//   node generate.js --series "Solo Leveling"  → generate for a specific series
//   node generate.js --save               → generate and append to tweets.js
//   node generate.js --post               → generate one tweet and post it immediately

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN === 'true';

// ── Series list ───────────────────────────────────────────────────────────────

const SERIES = [
  'Solo Leveling', 'Tower of God', "Omniscient Reader's Viewpoint",
  'The Beginning After The End', 'Nano Machine', 'Return of the Mount Hua Sect',
  'The Eminence in Shadow', 'Noblesse', 'Eleceed', 'Mercenary Enrollment',
  'God of High School', 'Northern Blade', 'Murim Login', 'Dungeon Reset',
  'Ranker\'s Return', 'Heavenly Demon Reborn', 'Sword Master\'s Youngest Son',
  'Tomb Raider King', 'Reality Quest', 'Max Level Returner',
];

const TWEET_STYLES = [
  'spicy hot take / controversial opinion that will make fans argue in the replies',
  'debate starter — pose a question that divides the fandom (e.g. "X vs Y, who wins")',
  'relatable reader experience — 2am reading sessions, crying at chapters, can\'t stop reading',
  'broke/woke/galaxy brain comparison format',
  'spoiler-free plot hook that creates massive curiosity and FOMO',
  'list format — ranked list of something specific (best arcs, strongest characters, saddest moments)',
  'POV format — put the reader inside a moment from the story',
  'quote or iconic line from the series with a punchy reaction',
  'anime-only vs manhwa reader comparison — make the manga reader feel elite',
  'day-by-day descent into the rabbit hole format',
  'unpopular opinion format — state something most fans secretly agree with',
  'villain appreciation post — why the antagonist was actually right',
  '"nobody talks about X enough" appreciation tweet for an underrated moment or character',
  'power scaling argument bait — make a specific claim about who would beat who',
];

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(series, count, style) {
  const seriesLine = series
    ? `The tweet must be specifically about: **${series}**`
    : `Pick any series from this list (vary them): ${SERIES.slice(0, 10).join(', ')}, and others.`;

  return `You are a social media manager for MangVault.com — a free manga and manhwa reading site based in Nigeria.

Your job is to write ${count} viral Twitter/X tweet(s) promoting MangVault. These tweets get real engagement from manga/manhwa fans.

${seriesLine}

Tweet style to use: **${style}**

Rules:
- Each tweet must end with a link to https://mangvault.com or https://mangvault.com/<series-slug> (use lowercase-hyphenated slugs e.g. solo-leveling, tower-of-god)
- Keep tweets under 260 characters including the link
- Write in a casual, punchy Twitter voice — not corporate
- Use line breaks for readability
- Emojis are fine but don't overdo it (max 2-3 per tweet)
- Do NOT use hashtags inline in the tweet body — they go separately
- Each tweet should feel fresh and different from generic manga promotion

For each tweet, output exactly this format (no extra commentary):

---TWEET---
<tweet text here>
---TAGS---
<comma-separated tags without # symbol, 2-4 tags>
---END---

Generate ${count} tweet(s) now.`;
}

// ── Parse AI response ─────────────────────────────────────────────────────────

function parseTweets(raw) {
  const blocks = raw.split('---TWEET---').slice(1);
  return blocks.map((block, i) => {
    const tweetMatch = block.split('---TAGS---')[0]?.trim();
    const tagsMatch = block.split('---TAGS---')[1]?.split('---END---')[0]?.trim();
    if (!tweetMatch) return null;
    return {
      text: tweetMatch,
      tags: tagsMatch ? tagsMatch.split(',').map(t => t.trim()).filter(Boolean) : ['manga', 'manhwa'],
    };
  }).filter(Boolean);
}

// ── Generate tweets ───────────────────────────────────────────────────────────

async function generateTweets(series, count) {
  const client = new Anthropic();
  const style = TWEET_STYLES[Math.floor(Math.random() * TWEET_STYLES.length)];

  console.log(`\n[Generate] Calling Claude...`);
  console.log(`  Series : ${series || 'mixed'}`);
  console.log(`  Style  : ${style}`);
  console.log(`  Count  : ${count}\n`);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are a viral social media copywriter for manga/manhwa fans. Write punchy, authentic tweets that get real engagement.',
    messages: [{ role: 'user', content: buildPrompt(series, count, style) }],
  });

  const raw = message.content[0].text;
  return parseTweets(raw);
}

// ── Save to tweets.js ─────────────────────────────────────────────────────────

function saveToTweetsFile(newTweets) {
  const tweetsFile = path.join(__dirname, 'tweets.js');
  const content = fs.readFileSync(tweetsFile, 'utf8');

  // Find the closing bracket of the tweets array
  const insertPoint = content.lastIndexOf('];');
  if (insertPoint === -1) {
    console.error('[Save] Could not find insertion point in tweets.js');
    return;
  }

  const timestamp = new Date().toISOString().split('T')[0];
  const generated = newTweets.map((t, i) => {
    const id = `ai-${timestamp}-${String(i + 1).padStart(2, '0')}`;
    return `  {\n    id: '${id}',\n    text: \`${t.text.replace(/`/g, '\\`')}\`,\n    tags: ${JSON.stringify(t.tags)},\n  }`;
  }).join(',\n\n');

  const newContent =
    content.slice(0, insertPoint) +
    `\n  // ─── AI GENERATED ${timestamp} ──────────────────────────────────────────────\n\n` +
    generated + ',\n\n' +
    content.slice(insertPoint);

  fs.writeFileSync(tweetsFile, newContent);
  console.log(`\n✓ Saved ${newTweets.length} new tweet(s) to tweets.js`);
}

// ── Post one generated tweet immediately ──────────────────────────────────────

async function postGeneratedTweet(tweet) {
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would post:');
    console.log(tweet.text);
    return;
  }

  const required = ['TWITTER_API_KEY', 'TWITTER_API_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error('Missing env vars:', missing.join(', ')); return; }

  const twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });

  const result = await twitterClient.v2.tweet(tweet.text);
  console.log(`\n✓ Posted! https://twitter.com/i/web/status/${result.data.id}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const countFlag = args.indexOf('--count');
  const seriesFlag = args.indexOf('--series');
  const count = countFlag !== -1 && args[countFlag + 1] ? parseInt(args[countFlag + 1], 10) : 5;
  const series = seriesFlag !== -1 && args[seriesFlag + 1] ? args[seriesFlag + 1] : null;
  const shouldSave = args.includes('--save');
  const shouldPost = args.includes('--post');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    console.error('Get one at https://console.anthropic.com');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MangVault Bot — AI Tweet Generator     ║');
  console.log('╚══════════════════════════════════════════╝');

  const tweets = await generateTweets(series, shouldPost ? 1 : count);

  if (tweets.length === 0) {
    console.error('No tweets generated. Try again.');
    process.exit(1);
  }

  // Always preview
  console.log(`\n── Generated ${tweets.length} tweet(s) ──────────────────────\n`);
  tweets.forEach((t, i) => {
    console.log(`[${i + 1}] Tags: ${t.tags.map(tag => '#' + tag).join(' ')}`);
    console.log(t.text);
    console.log(`     (${t.text.length} chars)\n`);
  });

  if (shouldSave) saveToTweetsFile(tweets);
  if (shouldPost) await postGeneratedTweet(tweets[0]);

  if (!shouldSave && !shouldPost) {
    console.log('Tip: use --save to add these to tweets.js, or --post to post one immediately.');
  }
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
