// download-covers.js — Download cover images from mangvault.com for use in tweets
// Saves covers to images/ folder named by tweet prefix so media.js auto-attaches them
//
// Usage: node download-covers.js

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.join(__dirname, 'images');
const API_URL = 'https://mangvault.com/api/comics?limit=100';

// Map comic slug → tweet ID prefix (matches tweets.js naming)
const SLUG_TO_PREFIX = {
  'solo-leveling':                          'sl',
  'solo-leveling-ragnarok':                 'slr',
  'tower-of-god':                           'tog',
  'omniscient-readers-viewpoint':           'orv',
  'the-beginning-after-the-end':            'tbate',
  'nano-machine':                           'nm',
  'return-of-the-mount-hua-sect':           'rmhs',
  'the-eminence-in-shadow':                 'eis',
  'noblesse':                               'nob',
  'eleceed':                                'ele',
  'mercenary-enrollment':                   'me',
  'the-god-of-high-school':                 'gohs',
  'the-legend-of-the-northern-blade':       'nb',
  'murim-login':                            'ml',
  'the-swordmasters-youngest-son':          'smy',
  'tomb-raider-king':                       'trk',
  'dungeon-reset':                          'dr',
  'rankers-return-remake':                  'rr',
  'heavenly-demon-reborn':                  'hd',
  'reality-quest':                          'rq',
  'the-max-level-returner':                 'mlr',
  'the-hero-returns':                       'hr',
  'volcanic-age':                           'va',
  'the-regressed-mercenarys-machinations':  'rgm',
  'the-breaker':                            'tb',
  'lv999-no-murabito':                      'lv',
  'absolute-sword-sense':                   'ass',
  'reincarnation-of-the-suicidal-battle-god': 'sbg',
  'pick-me-up-infinite-gacha':              'pmu',
  'fist-demon-of-mount-hua':                'fdmh',
  'the-great-mage-returns-after-4000-years':'gm',
  'doom-breaker':                           'db',
  'insector':                               'ins',
  'a-returners-magic-should-be-special':    'rmss',
  'i-am-the-fated-villain':                 'iatfv',
  'mr-devourer-please-act-like-a-final-boss': 'md',
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    protocol.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

function getExtension(url) {
  const u = url.split('?')[0];
  const ext = path.extname(u).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MangVault — Cover Image Downloader     ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log('Fetching comics list from mangvault.com...');
  const data = await fetchJson(API_URL);
  const comics = data.comics || [];
  console.log(`Found ${comics.length} comics.\n`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const comic of comics) {
    const prefix = SLUG_TO_PREFIX[comic.slug];
    if (!prefix) {
      console.log(`  ~ [no prefix] ${comic.slug}`);
      skipped++;
      continue;
    }

    if (!comic.cover_image) {
      console.log(`  ~ [no cover]  ${comic.slug}`);
      skipped++;
      continue;
    }

    const ext = getExtension(comic.cover_image);
    const filename = `${prefix}-cover${ext}`;
    const dest = path.join(IMAGES_DIR, filename);

    if (fs.existsSync(dest)) {
      console.log(`  ✓ [exists]    ${filename}`);
      skipped++;
      continue;
    }

    try {
      await downloadFile(comic.cover_image, dest);
      const size = Math.round(fs.statSync(dest).size / 1024);
      console.log(`  ↓ [saved]     ${filename}  (${size}kb)`);
      downloaded++;
      await sleep(300);
    } catch (err) {
      console.log(`  ✗ [failed]    ${comic.slug} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n── Done ──────────────────────────────────`);
  console.log(`  Downloaded : ${downloaded}`);
  console.log(`  Skipped    : ${skipped}`);
  console.log(`  Failed     : ${failed}`);
  console.log(`\nCovers saved to: ${IMAGES_DIR}`);
  console.log('The bot will now attach matching covers to tweets automatically.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
