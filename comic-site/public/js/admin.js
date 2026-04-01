// Tab switching
function switchTab(name) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`)?.classList.add('active');
  document.querySelector(`[data-tab="${name}"]`)?.classList.add('active');
}
document.querySelectorAll('.sidebar-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Load comics list
async function loadAdminComics() {
  const list = document.getElementById('adminComicsList');
  try {
    const comics = await fetch('/api/admin/comics').then(r => r.json());
    if (!comics.length) {
      list.innerHTML = `<div style="color:var(--text3);text-align:center;padding:40px"><i class="fa fa-inbox fa-3x" style="margin-bottom:16px"></i><p>No comics yet. <button onclick="switchTab('add-comic')" style="color:var(--red);background:none;border:none;cursor:pointer;font:inherit">Add one!</button></p></div>`;
      return;
    }
    list.innerHTML = comics.map(c => `
      <div class="admin-comic-item">
        <div class="admin-comic-thumb">
          ${c.cover_image ? `<img src="${c.cover_image}" alt="${c.title}" />` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text3)"><i class="fa fa-book"></i></div>`}
        </div>
        <div class="admin-comic-info">
          <div class="admin-comic-title">${c.title}</div>
          <div class="admin-comic-meta">
            <span><i class="fa fa-user"></i> ${c.author}</span>
            <span><i class="fa fa-book"></i> ${c.chapter_count} chapters</span>
            <span><i class="fa fa-eye"></i> ${c.views}</span>
            <span class="comic-status-badge ${{ Ongoing: 'status-ongoing', Completed: 'status-completed', Hiatus: 'status-hiatus' }[c.status] || 'status-ongoing'}" style="position:static">${c.status}</span>
          </div>
        </div>
        <div class="admin-comic-actions">
          <button class="btn-icon btn-chapter" onclick="openAddChapter(${c.id}, '${c.title.replace(/'/g,"\\'")}')"><i class="fa fa-plus"></i> Chapter</button>
          <button class="btn-icon btn-edit" onclick="editComic(${c.id})" title="Edit"><i class="fa fa-pen"></i></button>
          <button class="btn-icon btn-delete" onclick="deleteComic(${c.id}, '${c.title.replace(/'/g,"\\'")}')"><i class="fa fa-trash"></i></button>
        </div>
      </div>`).join('');

    // Also populate chapter comic selector
    const sel = document.getElementById('chapterComicId');
    sel.innerHTML = '<option value="">-- Select a comic --</option>' +
      comics.map(c => `<option value="${c.id}">${c.title}</option>`).join('');
  } catch (e) {
    list.innerHTML = '<p style="color:var(--text3);padding:20px">Failed to load comics.</p>';
  }
}

// Open chapter tab for specific comic
function openAddChapter(comicId, comicTitle) {
  switchTab('add-chapter');
  document.getElementById('chapterComicId').value = comicId;
}

// Edit comic — load values into form
async function editComic(id) {
  try {
    const res = await fetch(`/api/admin/comics`).then(r => r.json());
    const comic = res.find(c => c.id === id);
    if (!comic) return;
    switchTab('add-comic');
    document.getElementById('addComicTitle').textContent = 'Edit Comic';
    document.getElementById('editComicId').value = id;
    document.getElementById('comicTitle').value = comic.title;
    document.getElementById('comicAuthor').value = comic.author;
    document.getElementById('comicArtist').value = comic.artist;
    document.getElementById('comicDescription').value = comic.description;
    document.getElementById('comicStatus').value = comic.status;
    document.getElementById('comicFeatured').checked = !!comic.featured;

    let genres = [];
    try { genres = JSON.parse(comic.genres); } catch {}
    document.querySelectorAll('#genreCheckboxes input[type="checkbox"]').forEach(cb => {
      cb.checked = genres.includes(cb.value);
    });

    if (comic.cover_image) {
      document.getElementById('coverPreviewImg').src = comic.cover_image;
      document.getElementById('coverPreview').style.display = 'block';
    }
    document.getElementById('saveComicBtn').innerHTML = '<i class="fa fa-save"></i> Update Comic';
  } catch {}
}

// Delete comic
async function deleteComic(id, title) {
  if (!confirm(`Delete "${title}"? This will also delete all its chapters.`)) return;
  try {
    const r = await fetch(`/api/admin/comics/${id}`, { method: 'DELETE' });
    if (r.ok) { loadAdminComics(); showMsg('addComicMsg', 'Comic deleted.', 'success'); }
    else { const d = await r.json(); showMsg('addComicMsg', d.error || 'Delete failed.', 'error'); }
  } catch { showMsg('addComicMsg', 'Network error.', 'error'); }
}

// Cover image drop zone
const coverDropZone = document.getElementById('coverDropZone');
const coverInput = document.getElementById('comicCover');
coverDropZone.addEventListener('click', () => coverInput.click());
coverDropZone.addEventListener('dragover', e => { e.preventDefault(); coverDropZone.classList.add('dragover'); });
coverDropZone.addEventListener('dragleave', () => coverDropZone.classList.remove('dragover'));
coverDropZone.addEventListener('drop', e => { e.preventDefault(); coverDropZone.classList.remove('dragover'); handleCoverFile(e.dataTransfer.files[0]); });
coverInput.addEventListener('change', () => handleCoverFile(coverInput.files[0]));

function handleCoverFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('coverPreviewImg').src = e.target.result;
    document.getElementById('coverPreview').style.display = 'block';
    coverDropZone.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

document.getElementById('removeCoverBtn').addEventListener('click', () => {
  coverInput.value = '';
  document.getElementById('coverPreview').style.display = 'none';
  coverDropZone.style.display = 'flex';
  document.getElementById('coverPreviewImg').src = '';
});

// Upload type toggle
document.querySelectorAll('input[name="uploadType"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const isPdf = radio.value === 'pdf';
    document.getElementById('imagesUploadGroup').style.display = isPdf ? 'none' : 'block';
    document.getElementById('pdfUploadGroup').style.display = isPdf ? 'block' : 'none';
  });
});

// Pages drop zone
const pagesDropZone = document.getElementById('pagesDropZone');
const pagesInput = document.getElementById('chapterPages');
pagesDropZone.addEventListener('click', () => pagesInput.click());
pagesDropZone.addEventListener('dragover', e => { e.preventDefault(); pagesDropZone.classList.add('dragover'); });
pagesDropZone.addEventListener('dragleave', () => pagesDropZone.classList.remove('dragover'));
pagesDropZone.addEventListener('drop', e => {
  e.preventDefault(); pagesDropZone.classList.remove('dragover');
  handlePageFiles(e.dataTransfer.files);
});
pagesInput.addEventListener('change', () => handlePageFiles(pagesInput.files));

function handlePageFiles(files) {
  const preview = document.getElementById('pagesPreview');
  preview.innerHTML = '';
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  sorted.slice(0, 20).forEach(f => {
    const img = document.createElement('img');
    img.className = 'page-thumb';
    const reader = new FileReader();
    reader.onload = e => img.src = e.target.result;
    reader.readAsDataURL(f);
    preview.appendChild(img);
  });
  document.getElementById('pageCount').textContent = `${files.length} page${files.length !== 1 ? 's' : ''} selected${files.length > 20 ? ' (showing first 20 previews)' : ''}`;
}

// PDF drop zone
const pdfDropZone = document.getElementById('pdfDropZone');
const pdfInput = document.getElementById('chapterPdf');
pdfDropZone.addEventListener('click', () => pdfInput.click());
pdfDropZone.addEventListener('dragover', e => { e.preventDefault(); pdfDropZone.classList.add('dragover'); });
pdfDropZone.addEventListener('dragleave', () => pdfDropZone.classList.remove('dragover'));
pdfDropZone.addEventListener('drop', e => {
  e.preventDefault(); pdfDropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handlePdfFile(e.dataTransfer.files[0]);
});
pdfInput.addEventListener('change', () => { if (pdfInput.files[0]) handlePdfFile(pdfInput.files[0]); });

function handlePdfFile(file) {
  document.getElementById('pdfName').textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
  pdfDropZone.querySelector('p').textContent = file.name;
}

// Add/Edit comic form
document.getElementById('addComicForm').addEventListener('submit', async e => {
  e.preventDefault();
  const editId = document.getElementById('editComicId').value;
  const btn = document.getElementById('saveComicBtn');
  btn.disabled = true;

  const genres = [...document.querySelectorAll('#genreCheckboxes input:checked')].map(cb => cb.value);
  const formData = new FormData();
  formData.append('title', document.getElementById('comicTitle').value);
  formData.append('author', document.getElementById('comicAuthor').value);
  formData.append('artist', document.getElementById('comicArtist').value);
  formData.append('description', document.getElementById('comicDescription').value);
  formData.append('status', document.getElementById('comicStatus').value);
  formData.append('featured', document.getElementById('comicFeatured').checked ? '1' : '0');
  formData.append('genres', JSON.stringify(genres));
  if (coverInput.files[0]) formData.append('cover', coverInput.files[0]);

  try {
    const url = editId ? `/api/admin/comics/${editId}` : '/api/admin/comics';
    const method = editId ? 'PUT' : 'POST';
    const r = await fetch(url, { method, body: formData });
    const data = await r.json();
    if (r.ok) {
      showMsg('addComicMsg', editId ? 'Comic updated!' : `Comic "${document.getElementById('comicTitle').value}" added!`, 'success');
      resetComicForm();
      loadAdminComics();
      setTimeout(() => switchTab('comics'), 1500);
    } else {
      showMsg('addComicMsg', data.error || 'Failed to save.', 'error');
    }
  } catch { showMsg('addComicMsg', 'Network error.', 'error'); }
  btn.disabled = false;
});

function resetComicForm() {
  document.getElementById('addComicForm').reset();
  document.getElementById('editComicId').value = '';
  document.getElementById('addComicTitle').textContent = 'Add New Comic';
  document.getElementById('coverPreview').style.display = 'none';
  coverDropZone.style.display = 'flex';
  document.getElementById('saveComicBtn').innerHTML = '<i class="fa fa-save"></i> Save Comic';
  document.querySelectorAll('#genreCheckboxes input').forEach(cb => cb.checked = false);
}

// Add chapter form
document.getElementById('addChapterForm').addEventListener('submit', async e => {
  e.preventDefault();
  const comicId = document.getElementById('chapterComicId').value;
  const chapterNum = document.getElementById('chapterNumber').value;
  const isPdf = document.querySelector('input[name="uploadType"]:checked').value === 'pdf';

  if (!comicId) { showMsg('addChapterMsg', 'Please select a comic.', 'error'); return; }
  if (isPdf && !pdfInput.files[0]) { showMsg('addChapterMsg', 'Please select a PDF file.', 'error'); return; }
  if (!isPdf && !pagesInput.files.length) { showMsg('addChapterMsg', 'Please upload at least one page.', 'error'); return; }

  const btn = document.getElementById('saveChapterBtn');
  btn.disabled = true;
  document.getElementById('uploadProgress').style.display = 'block';

  const formData = new FormData();
  formData.append('chapter_number', chapterNum);
  formData.append('title', document.getElementById('chapterTitle').value);

  if (isPdf) {
    formData.append('pdf', pdfInput.files[0]);
  } else {
    [...pagesInput.files].forEach(f => formData.append('pages', f));
  }

  const endpoint = isPdf
    ? `/api/admin/comics/${comicId}/chapters/pdf`
    : `/api/admin/comics/${comicId}/chapters`;

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          const pct = Math.round(e.loaded / e.total * 100);
          document.getElementById('progressFill').style.width = pct + '%';
          document.getElementById('progressText').textContent = `Uploading... ${pct}%`;
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(JSON.parse(xhr.responseText));
      };
      xhr.onerror = () => reject({ error: 'Network error' });
      xhr.send(formData);
    });

    showMsg('addChapterMsg', `Chapter ${chapterNum} uploaded successfully!`, 'success');
    document.getElementById('addChapterForm').reset();
    document.getElementById('pagesPreview').innerHTML = '';
    document.getElementById('pageCount').textContent = '';
    document.getElementById('pdfName').textContent = '';
    document.getElementById('imagesUploadGroup').style.display = 'block';
    document.getElementById('pdfUploadGroup').style.display = 'none';
    loadAdminComics();
  } catch (err) {
    showMsg('addChapterMsg', err.error || 'Upload failed.', 'error');
  }

  btn.disabled = false;
  document.getElementById('uploadProgress').style.display = 'none';
  document.getElementById('progressFill').style.width = '0%';
});

function showMsg(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `form-message ${type}`;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}

loadAdminComics();
