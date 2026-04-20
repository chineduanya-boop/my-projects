// media.js — Image attachment helper
// Finds and uploads a matching image for a tweet, returns the media_id

const fs = require('fs');
const path = require('path');

const IMAGES_DIR = path.join(__dirname, 'images');
const SUPPORTED = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

// Find best matching image for a tweet ID like "sl-01", "gen-03", "orv-02"
function findImage(tweetId) {
  if (!fs.existsSync(IMAGES_DIR)) return null;

  const files = fs.readdirSync(IMAGES_DIR).filter(f =>
    SUPPORTED.includes(path.extname(f).toLowerCase())
  );

  if (files.length === 0) return null;

  // 1. Exact match: sl-01.jpg
  const exact = files.find(f => path.basename(f, path.extname(f)) === tweetId);
  if (exact) return path.join(IMAGES_DIR, exact);

  // 2. Series prefix match: tweet "sl-01" → any "sl-*.jpg"
  const prefix = tweetId.replace(/-\d+$/, '');
  const prefixMatch = files.filter(f => f.startsWith(prefix + '-'));
  if (prefixMatch.length > 0) {
    // Pick randomly from available series images
    const pick = prefixMatch[Math.floor(Math.random() * prefixMatch.length)];
    return path.join(IMAGES_DIR, pick);
  }

  // 3. No match — post without image
  return null;
}

// Upload image to Twitter and return media_id string
async function uploadImage(client, imagePath) {
  try {
    const mediaId = await client.v1.uploadMedia(imagePath);
    return mediaId;
  } catch (err) {
    console.warn(`  [Media] Failed to upload image: ${err.message} — posting without image.`);
    return null;
  }
}

// Main helper: find image for tweet, upload it, return media_id or null
async function attachImage(client, tweetId) {
  const imagePath = findImage(tweetId);
  if (!imagePath) return null;

  console.log(`  [Media] Found image: ${path.basename(imagePath)}`);
  const mediaId = await uploadImage(client, imagePath);
  return mediaId;
}

module.exports = { findImage, attachImage };
