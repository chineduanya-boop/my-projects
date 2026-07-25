// Comic detail page.
//
// The server renders the hero, the description and the newest 60 chapters, then ships
// the full chapter list as a JSON payload in #chapterData. Everything here is
// progressive enhancement over that: filtering, paging, jump-to-chapter and reading
// progress. The non-SSR path at the bottom is a fallback for when the DB query fails.

const id = window.COMIC_ID || location.pathname.split('/').pop();
const slug = window.COMIC_SLUG || location.pathname.replace(/^\//, '');

// Must match genreSlug() in server.js so client-rendered links point at the real
// /genre/:slug landing pages rather than ?genre= facets.
function genreUrl(g) {
  return `/genre/${g.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

// Must match chapterSlugPart() in server.js: 512 -> "512", 43.5 -> "43-5".
function chapterUrl(comicSlug, num) {
  const n = Number(num);
  return `/${comicSlug}/chapter-${Number.isInteger(n) ? n : String(n).replace('.', '-')}`;
}

const STATUS_CLASS = { Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' };
const statusClassFor = (s) => STATUS_CLASS[s] || 'status-ongoing';

function formatDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Reading progress ──────────────────────────────────────────────────────────
// Written by reader.js; read here to offer "Continue from Ch. N".
function readProgress() {
  try { return JSON.parse(localStorage.getItem('mv_progress') || '{}'); } catch { return {}; }
}

function applyContinueReading() {
  const entry = readProgress()[slug];
  if (!entry) return;
  const btn = document.querySelector('.comic-detail-actions .btn-read');
  if (!btn) return;
  btn.href = chapterUrl(slug, entry.chapter);
  btn.innerHTML = `<i class="fa fa-bookmark"></i> Continue from Ch. ${entry.chapter}`;
  btn.classList.add('is-continue');
}

// ── Chapter list: filter, order, jump, paging ─────────────────────────────────
const PAGE_SIZE = 50;

function initChapterTools() {
  const dataEl = document.getElementById('chapterData');
  const listEl = document.getElementById('chapterList');
  if (!dataEl || !listEl) return;

  let all;
  try { all = JSON.parse(dataEl.textContent); } catch { return; }
  if (!Array.isArray(all) || !all.length) return;

  const emptyEl  = document.getElementById('chapterEmpty');
  const moreBtn  = document.getElementById('chapterMore');
  const jumpEl   = document.getElementById('chapterJump');
  const filterEl = document.getElementById('chapterFilter');
  const orderBtn = document.getElementById('chapterOrder');

  // [number, title, dateMs] tuples, newest first as rendered by the server.
  let newestFirst = true;
  let shown = window.COMIC_SSR_CHAPTERS || 60;
  let query = '';

  const progress = readProgress()[slug];

  function matching() {
    const rows = newestFirst ? all : [...all].reverse();
    if (!query) return rows;
    const q = query.toLowerCase();
    return rows.filter(([num, title]) =>
      String(num).includes(q) || (title && title.toLowerCase().includes(q)));
  }

  function rowHtml([num, title, ts]) {
    const isCurrent = progress && Number(progress.chapter) === Number(num);
    return `<a class="chapter-item${isCurrent ? ' is-current' : ''}" href="${chapterUrl(slug, num)}" data-num="${num}">
        <div class="chapter-item-left">
          <span class="chapter-item-num">Chapter ${num}${title ? ` - ${title.replace(/</g, '&lt;')}` : ''}</span>
        </div>
        <div class="chapter-item-right">
          ${isCurrent ? '<span class="chapter-last-read">Last read</span>' : ''}
          <span class="chapter-item-date">${ts ? formatDate(ts) : ''}</span>
          <span class="chapter-read-btn"><i class="fa fa-book-open"></i> Read</span>
        </div>
      </a>`;
  }

  function render() {
    const rows = matching();
    // A filter should search the whole list, not just the page you happen to be on.
    const slice = query ? rows.slice(0, 300) : rows.slice(0, shown);

    listEl.innerHTML = slice.map(rowHtml).join('');
    if (emptyEl) emptyEl.hidden = rows.length > 0;
    if (moreBtn) {
      const remaining = rows.length - slice.length;
      moreBtn.hidden = remaining <= 0;
      moreBtn.textContent = `Show ${Math.min(PAGE_SIZE, remaining)} more of ${remaining} remaining`;
    }
  }

  if (filterEl) {
    let t;
    filterEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { query = filterEl.value.trim(); shown = PAGE_SIZE; render(); }, 120);
    });
  }

  if (orderBtn) {
    orderBtn.addEventListener('click', () => {
      newestFirst = !newestFirst;
      shown = PAGE_SIZE;
      orderBtn.querySelector('span').textContent = newestFirst ? 'Newest' : 'Oldest';
      orderBtn.querySelector('i').className = newestFirst
        ? 'fa fa-arrow-down-wide-short' : 'fa fa-arrow-up-wide-short';
      render();
    });
  }

  if (moreBtn) {
    moreBtn.addEventListener('click', () => { shown += PAGE_SIZE; render(); });
  }

  if (jumpEl) {
    const go = () => {
      const n = parseFloat(jumpEl.value);
      if (!Number.isFinite(n)) return;
      // Land on the requested chapter, or the nearest one that exists.
      const exact = all.find(([num]) => Number(num) === n);
      const target = exact || all.reduce((best, r) =>
        Math.abs(r[0] - n) < Math.abs(best[0] - n) ? r : best, all[0]);
      location.href = chapterUrl(slug, target[0]);
    };
    jumpEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    jumpEl.addEventListener('change', go);
  }

  render();
}

// ── View count refresh ────────────────────────────────────────────────────────
async function refreshViewCount() {
  // SSR bakes the view count in at render time; correct it after load.
  try {
    const comic = await fetch(`/api/comics/${id}`).then(r => r.ok ? r.json() : null);
    if (!comic) return;
    const el = document.querySelector('.comic-meta-item .fa-eye');
    if (el && el.parentElement) {
      el.parentElement.innerHTML = `<i class="fa fa-eye"></i> ${comic.views || 0} Views`;
    }
  } catch {}
}

// ── Fallback render (only when SSR failed) ────────────────────────────────────
async function renderClientSide() {
  const page = document.getElementById('comicDetailPage');
  try {
    const [comic, chapters] = await Promise.all([
      fetch(`/api/comics/${id}`).then(r => { if (!r.ok) throw new Error('Not found'); return r.json(); }),
      fetch(`/api/comics/${id}/chapters`).then(r => r.json())
    ]);

    document.title = `${comic.title} - MangVault`;
    const comicSlug = comic.slug || slug;

    let genres = [];
    try { genres = JSON.parse(comic.genres); } catch {}

    const firstChapter = chapters[0];
    const lastChapter = chapters[chapters.length - 1];

    const coverHtml = comic.cover_image
      ? `<img src="${comic.cover_image}" alt="${comic.title}" />`
      : `<div class="no-cover"><i class="fa fa-book-open fa-3x"></i></div>`;

    const chapterListHtml = chapters.length
      ? chapters.slice().reverse().map(ch => `
          <a class="chapter-item" href="${chapterUrl(comicSlug, ch.chapter_number)}">
            <div class="chapter-item-left">
              <span class="chapter-item-num">Chapter ${ch.chapter_number}${ch.title && !/^chapter\s*[\d.]+$/i.test(ch.title) ? ` - ${ch.title}` : ''}</span>
            </div>
            <div class="chapter-item-right">
              <span class="chapter-item-date">${formatDate(ch.created_at)}</span>
              <span class="chapter-read-btn"><i class="fa fa-book-open"></i> Read</span>
            </div>
          </a>`).join('')
      : `<div style="color:var(--text3);padding:24px;text-align:center"><i class="fa fa-clock" style="font-size:32px;margin-bottom:12px"></i><p>No chapters uploaded yet.</p></div>`;

    page.innerHTML = `
      <div class="comic-detail-hero">
        <div class="comic-detail-cover">${coverHtml}</div>
        <div class="comic-detail-info">
          <h1 class="comic-detail-title">${comic.title}</h1>
          <div class="comic-detail-meta">
            <span class="comic-meta-item"><i class="fa fa-user"></i> ${comic.author || 'Unknown'}</span>
            <span class="comic-meta-item"><i class="fa fa-pen-nib"></i> ${comic.artist || comic.author || 'Unknown'}</span>
            <span class="comic-meta-item"><span class="comic-status-badge ${statusClassFor(comic.status)}" style="position:static">${comic.status}</span></span>
            <span class="comic-meta-item"><i class="fa fa-book"></i> ${chapters.length} Chapters</span>
            <span class="comic-meta-item"><i class="fa fa-eye"></i> ${comic.views || 0} Views</span>
          </div>
          ${genres.length ? `<div class="comic-detail-genres">${genres.map(g => `<a class="detail-genre-tag" href="${genreUrl(g)}">${g}</a>`).join('')}</div>` : ''}
          <p class="comic-detail-desc">${comic.description || 'No description available.'}</p>
          <div class="comic-detail-actions">
            ${firstChapter ? `<a href="${chapterUrl(comicSlug, firstChapter.chapter_number)}" class="btn-read"><i class="fa fa-book-open"></i> Read First Chapter</a>` : ''}
            ${lastChapter && lastChapter.id !== (firstChapter && firstChapter.id) ? `<a href="${chapterUrl(comicSlug, lastChapter.chapter_number)}" class="btn-details"><i class="fa fa-forward"></i> Latest Chapter</a>` : ''}
          </div>
        </div>
      </div>
      <div class="chapters-section">
        <h2><span class="accent-bar"></span> Chapters <span style="font-size:14px;color:var(--text3);font-weight:400">(${chapters.length})</span></h2>
        <div class="chapter-list" id="chapterList">${chapterListHtml}</div>
      </div>`;

    applyContinueReading();
  } catch {
    page.innerHTML = `<div style="text-align:center;padding:80px;color:var(--text3)"><i class="fa fa-exclamation-circle fa-3x" style="margin-bottom:16px"></i><p>Comic not found.</p><a href="/browse" style="color:var(--red)">Browse Comics</a></div>`;
  }
}

if (window.COMIC_SSR) {
  initChapterTools();
  applyContinueReading();
  refreshViewCount();
} else {
  renderClientSide();
}
