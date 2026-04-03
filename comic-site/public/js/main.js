// Hamburger menu
document.getElementById('hamburger')?.addEventListener('click', () => {
  document.getElementById('navLinks')?.classList.toggle('open');
});

// Load genres into dropdown
async function loadGenreDropdown() {
  try {
    const genres = await fetch('/api/genres').then(r => r.json());
    const menu = document.getElementById('genreDropdown');
    if (!menu) return;
    menu.innerHTML = genres.map(g =>
      `<a href="/browse?genre=${encodeURIComponent(g)}">${g}</a>`
    ).join('');
  } catch {}
}

// Comic URL helper
function comicUrl(c) { return c.slug ? `/${c.slug}` : `/comic/${c.id}`; }

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

// Load hero / featured
async function loadHero() {
  try {
    const hero = document.getElementById('heroSection');
    if (!hero) return;
    const data = await fetch('/api/comics?sort=views&limit=6').then(r => r.json());
    const comics = data.comics || [];
    if (!comics.length) { hero.innerHTML = `<div class="hero-empty"><i class="fa fa-book-open"></i><p>No comics yet. <a href="/admin" style="color:var(--red)">Upload some!</a></p></div>`; return; }
    renderHero(hero, comics);
  } catch (e) {
    document.getElementById('heroSection').innerHTML = `<div class="hero-empty"><i class="fa fa-exclamation-circle"></i><p>Failed to load.</p></div>`;
  }
}

function renderHero(container, comics) {
  let current = 0;
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

  // Dots click
  container.querySelectorAll('.hero-dot').forEach(dot => {
    dot.addEventListener('click', () => goToSlide(parseInt(dot.dataset.i)));
  });

  function goToSlide(i) {
    current = i;
    document.getElementById('heroSlider').style.transform = `translateX(-${i * 100}%)`;
    container.querySelectorAll('.hero-dot').forEach((d, idx) => d.classList.toggle('active', idx === i));
  }

  // Auto-slide
  if (comics.length > 1) {
    setInterval(() => goToSlide((current + 1) % comics.length), 5000);
  }
}

// Load new releases row
async function loadNewReleases() {
  const el = document.getElementById('newReleasesRow');
  if (!el) return;
  try {
    const comics = await fetch('/api/comics/new-releases').then(r => r.json());
    el.innerHTML = comics.length ? comics.map(comicCard).join('') : '<p style="color:var(--text3);padding:20px">No releases yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

// Load popular grid
async function loadPopular() {
  const el = document.getElementById('popularGrid');
  if (!el) return;
  try {
    const comics = await fetch('/api/comics/popular').then(r => r.json());
    el.innerHTML = comics.length ? comics.map(comicCard).join('') : '<p style="color:var(--text3);padding:20px">No comics yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

// Load a genre category row
async function loadGenreRow(genre, elementId) {
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
  const el = document.getElementById('mostViewedRow');
  if (!el) return;
  try {
    const data = await fetch('/api/comics?sort=views&limit=12').then(r => r.json());
    el.innerHTML = data.comics && data.comics.length
      ? data.comics.map(comicCard).join('')
      : '<p style="color:var(--text3);padding:20px">No comics yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

// Load genre tags
async function loadGenreTags() {
  const el = document.getElementById('genreTags');
  if (!el) return;
  try {
    const genres = await fetch('/api/genres').then(r => r.json());
    el.innerHTML = genres.length
      ? genres.map(g => `<a href="/browse?genre=${encodeURIComponent(g)}" class="genre-tag-btn">${g}</a>`).join('')
      : '<p style="color:var(--text3)">No genres yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3)">Failed to load.</p>'; }
}

// Age gate
function initAgeGate() {
  const gate = document.getElementById('ageGate');
  const lockedSection = document.getElementById('adultLockedSection');
  const adultSection = document.getElementById('adultSection');

  if (localStorage.getItem('mv_age_verified') === '1') {
    if (gate) gate.style.display = 'none';
    if (lockedSection) lockedSection.style.display = 'none';
    if (adultSection) adultSection.style.display = 'block';
    loadAdultRow();
    return;
  }

  // Not verified — show gate
  if (gate) gate.style.display = 'flex';
  if (lockedSection) lockedSection.style.display = 'block';
  if (adultSection) adultSection.style.display = 'none';

  function confirmAge() {
    localStorage.setItem('mv_age_verified', '1');
    if (gate) gate.style.display = 'none';
    if (lockedSection) lockedSection.style.display = 'none';
    if (adultSection) adultSection.style.display = 'block';
    loadAdultRow();
  }

  document.getElementById('ageConfirmBtn')?.addEventListener('click', confirmAge);
  document.getElementById('unlockAdultBtn')?.addEventListener('click', () => {
    if (gate) gate.style.display = 'flex';
    document.getElementById('ageConfirmBtn')?.addEventListener('click', confirmAge, { once: true });
  });
}

async function loadAdultRow() {
  const el = document.getElementById('adultRow');
  if (!el) return;
  try {
    const data = await fetch('/api/comics?adult=1&limit=12&sort=views').then(r => r.json());
    el.innerHTML = data.comics && data.comics.length
      ? data.comics.map(comicCard).join('')
      : '<p style="color:var(--text3);padding:20px">No adult comics yet.</p>';
  } catch { el.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load.</p>'; }
}

loadGenreDropdown();
loadHero();
loadNewReleases();
loadGenreRow('Action', 'actionRow');
loadGenreRow('Romance', 'romanceRow');
loadGenreRow('Fantasy', 'fantasyRow');
loadGenreRow('Drama', 'dramaRow');
loadMostViewed();
loadPopular();
initAgeGate();
loadGenreTags();
