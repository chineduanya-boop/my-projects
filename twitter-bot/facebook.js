// facebook.js — Post to a Facebook Page via the Graph API
// Requires FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN in .env

require('dotenv').config();
const https = require('https');

function graphPost(pageId, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      ...params,
      access_token: process.env.FB_PAGE_ACCESS_TOKEN,
    });

    const options = {
      hostname: 'graph.facebook.com',
      path: `/v19.0/${pageId}/feed`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return reject(new Error('Bad JSON from Facebook API: ' + data));
        }
        if (json.error) {
          return reject(new Error(`Facebook API error: ${json.error.message} (code ${json.error.code})`));
        }
        resolve(json);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postToFacebook(text) {
  const pageId = process.env.FB_PAGE_ID;
  if (!pageId) throw new Error('FB_PAGE_ID not set in .env');
  if (!process.env.FB_PAGE_ACCESS_TOKEN) throw new Error('FB_PAGE_ACCESS_TOKEN not set in .env');

  const result = await graphPost(pageId, { message: text });
  return result.id; // format: "pageId_postId"
}

module.exports = { postToFacebook };
