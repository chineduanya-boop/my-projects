const params = new URLSearchParams(location.search);
let currentOffset = 0;
const limit = 24;
let loading = false;
let total = 0;

// Hamburger
document.getElementById('hamburger')?.addEventListener('click', () => {
  document.querySelector('.nav-links')?.classList.toggle('open');
});

// Comic card
function comicCard(c) {
  const cover = c.cover_image
    ? `<img src="${c.cover_image}" alt="${c.title}" loading="lazy" />`
    : `<div class="no-cover"><i class="fa fa-book-open"></i></div>`;
  const statusClass = { Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' }[c.status] || 'status-ongoing';
  const url = c.slug ? `/${c.slug}` : `/comic/${c.id}`;
  return `
    <a class="comic-card" href="${url}">
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

// Populate genre filter
async function loadGenreFilter() {
  try {
    const genres = await fetch('/api/genres').then(r => r.json());
    const sel = document.getElementById('genreFilter');
    genres.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g; opt.textContent = g;
      if (params.get('genre') === g) opt.selected = true;
      sel.appendChild(opt);
    });
    // Also populate dropdown
    const menu = document.getElementById('genreDropdown');
    if (menu) menu.innerHTML = genres.map(g => `<a href="/browse?genre=${encodeURIComponent(g)}">${g}</a>`).join('');
  } catch {}
}

async function loadComics(reset = false) {
  if (loading) return;
  loading = true;
  if (reset) {
    currentOffset = 0;
    document.getElementById('browseGrid').innerHTML = '';
  }

  document.getElementById('browseLoading').style.display = 'flex';
  document.getElementById('loadMoreBtn').style.display = 'none';
  document.getElementById('noResults').style.display = 'none';

  const genre = document.getElementById('genreFilter').value;
  const status = document.getElementById('statusFilter').value;
  const sort = document.getElementById('sortFilter').value;
  const search = document.getElementById('searchInput').value;

  const adultParam = localStorage.getItem('mv_show_adult') === '1' ? '&adult=all' : '';
  const url = `/api/comics?limit=${limit}&offset=${currentOffset}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}${sort ? `&sort=${sort}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}${adultParam}`;

  try {
    const data = await fetch(url).then(r => r.json());
    total = data.total;
    const grid = document.getElementById('browseGrid');

    if (data.comics.length === 0 && currentOffset === 0) {
      document.getElementById('noResults').style.display = 'block';
    } else {
      grid.insertAdjacentHTML('beforeend', data.comics.map(comicCard).join(''));
      currentOffset += data.comics.length;
    }

    document.getElementById('browseCount').textContent = `${total} comic${total !== 1 ? 's' : ''} found`;
    document.getElementById('loadMoreBtn').style.display = currentOffset < total ? 'block' : 'none';
  } catch {
    document.getElementById('noResults').textContent = 'Error loading comics.';
    document.getElementById('noResults').style.display = 'block';
  }

  document.getElementById('browseLoading').style.display = 'none';
  loading = false;
}

// Set initial filter values from URL
document.getElementById('genreFilter').value = params.get('genre') || '';
document.getElementById('statusFilter').value = params.get('status') || '';
document.getElementById('sortFilter').value = params.get('sort') || 'updated';
document.getElementById('searchInput').value = params.get('search') || '';

// Update page title
const genre = params.get('genre');
const search = params.get('search');
if (genre) document.getElementById('browseTitle').textContent = genre;
else if (search) document.getElementById('browseTitle').textContent = `Search: "${search}"`;

// Filter change listeners
['genreFilter', 'statusFilter', 'sortFilter'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => loadComics(true));
});

document.getElementById('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  loadComics(true);
});

document.getElementById('loadMoreBtn').addEventListener('click', () => loadComics(false));

// Adult toggle
(function() {
  const btn = document.getElementById('adultToggle');
  if (!btn) return;
  const enabled = localStorage.getItem('mv_show_adult') === '1';
  if (enabled) { btn.classList.add('active'); btn.innerHTML = '<i class="fa fa-lock-open"></i> 18+'; }
  btn.addEventListener('click', () => {
    if (localStorage.getItem('mv_show_adult') === '1') {
      localStorage.removeItem('mv_show_adult');
      location.reload();
    } else {
      const overlay = document.createElement('div');
      overlay.className = 'age-confirm-overlay';
      overlay.innerHTML = `<div class="age-confirm-box"><div class="age-confirm-icon">🔞</div><h3>Enable Adult Content?</h3><p>By enabling this, you confirm you are 18 years of age or older.</p><div class="age-confirm-actions"><button class="btn-age-confirm" id="ageConfirmYes">I am 18+ — Enable</button><button class="btn-age-cancel" id="ageConfirmNo">Cancel</button></div></div>`;
      document.body.appendChild(overlay);
      document.getElementById('ageConfirmYes').addEventListener('click', () => { overlay.remove(); localStorage.setItem('mv_show_adult', '1'); location.reload(); });
      document.getElementById('ageConfirmNo').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }
  });
})();

loadGenreFilter();
loadComics(true);
