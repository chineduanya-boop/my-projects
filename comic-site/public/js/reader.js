// Chapter pages are server-rendered: the toolbar, nav links, headings and chapter
// context all arrive in the HTML. This script only paints the pages themselves.
// window.CHAPTER_PDF / CHAPTER_ID are injected by serveChapterPage in server.js.

const container = document.getElementById('readerContainer');

// ── Reading progress ──────────────────────────────────────────────────────────
// Kept in localStorage rather than on the server: there are no user accounts, and a
// reading history is personal enough that it should not sit in crawlable HTML.
const PROGRESS_KEY = 'mv_progress';
const PROGRESS_MAX = 40;

function saveProgress() {
  if (!window.CHAPTER_SSR || !window.CHAPTER_SLUG) return;
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    all[window.CHAPTER_SLUG] = {
      chapter: window.CHAPTER_NUMBER,
      title: window.CHAPTER_COMIC_TITLE || '',
      cover: window.CHAPTER_COVER || '',
      ts: Date.now(),
    };
    // Evict least-recently-read once over the cap.
    const keys = Object.keys(all);
    if (keys.length > PROGRESS_MAX) {
      keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0))
          .slice(0, keys.length - PROGRESS_MAX)
          .forEach(k => delete all[k]);
    }
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {}
}

// ── Keyboard navigation ───────────────────────────────────────────────────────
// Reuses the prev/next hrefs the server already rendered into the toolbar.
function initKeyboardNav() {
  const href = (sel) => {
    const el = document.querySelector(sel);
    return el && el.tagName === 'A' ? el.getAttribute('href') : null;
  };
  const prev = href('.reader-nav a[rel="prev"]');
  const next = href('.reader-nav a[rel="next"]');
  const first = href('.chapter-jump a:first-child');
  const last = href('.chapter-jump a:last-child');

  document.addEventListener('keydown', (e) => {
    // Never hijack keys while the reader is typing somewhere.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case 'ArrowLeft':  if (prev)  { e.preventDefault(); location.href = prev; }  break;
      case 'ArrowRight': if (next)  { e.preventDefault(); location.href = next; }  break;
      case 'Home':       if (first) { e.preventDefault(); location.href = first; } break;
      case 'End':        if (last)  { e.preventDefault(); location.href = last; }  break;
      case '?':          toggleShortcutHelp(); break;
      case 'Escape':     hideShortcutHelp(); break;
    }
  });
}

function toggleShortcutHelp() {
  let el = document.getElementById('kbHelp');
  if (el) { el.remove(); return; }
  el = document.createElement('div');
  el.id = 'kbHelp';
  el.className = 'kb-help';
  el.innerHTML = `
    <div class="kb-help-inner">
      <h3>Keyboard shortcuts</h3>
      <dl>
        <dt><kbd>&larr;</kbd></dt><dd>Previous chapter</dd>
        <dt><kbd>&rarr;</kbd></dt><dd>Next chapter</dd>
        <dt><kbd>Home</kbd></dt><dd>First chapter</dd>
        <dt><kbd>End</kbd></dt><dd>Latest chapter</dd>
        <dt><kbd>?</kbd></dt><dd>Toggle this panel</dd>
      </dl>
      <button type="button" onclick="document.getElementById('kbHelp').remove()">Close</button>
    </div>`;
  document.body.appendChild(el);
}

function hideShortcutHelp() {
  const el = document.getElementById('kbHelp');
  if (el) el.remove();
}

async function loadReader() {
  try {
    if (window.CHAPTER_SSR) {
      // Fast path — no API round-trip, the PDF URL is already on the page.
      if (window.CHAPTER_PDF) {
        await renderPdf(window.CHAPTER_PDF, container);
      } else {
        const { pages } = await fetch(`/api/chapters/${window.CHAPTER_ID}/pages`).then(r => {
          if (!r.ok) throw new Error('Not found');
          return r.json();
        });
        if (!pages.length) return showEmpty('No pages in this chapter.');
        container.innerHTML = '';
        renderImages(pages, container);
      }
    } else {
      await loadLegacy();
    }

    document.getElementById('readerBottomNav').style.display = 'flex';
    wireToolbarAutoHide();
  } catch {
    showEmpty('Chapter not found.');
  }
}

// Nav and progress do not depend on the PDF rendering, so wire them immediately
// rather than waiting on (or being blocked by) the reader pipeline.
initKeyboardNav();
saveProgress();

// Fallback for any page served without SSR (e.g. the DB error path).
async function loadLegacy() {
  const chapterId = location.pathname.split('/').pop();
  const { chapter, pages } = await fetch(`/api/chapters/${chapterId}/pages`).then(r => {
    if (!r.ok) throw new Error('Not found');
    return r.json();
  });
  container.innerHTML = '';
  if (chapter.pdf_url) return renderPdf(chapter.pdf_url, container);
  if (!pages.length) return showEmpty('No pages in this chapter.');
  renderImages(pages, container);
}

function showEmpty(msg) {
  container.innerHTML = `<div class="reader-loading"><i class="fa fa-exclamation-circle fa-3x"></i><p>${msg}</p><a href="/" style="color:var(--red);margin-top:12px">Go Home</a></div>`;
}

function wireToolbarAutoHide() {
  let lastScroll = 0;
  const toolbar = document.getElementById('readerToolbar');
  toolbar.style.transition = 'transform 0.3s';
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > lastScroll + 50) toolbar.style.transform = 'translateY(-100%)';
    else if (y < lastScroll - 10) toolbar.style.transform = '';
    lastScroll = y;
  }, { passive: true });
}

function renderImages(pages, target) {
  pages.forEach(p => {
    const div = document.createElement('div');
    div.className = 'reader-page';
    const img = document.createElement('img');
    img.src = p.image_path;
    img.alt = `Page ${p.page_number}`;
    img.loading = 'lazy';
    div.appendChild(img);
    target.appendChild(div);
  });
}

async function renderPdf(pdfUrl, target) {
  const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
  target.innerHTML = '';

  const containerWidth = Math.min(target.clientWidth || 900, 900);

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const scale = containerWidth / viewport.width;
    const scaled = page.getViewport({ scale });

    const div = document.createElement('div');
    div.className = 'reader-page';

    const canvas = document.createElement('canvas');
    canvas.width  = scaled.width;
    canvas.height = scaled.height;
    canvas.style.width  = '100%';
    canvas.style.display = 'block';

    div.appendChild(canvas);
    target.appendChild(div);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
  }
}

loadReader();
