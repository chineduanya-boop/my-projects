const chapterId = location.pathname.split('/').pop();

async function loadReader() {
  const container = document.getElementById('readerContainer');
  try {
    const data = await fetch(`/api/chapters/${chapterId}/pages`).then(r => {
      if (!r.ok) throw new Error('Not found');
      return r.json();
    });

    const { chapter, pages, prevChapter, nextChapter } = data;

    const comic = await fetch(`/api/comics/${chapter.comic_id}`).then(r => r.json());

    document.title = `${comic.title} - Chapter ${chapter.chapter_number} | MangaVault`;
    document.getElementById('readerComicTitle').textContent = comic.title;
    document.getElementById('readerChapterTitle').textContent = `Chapter ${chapter.chapter_number}${chapter.title ? ` - ${chapter.title}` : ''}`;
    document.getElementById('chapterSelect').textContent = `Ch. ${chapter.chapter_number}`;
    document.getElementById('backToComic').href = comic.slug ? `/${comic.slug}` : `/comic/${chapter.comic_id}`;

    const prevBtn    = document.getElementById('prevChapterBtn');
    const nextBtn    = document.getElementById('nextChapterBtn');
    const prevBtnBot = document.getElementById('prevChapterBtnBottom');
    const nextBtnBot = document.getElementById('nextChapterBtnBottom');

    if (prevChapter) { prevBtn.href = `/reader/${prevChapter.id}`; prevBtnBot.href = `/reader/${prevChapter.id}`; }
    else             { prevBtn.classList.add('disabled'); prevBtnBot.classList.add('disabled'); }

    if (nextChapter) { nextBtn.href = `/reader/${nextChapter.id}`; nextBtnBot.href = `/reader/${nextChapter.id}`; }
    else             { nextBtn.classList.add('disabled'); nextBtnBot.classList.add('disabled'); }

    container.innerHTML = '';

    if (chapter.pdf_url) {
      await renderPdf(chapter.pdf_url, container);
    } else {
      if (!pages.length) {
        container.innerHTML = `<div class="reader-loading"><i class="fa fa-exclamation-circle fa-3x"></i><p>No pages in this chapter.</p></div>`;
        return;
      }
      renderImages(pages, container);
    }

    document.getElementById('readerBottomNav').style.display = 'flex';

    let lastScroll = 0;
    const toolbar = document.getElementById('readerToolbar');
    toolbar.style.transition = 'transform 0.3s';
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (y > lastScroll + 50) toolbar.style.transform = 'translateY(-100%)';
      else if (y < lastScroll - 10) toolbar.style.transform = '';
      lastScroll = y;
    }, { passive: true });

  } catch {
    container.innerHTML = `<div class="reader-loading"><i class="fa fa-exclamation-circle fa-3x"></i><p>Chapter not found.</p><a href="/" style="color:var(--red);margin-top:12px">Go Home</a></div>`;
  }
}

function renderImages(pages, container) {
  pages.forEach(p => {
    const div = document.createElement('div');
    div.className = 'reader-page';
    const img = document.createElement('img');
    img.src = p.image_path;
    img.alt = `Page ${p.page_number}`;
    img.loading = 'lazy';
    div.appendChild(img);
    container.appendChild(div);
  });
}

async function renderPdf(pdfUrl, container) {
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'reader-loading';
  loadingDiv.innerHTML = '<i class="fa fa-spinner fa-spin fa-3x"></i><p>Loading PDF...</p>';
  container.appendChild(loadingDiv);

  const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
  loadingDiv.remove();

  const containerWidth = Math.min(container.clientWidth || 900, 900);

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
    container.appendChild(div);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
  }
}

loadReader();
