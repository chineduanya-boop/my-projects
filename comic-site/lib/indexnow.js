/**
 * indexnow.js — notify Bing, Yandex, Seznam, Naver and Yep that URLs have changed.
 *
 * One POST reaches every participating engine; they share the submission between
 * themselves. Google does not participate — it uses the sitemap and its own crawl
 * scheduling, which is already set up separately.
 *
 * Authentication is the key file at https://mangvault.com/<key>.txt containing exactly
 * the key. The engines fetch it to confirm we control the host, so the key being public
 * is by design, not a leak.
 *
 * This replaces the old pingSearchEngines() in routes/admin.js, which called
 * google.com/ping?sitemap= and bing.com/ping?sitemap=. Both were retired — Google
 * returns 404, Bing returns 410 Gone — and their errors were swallowed, so every
 * publish had been notifying nobody.
 */

const SITE = 'https://mangvault.com';
const KEY = process.env.INDEXNOW_KEY || 'e3d6d2017656745b0c3998b9237721e8';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_PER_REQUEST = 10000;

/**
 * Submit absolute or site-relative URLs. Never throws — a failed notification must not
 * break a chapter upload.
 *
 * @param {string[]} urls
 * @param {{ force?: boolean, quiet?: boolean }} [opts] force submits from any
 *        environment; by default non-production runs are skipped so local testing and
 *        the seed scripts don't send noise to the engines.
 * @returns {Promise<{ok:boolean, status?:number, submitted:number, skipped?:string}>}
 */
async function submitUrls(urls, opts = {}) {
  const { force = false, quiet = false } = opts;
  const log = (...a) => { if (!quiet) console.log('[indexnow]', ...a); };

  const list = [...new Set((urls || [])
    .filter(Boolean)
    .map(u => (u.startsWith('http') ? u : `${SITE}${u.startsWith('/') ? '' : '/'}${u}`)))];

  if (!list.length) return { ok: true, submitted: 0, skipped: 'no urls' };

  if (process.env.NODE_ENV !== 'production' && !force) {
    log(`skipped ${list.length} url(s) — not production (pass force to override)`);
    return { ok: true, submitted: 0, skipped: 'not production' };
  }

  let submitted = 0;
  let lastStatus;

  for (let i = 0; i < list.length; i += MAX_PER_REQUEST) {
    const batch = list.slice(i, i + MAX_PER_REQUEST);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: SITE.replace(/^https?:\/\//, ''),
          key: KEY,
          keyLocation: `${SITE}/${KEY}.txt`,
          urlList: batch,
        }),
      });
      lastStatus = res.status;

      // 200 accepted, 202 accepted pending key validation. Everything else is a real
      // problem worth surfacing rather than swallowing.
      if (res.status === 200 || res.status === 202) {
        submitted += batch.length;
        log(`${res.status} — submitted ${batch.length} url(s)`);
      } else {
        const body = await res.text().catch(() => '');
        log(`FAILED ${res.status} ${res.statusText} — ${body.slice(0, 160)}`);
        log(res.status === 403 ? '  key rejected: check the key file matches KEY'
          : res.status === 422 ? '  unprocessable: key file unreachable, or a URL is not on this host'
          : res.status === 429 ? '  rate limited: back off and retry later'
          : '');
      }
    } catch (err) {
      lastStatus = 0;
      log(`network error: ${err.message}`);
    }
  }

  return { ok: submitted === list.length, status: lastStatus, submitted };
}

/** Fire-and-forget for request handlers — never blocks the response. */
function notify(urls) {
  submitUrls(urls).catch(() => {});
}

module.exports = { submitUrls, notify, KEY, SITE };
