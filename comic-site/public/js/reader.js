// Chapter pages are server-rendered: the toolbar, nav links, headings and chapter
// context all arrive in the HTML. This script only paints the pages themselves.
// window.CHAPTER_PDF / CHAPTER_ID are injected by serveChapterPage in server.js.

const container = document.getElementById('readerContainer');

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
