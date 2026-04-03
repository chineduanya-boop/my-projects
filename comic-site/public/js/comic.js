// COMIC_ID is injected server-side for slug URLs; fall back to last path segment
const id = window.COMIC_ID || location.pathname.split('/').pop();

// Adult toggle setup (header button)
function setupAdultToggle() {
  const btn = document.getElementById('adultToggle');
  if (!btn) return;
  const enabled = localStorage.getItem('mv_show_adult') === '1';
  if (enabled) { btn.classList.add('active'); btn.innerHTML = '<i class="fa fa-lock-open"></i> 18+'; }
  btn.addEventListener('click', () => {
    if (localStorage.getItem('mv_show_adult') === '1') {
      localStorage.removeItem('mv_show_adult');
      location.reload();
    } else {
      showAgeConfirm(() => { localStorage.setItem('mv_show_adult', '1'); location.reload(); });
    }
  });
}

function showAgeConfirm(onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'age-confirm-overlay';
  overlay.innerHTML = `
    <div class="age-confirm-box">
      <div class="age-confirm-icon">🔞</div>
      <h3>Enable Adult Content?</h3>
      <p>By enabling this, you confirm you are 18 years of age or older and consent to viewing adult-rated content.</p>
      <div class="age-confirm-actions">
        <button class="btn-age-confirm" id="ageConfirmYes">I am 18+ — Enable</button>
        <button class="btn-age-cancel" id="ageConfirmNo">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('ageConfirmYes').addEventListener('click', () => { overlay.remove(); onConfirm(); });
  document.getElementById('ageConfirmNo').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function formatDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadComic() {
  // Block adult comics if toggle is off
  if (window.COMIC_IS_ADULT && localStorage.getItem('mv_show_adult') !== '1') {
    document.getElementById('comicDetailPage').innerHTML = `
      <div class="adult-blocked">
        <div class="adult-blocked-icon">🔞</div>
        <h3>Adult Content</h3>
        <p>This comic is rated 18+. Enable adult content to read it.</p>
        <button class="btn-age-confirm" onclick="enableAndReload()">Enable Adult Content</button>
      </div>`;
    return;
  }
  startLoadComic();
}

function enableAndReload() {
  showAgeConfirm(() => { localStorage.setItem('mv_show_adult', '1'); location.reload(); });
}

async function startLoadComic() {
  const page = document.getElementById('comicDetailPage');
  try {
    const [comic, chapters] = await Promise.all([
      fetch(`/api/comics/${id}`).then(r => { if (!r.ok) throw new Error('Not found'); return r.json(); }),
      fetch(`/api/comics/${id}/chapters`).then(r => r.json())
    ]);

    document.title = `${comic.title} - MangaVault`;

    let genres = [];
    try { genres = JSON.parse(comic.genres); } catch {}

    const statusClass = { Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' }[comic.status] || 'status-ongoing';

    const firstChapter = chapters[0];
    const lastChapter = chapters[chapters.length - 1];

    const coverHtml = comic.cover_image
      ? `<img src="${comic.cover_image}" alt="${comic.title}" />`
      : `<div class="no-cover"><i class="fa fa-book-open fa-3x"></i></div>`;

    const chapterListHtml = chapters.length
      ? chapters.slice().reverse().map(ch => `
          <a class="chapter-item" href="/reader/${ch.id}">
            <div class="chapter-item-left">
              <span class="chapter-item-num">Chapter ${ch.chapter_number}${ch.title ? ` - ${ch.title}` : ''}</span>
              <span class="chapter-item-title">${ch.page_count || 0} pages</span>
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
            <span class="comic-meta-item"><span class="comic-status-badge ${statusClass}" style="position:static">${comic.status}</span></span>
            <span class="comic-meta-item"><i class="fa fa-book"></i> ${chapters.length} Chapters</span>
            <span class="comic-meta-item"><i class="fa fa-eye"></i> ${comic.views || 0} Views</span>
          </div>
          ${genres.length ? `<div class="comic-detail-genres">${genres.map(g => `<a class="detail-genre-tag" href="/browse?genre=${encodeURIComponent(g)}">${g}</a>`).join('')}</div>` : ''}
          <p class="comic-detail-desc">${comic.description || 'No description available.'}</p>
          <div class="comic-detail-actions">
            ${firstChapter ? `<a href="/reader/${firstChapter.id}" class="btn-read"><i class="fa fa-book-open"></i> Read First Chapter</a>` : ''}
            ${lastChapter && lastChapter.id !== (firstChapter && firstChapter.id) ? `<a href="/reader/${lastChapter.id}" class="btn-details"><i class="fa fa-forward"></i> Latest Chapter</a>` : ''}
          </div>
        </div>
      </div>
      <div class="chapters-section">
        <h2><span class="accent-bar"></span> Chapters <span style="font-size:14px;color:var(--text3);font-weight:400">(${chapters.length})</span></h2>
        <div class="chapter-list">${chapterListHtml}</div>
      </div>`;
  } catch (err) {
    page.innerHTML = `<div style="text-align:center;padding:80px;color:var(--text3)"><i class="fa fa-exclamation-circle fa-3x" style="margin-bottom:16px"></i><p>Comic not found.</p><a href="/browse" style="color:var(--red)">Browse Comics</a></div>`;
  }
}

loadComic();
