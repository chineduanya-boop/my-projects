// Hamburger menu
document.getElementById('hamburger')?.addEventListener('click', () => {
  document.getElementById('navLinks')?.classList.toggle('open');
});

// Genre URL helper — must match genreSlug() in server.js so client-rendered links
// point at the real /genre/:slug landing pages rather than ?genre= facets.
function genreUrl(g) {
  return `/genre/${g.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

// Load genres into dropdown
async function loadGenreDropdown() {
  const menu = document.getElementById('genreDropdown');
  if (!menu) return;
  // Server-rendered already — don't refetch and don't clobber it.
  if (menu.children.length) return;
  try {
    const genres = await fetch('/api/genres').then(r => r.json());
    menu.innerHTML = genres.map(g => `<a href="${genreUrl(g)}">${g}</a>`).join('');
  } catch {}
}

// Comic URL helper
function comicUrl(c) { return `/${c.slug || c.id}`; }

// Must match chapterSlugPart() in server.js: 512 -> "512", 43.5 -> "43-5".
function chapterUrl(slug, num) {
  const n = Number(num);
  return `/${slug}/chapter-${Number.isInteger(n) ? n : String(n).replace('.', '-')}`;
}

// ── Continue Reading ──────────────────────────────────────────────────────────
// Injected entirely client-side from localStorage (written by reader.js). It is never
// server-rendered — a per-reader history has no business in shared, crawlable HTML.
function renderContinueReading() {
  let entries;
  try { entries = Object.entries(JSON.parse(localStorage.getItem('mv_progress') || '{}')); }
  catch { return; }
  if (!entries.length) return;

  const items = entries
    .map(([slug, e]) => ({ slug, ...e }))
    .filter(e => e.chapter != null)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 12);
  if (!items.length) return;

  const anchor = document.querySelector('.section');
  if (!anchor) return;

  const section = document.createElement('section');
  section.className = 'section continue-row';
  section.innerHTML = `
    <div class="section-header">
      <h2 class="section-title"><span class="accent-bar"></span><i class="fa fa-bookmark cat-icon"></i> Continue Reading</h2>
      <button type="button" class="see-all" id="clearProgress">Clear</button>
    </div>
    <div class="comics-row">${items.map(e => `
      <a class="comic-card" href="${chapterUrl(e.slug, e.chapter)}">
        <div class="comic-card-cover" data-progress="Chapter ${e.chapter}">
          ${e.cover
            ? `<img src="${e.cover}" alt="${(e.title || e.slug).replace(/"/g, '&quot;')}" loading="lazy" />`
            : `<div class="no-cover"><i class="fa fa-book-open"></i></div>`}
        </div>
        <div class="comic-card-info">
          <div class="comic-card-title">${(e.title || e.slug).replace(/</g, '&lt;')}</div>
          <div class="comic-card-meta">Continue &rarr;</div>
        </div>
      </a>`).join('')}</div>`;

  anchor.parentNode.insertBefore(section, anchor);

  document.getElementById('clearProgress')?.addEventListener('click', () => {
    localStorage.removeItem('mv_progress');
    section.remove();
  });
}

