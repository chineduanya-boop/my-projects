// Adult content toggle.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: server-rendered HTML never contains adult
// titles. The SAFE predicate in server.js keeps them out of the home rows, browse grid,
// genre grids and sitemaps. Everything here runs in the browser, gated on a
// localStorage flag, so Googlebot — which never sets it — only ever sees the clean
// catalogue. That is a user preference, not cloaking: same URL, same HTML, the
// difference is client-side state, exactly like a logged-in view.
//
// Loaded before the page scripts so window.ADULT_ON is available to them.

(function () {
  const KEY = 'mv_adult';

  function isOn() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  }

  function setOn(v) {
    try { v ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch {}
  }

  window.ADULT_ON = isOn();

  // Every client-side catalogue fetch goes through this so the preference is applied
  // in exactly one place.
  window.adultParam = () => (window.ADULT_ON ? 'all' : '0');

  function paint(btn) {
    const on = window.ADULT_ON;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-on', on);
    btn.querySelector('i').className = on ? 'fa fa-eye' : 'fa fa-eye-slash';
    btn.title = on ? 'Hiding 18+ titles' : 'Show 18+ titles';
  }

  function init() {
    const btn = document.getElementById('adultToggle');
    if (!btn) return;
    paint(btn);
    btn.addEventListener('click', () => {
      window.ADULT_ON = !window.ADULT_ON;
      setOn(window.ADULT_ON);
      paint(btn);
      // Reload rather than patch the DOM in place. The reloaded page is still rendered
      // clean by the server — that never changes — and the page scripts then see
      // ADULT_ON and re-request their grids with adult=all. Reloading keeps every grid,
      // row and count consistent instead of merging into a partially-paged list.
      location.reload();
    });
  }

  // ── Interstitial on an adult title's own page ───────────────────────────────
  // Purely a client-side overlay. The server still returns 200 with the full page, so
  // this does not affect crawling or the page's own indexability — it just means a
  // reader who arrives cold from a search result gets a heads-up first.
  function initGate() {
    if (!window.COMIC_IS_ADULT || window.ADULT_ON) return;

    const gate = document.createElement('div');
    gate.className = 'adult-gate';
    gate.innerHTML = `
      <div class="adult-gate-inner">
        <i class="fa fa-triangle-exclamation"></i>
        <h2>This title is rated 18+</h2>
        <p>It contains mature content. Continue only if you are of legal age in your country.</p>
        <div class="adult-gate-actions">
          <a href="/browse">Go back</a>
          <button type="button" class="confirm">I'm over 18 — continue</button>
        </div>
      </div>`;
    document.body.appendChild(gate);
    document.body.style.overflow = 'hidden';

    gate.querySelector('.confirm').addEventListener('click', () => {
      setOn(true);
      window.ADULT_ON = true;
      gate.remove();
      document.body.style.overflow = '';
      const btn = document.getElementById('adultToggle');
      if (btn) paint(btn);
    });
  }

  function boot() { init(); initGate(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
