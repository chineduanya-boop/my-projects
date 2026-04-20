// preview.js — Browse and preview all tweets without posting
// Usage:
//   node preview.js              → list all tweets with IDs
//   node preview.js --id sl-01  → preview a specific tweet in full
//   node preview.js --stats     → show posting stats from state.json

const fs = require('fs');
const path = require('path');
const tweets = require('./tweets');
const STATE_FILE = path.join(__dirname, 'state.json');

const args = process.argv.slice(2);

// ── Preview specific tweet ────────────────────────────────────────────────────

const idFlag = args.indexOf('--id');
if (idFlag !== -1 && args[idFlag + 1]) {
  const tweet = tweets.find(t => t.id === args[idFlag + 1]);
  if (!tweet) { console.error(`Tweet ID "${args[idFlag + 1]}" not found.`); process.exit(1); }
  console.log('\n' + '─'.repeat(60));
  console.log(`ID   : ${tweet.id}`);
  console.log(`Tags : ${(tweet.tags || []).map(t => '#' + t).join(' ')}`);
  console.log(`Chars: ${tweet.text.length}/280`);
  console.log('─'.repeat(60));
  console.log(tweet.text);
  console.log('─'.repeat(60) + '\n');
  process.exit(0);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

if (args.includes('--stats')) {
  const state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { posted: [] };
  console.log(`\nTotal tweets in bank : ${tweets.length}`);
  console.log(`Posted this cycle    : ${state.posted.length}`);
  console.log(`Remaining in queue   : ${tweets.length - state.posted.length}`);
  if (state.posted.length > 0) {
    console.log('\nLast 5 posted:');
    state.posted.slice(-5).forEach(p => {
      console.log(`  [${p.postedAt}] ${p.id} — ${p.preview || ''}`);
    });
  }
  console.log('');
  process.exit(0);
}

// ── List all tweets ───────────────────────────────────────────────────────────

const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { posted: [] };

const postedIds = new Set(state.posted.map(p => p.id));

// Group by prefix
const groups = {};
tweets.forEach(t => {
  const group = t.id.split('-')[0];
  if (!groups[group]) groups[group] = [];
  groups[group].push(t);
});

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║        MangVault Tweet Bank — Preview            ║');
console.log('╚══════════════════════════════════════════════════╝\n');

Object.entries(groups).forEach(([group, groupTweets]) => {
  console.log(`[${group.toUpperCase()}] — ${groupTweets.length} tweet${groupTweets.length !== 1 ? 's' : ''}`);
  groupTweets.forEach(t => {
    const posted = postedIds.has(t.id) ? '✓' : ' ';
    const preview = t.text.replace(/\n/g, ' ').substring(0, 70);
    console.log(`  [${posted}] ${t.id.padEnd(12)} ${preview}...`);
  });
  console.log('');
});

console.log(`Total: ${tweets.length} tweets  |  Posted: ${state.posted.length}  |  Queued: ${tweets.length - state.posted.length}`);
console.log('\nTip: node preview.js --id <tweet-id>  to see full tweet text');
console.log('     node preview.js --stats           to see posting history\n');
