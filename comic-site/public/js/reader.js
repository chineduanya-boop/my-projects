const chapterId = location.pathname.split('/').pop();

async function loadReader() {
  const container = document.getElementById('readerContainer');
  try {
    const data = await fetch(`/api/chapters/${chapterId}/pages`).then(r => {
      if (!r.ok) throw new Error('Not found');
      return r.json();
    });

    const { chapter, pages, prevChapter, nextChapter } = data;

    // Load comic info for title
    const comic = await fetch(`/api/comics/${chapter.comic_id}`).then(r => r.json());

    document.title = `${comic.title} - Chapter ${chapter.chapter_number} | MangaVault`;
    document.getElementById('readerComicTitle').textContent = comic.title;
    document.getElementById('readerChapterTitle').textContent = `Chapter ${chapter.chapter_number}${chapter.title ? ` - ${chapter.title}` : ''}`;
    document.getElementById('chapterSelect').textContent = `Ch. ${chapter.chapter_number}`;

    // Back link
    document.getElementById('backToComic').href = `/comic/${chapter.comic_id}`;

    // Prev/Next chapter buttons
    const prevBtn = document.getElementById('prevChapterBtn');
    const nextBtn = document.getElementById('nextChapterBtn');
    const prevBtnBot = document.getElementById('prevChapterBtnBottom');
    const nextBtnBot = document.getElementById('nextChapterBtnBottom');

    if (prevChapter) {
      prevBtn.href = `/reader/${prevChapter.id}`;
      prevBtnBot.href = `/reader/${prevChapter.id}`;
    } else {
      prevBtn.classList.add('disabled');
      prevBtnBot.classList.add('disabled');
    }

    if (nextChapter) {
      nextBtn.href = `/reader/${nextChapter.id}`;
      nextBtnBot.href = `/reader/${nextChapter.id}`;
    } else {
      nextBtn.classList.add('disabled');
      nextBtnBot.classList.add('disabled');
    }

    // Render pages
    if (!pages.length) {
      container.innerHTML = `<div class="reader-loading"><i class="fa fa-exclamation-circle fa-3x"></i><p>No pages in this chapter.</p></div>`;
      return;
    }

    container.innerHTML = pages.map(p => `
      <div class="reader-page">
        <img src="${p.image_path}" alt="Page ${p.page_number}" loading="lazy" />
      </div>`).join('');

    document.getElementById('readerBottomNav').style.display = 'flex';

    // Toolbar hide on scroll down, show on scroll up
    let lastScroll = 0;
    const toolbar = document.getElementById('readerToolbar');
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (y > lastScroll + 50) toolbar.style.transform = 'translateY(-100%)';
      else if (y < lastScroll - 10) toolbar.style.transform = '';
      lastScroll = y;
    }, { passive: true });
    toolbar.style.transition = 'transform 0.3s';

  } catch {
    container.innerHTML = `<div class="reader-loading"><i class="fa fa-exclamation-circle fa-3x"></i><p>Chapter not found.</p><a href="/" style="color:var(--red);margin-top:12px">Go Home</a></div>`;
  }
}

loadReader();
