// follow-accounts.js — Follow a list of target accounts via Twitter API
// Usage: node follow-accounts.js

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');

const ACCOUNTS_TO_FOLLOW = [
  'Crunchyroll',
  'webtoon',
  'VizMedia',
  'AniListco',
  'myanimelist',
  'MangaPlusENG',
  'shonenjump',
  'animenewsnetwork',
  'ComicBookResources',
  'IGN',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });

  const me = await client.v2.me();
  console.log(`Logged in as @${me.data.username} (${me.data.id})\n`);

  for (const username of ACCOUNTS_TO_FOLLOW) {
    try {
      const user = await client.v2.userByUsername(username);
      if (!user.data) {
        console.log(`  ✗ @${username} — not found`);
        continue;
      }

      await client.v2.follow(me.data.id, user.data.id);
      console.log(`  ✓ Followed @${username}`);
      await sleep(1500);
    } catch (err) {
      // 403 usually means already following
      if (err.code === 403 || err.message?.includes('already')) {
        console.log(`  ~ @${username} — already following`);
      } else {
        console.log(`  ✗ @${username} — ${err.message}`);
      }
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
