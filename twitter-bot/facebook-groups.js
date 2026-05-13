// facebook-groups.js — Post to Facebook Groups via the Graph API
// Requires FB_USER_ACCESS_TOKEN and FB_GROUP_IDS in .env
//
// FB_USER_ACCESS_TOKEN: a long-lived User Access Token with publish_to_groups permission
// FB_GROUP_IDS: comma-separated list of group IDs you are a member of

require('dotenv').config();
const https = require('https');

function graphPost(groupId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: text,
      access_token: process.env.FB_USER_ACCESS_TOKEN,
    });

    const options = {
      hostname: 'graph.facebook.com',
      path: `/v19.0/${groupId}/feed`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return reject(new Error('Bad JSON from Facebook API: ' + data));
        }
        if (json.error) {
          return reject(
            new Error(`Facebook API error: ${json.error.message} (code ${json.error.code})`)
          );
        }
        resolve(json);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postToGroups(text) {
  if (!process.env.FB_USER_ACCESS_TOKEN) {
    throw new Error('FB_USER_ACCESS_TOKEN not set in .env');
  }

  const groupIds = (process.env.FB_GROUP_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (groupIds.length === 0) {
    throw new Error('FB_GROUP_IDS not set in .env — add comma-separated group IDs');
  }

  const results = [];
  for (const groupId of groupIds) {
    try {
      const result = await graphPost(groupId, text);
      console.log(`  ✓ Posted to group ${groupId}: ${result.id}`);
      results.push({ groupId, postId: result.id, ok: true });
    } catch (err) {
      console.error(`  ✗ Failed for group ${groupId}: ${err.message}`);
      results.push({ groupId, error: err.message, ok: false });
    }
  }

  return results;
}

module.exports = { postToGroups };