// Comic card HTML
function comicCard(c) {
  const cover = c.cover_image
    ? `<img src="${c.cover_image}" alt="${c.title}" loading="lazy" />`
    : `<div class="no-cover"><i class="fa fa-book-open"></i><span>No Cover</span></div>`;
  const statusClass = { Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' }[c.status] || 'status-ongoing';
  return `
    <a class="comic-card" href="${comicUrl(c)}">
      <div class="comic-card-cover">
        ${cover}
        <span class="comic-status-badge ${statusClass}">${c.status}</span>
        <span class="comic-chapters-badge">${c.chapter_count || 0} ch</span>
      </div>
      <div class="comic-card-info">
        <div class="comic-card-title">${c.title}</div>
        <div class="comic-card-meta">${c.author || 'Unknown'}</div>
      </div>
    </a>`;
}

// Wire up hero slider dots + auto-advance + swipe/drag (works on SSR'd or JS-rendered HTML)
function initHeroSlider(container) {
  const slider = container.querySelector('#heroSlider');
  if (!slider) return;
  const dots = container.querySelectorAll('.hero-dot');
  const totalSlides = container.querySelectorAll('.hero-slide').length;
  let current = 0;
  let autoTimer = null;

  function goToSlide(i) {
    current = ((i % totalSlides) + totalSlides) % totalSlides;
    slider.style.transform = `translateX(-${current * 100}%)`;
    dots.forEach((d, idx) => d.classList.toggle('active', idx === current));
  }

  function startAuto() {
    clearInterval(autoTimer);
    if (totalSlides > 1) autoTimer = setInterval(() => goToSlide(current + 1), 5000);
  }

  function stopAuto() { clearInterval(autoTimer); }

  dots.forEach(dot => dot.addEventListener('click', () => {
    goToSlide(parseInt(dot.dataset.i));
    startAuto();
  }));

  // Swipe / mouse-drag
  let dragStartX = 0;
  let dragging = false;

  function onDragStart(x) { dragStartX = x; dragging = true; stopAuto(); }

  function onDragEnd(x) {
    if (!dragging) return;
    dragging = false;
    const diff = dragStartX - x;
    if (Math.abs(diff) > 50) goToSlide(diff > 0 ? current + 1 : current - 1);
    startAuto();
  }

  slider.addEventListener('touchstart', e => onDragStart(e.touches[0].clientX), { passive: true });
  slider.addEventListener('touchend',   e => onDragEnd(e.changedTouches[0].clientX));
  slider.addEventListener('mousedown',  e => { onDragStart(e.clientX); slider.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup',    e => { if (dragging) { onDragEnd(e.clientX); slider.style.cursor = ''; } });

  // Pause auto-advance while hovering
  container.addEventListener('mouseenter', stopAuto);
  container.addEventListener('mouseleave', startAuto);

  startAuto();
}

// Load hero / featured
async function loadHero() {
  const hero = document.getElementById('heroSection');
  if (!hero) return;
  // SSR already rendered the slides — just set up interactivity. The SSR set is now the
  // whole catalogue, so there is never a subset to re-render over.
  if (window.HOME_SSR) { initHeroSlider(hero); return; }
  try {
    const data = await fetch(`/api/comics?sort=views&limit=6`).then(r => r.json());
    const comics = data.comics || [];
    if (!comics.length) { hero.innerHTML = `<div class="hero-empty"><i class="fa fa-book-open"></i><p>No comics yet. <a href="/admin" style="color:var(--red)">Upload some!</a></p></div>`; return; }
    renderHero(hero, comics);
  } catch (e) {
    hero.innerHTML = `<div class="hero-empty"><i class="fa fa-exclamation-circle"></i><p>Failed to load.</p></div>`;
  }
}

function renderHero(container, comics) {
  const slides = comics.map(c => {
    let genres = [];
    try { genres = JSON.parse(c.genres); } catch {}
    const cover = c.cover_image || '';
    const url = comicUrl(c);
    const nocover = `<div style="width:100%;aspect-ratio:2/3;background:var(--bg3);border-radius:8px;display:flex;align-items:center;justify-content:center"><i class="fa fa-book" style="color:var(--text3);font-size:32px"></i></div>`;
    const coverImg = cover
      ? `<img src="${cover}" alt="${c.title}" style="width:100%;aspect-ratio:2/3;object-fit:cover;display:block" onerror="this.outerHTML='${nocover.replace(/"/g,"'")}'" />`
      : nocover;
    return `
      <div class="hero-slide">
        <div class="hero-slide-bg" style="background-image:url('${cover}')"></div>
        <div class="hero-slide-inner">
          <div class="hero-cover"><a href="${url}">${coverImg}</a></div>
          <div class="hero-info">
            <div class="hero-genres">${genres.slice(0,3).map(g => `<span class="hero-genre-tag">${g}</span>`).join('')}</div>
            <div class="hero-title">${c.title}</div>
            <div class="hero-meta"><i class="fa fa-user"></i> ${c.author || 'Unknown'} &bull; ${c.chapter_count || 0} Chapters &bull; <i class="fa fa-eye"></i> ${c.views || 0}</div>
            <div class="hero-desc">${c.description || 'No description available.'}</div>
            <div class="hero-actions">
              <a href="${url}" class="btn-read"><i class="fa fa-book-open"></i> Read Now</a>
              <a href="${url}" class="btn-details">Details</a>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  const dots = comics.map((_, i) => `<div class="hero-dot${i === 0 ? ' active' : ''}" data-i="${i}"></div>`).join('');
  container.innerHTML = `
    <div class="hero-slider" id="heroSlider">${slides}</div>
    ${comics.length > 1 ? `<div class="hero-dots">${dots}</div>` : ''}`;

  initHeroSlider(container);
}

// Load new releases row
async function loadNewReleases() {
  if (window.HOME_SSR) return;
  const el = document.getElementById('newReleasesRow');
  if (!el) return;
  try {
    const comics = await fetch(`/api/comics/new-releases`).then(r => r.json());
    el.innerHTML = comics.length ? comics.map(comicCard).join('') : '<p style="color:var(--text3);padding:20px">No releases yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

// Load popular grid
async function loadPopular() {
  if (window.HOME_SSR) return;
  const el = document.getElementById('popularGrid');
  if (!el) return;
  try {
    const comics = await fetch(`/api/comics/popular`).then(r => r.json());
    el.innerHTML = comics.length ? comics.map(comicCard).join('') : '<p style="color:var(--text3);padding:20px">No comics yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

// Load a genre category row
async function loadGenreRow(genre, elementId) {
  if (window.HOME_SSR) return;
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const data = await fetch(`/api/comics?genre=${encodeURIComponent(genre)}&limit=12&sort=views`).then(r => r.json());
    el.innerHTML = data.comics && data.comics.length
      ? data.comics.map(comicCard).join('')
      : `<p style="color:var(--text3);padding:20px">No ${genre} comics yet.</p>`;
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

// Load most viewed row
async function loadMostViewed() {
  if (window.HOME_SSR) return;
  const el = document.getElementById('mostViewedRow');
  if (!el) return;
  try {
    const data = await fetch(`/api/comics?sort=views&limit=12`).then(r => r.json());
    el.innerHTML = data.comics && data.comics.length
      ? data.comics.map(comicCard).join('')
      : '<p style="color:var(--text3);padding:20px">No comics yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

// Load genre tags
async function loadGenreTags() {
  if (window.HOME_SSR) return;
  const el = document.getElementById('genreTags');
  if (!el) return;
  try {
    const genres = await fetch('/api/genres').then(r => r.json());
    el.innerHTML = genres.length
      ? genres.map(g => `<a href="${genreUrl(g)}" class="genre-tag-btn">${g}</a>`).join('')
      : '<p style="color:var(--text3)">No genres yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3)">Failed to load.</p>'; }
}

loadGenreDropdown();
renderContinueReading();

loadHero();
loadNewReleases();
loadGenreRow('Action', 'actionRow');
loadGenreRow('Adventure', 'adventureRow');
loadGenreRow('Fantasy', 'fantasyRow');
loadGenreRow('Martial Arts', 'martialArtsRow');
loadMostViewed();
loadPopular();
loadGenreTags();
