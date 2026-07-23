/* ==========================================================================
   Yaoi Journal — standalone PWA
   All data lives in IndexedDB on this device. No account, no server database.
   The only network calls this app makes are (a) hotlinking cover images
   directly from anime-planet's own CDN, and (b) an optional proxy call to
   your own Apps Script endpoint to pull a summary/metadata preview when you
   cross-reference a title. Nothing you type is ever sent anywhere.
   ========================================================================== */

const DB_NAME = 'yaoiJournalDB';
const DB_VERSION = 1;
const STORE_ENTRIES = 'entries';
const STORE_META = 'meta';

const SHELVES_READING = ['Currently Reading', 'Completed', 'Plan to Read', 'Discontinued'];
const FLAG_COLORS = ['green', 'red', 'black'];
const FLAG_HEX = { green: '#4ade80', red: '#f87171', black: '#6b6b7a' };

let db = null;
let ALL_ENTRIES = [];              // in-memory cache, synced with IndexedDB
let STATE = {
  view: 'home',            // 'home' | 'detail' | 'database' | 'review' | 'duplicates'
  entryId: null,
  format: 'reading',        // 'reading' | 'watching'
  showFavoritesOnly: false,
  shelf: 'ALL',             // 'ALL' or one of SHELVES_READING
  tagFilter: null,
  smutFilter: null,         // null or 1-5, meaning "at least N eggplants"
  qualityFilter: null,      // null or 1-5, meaning "at least N hearts"
  search: '',
};

/* ---------------------------------------------------------------------- */
/* IndexedDB layer                                                        */
/* ---------------------------------------------------------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains(STORE_ENTRIES)) {
        _db.createObjectStore(STORE_ENTRIES, { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains(STORE_META)) {
        _db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbBulkPut(storeName, values) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    values.forEach((v) => store.put(v));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function ensureSeeded() {
  const meta = await idbGet(STORE_META, 'seeded');
  if (meta && meta.value) return;
  const resp = await fetch('./seed_data.json');
  const seed = await resp.json();
  const now = new Date().toISOString();
  seed.entries.forEach((e) => { e.createdAt = now; e.updatedAt = now; });
  await idbBulkPut(STORE_ENTRIES, seed.entries);
  await idbPut(STORE_META, { key: 'seeded', value: true });
  await idbPut(STORE_META, { key: 'user', value: seed.user || 'noondaeyoja' });
}

async function loadAllEntries() {
  ALL_ENTRIES = await idbGetAll(STORE_ENTRIES);
}

async function saveEntry(entry) {
  entry.updatedAt = new Date().toISOString();
  await idbPut(STORE_ENTRIES, entry);
  const idx = ALL_ENTRIES.findIndex((e) => e.id === entry.id);
  if (idx > -1) ALL_ENTRIES[idx] = entry; else ALL_ENTRIES.push(entry);
}

function getEntry(id) {
  return ALL_ENTRIES.find((e) => e.id === id);
}

async function deleteEntry(id) {
  await idbDelete(STORE_ENTRIES, id);
  ALL_ENTRIES = ALL_ENTRIES.filter((e) => e.id !== id);
}

/* ---------------------------------------------------------------------- */
/* Utilities                                                              */
/* ---------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.style.display = 'none'; }, 2200);
}

function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('modal-sheet').innerHTML = '';
}

function openModal(html) {
  document.getElementById('modal-sheet').innerHTML = html;
  document.getElementById('overlay').classList.add('open');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Downscale an uploaded image before storing, so IndexedDB doesn't balloon.
function fileToCompressedDataUrl(file, maxDim = 900, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getProxyUrl() {
  return localStorage.getItem('yj_proxy_url') || '';
}
function setProxyUrl(url) {
  localStorage.setItem('yj_proxy_url', url.trim());
}

/* ---------------------------------------------------------------------- */
/* Router                                                                 */
/* ---------------------------------------------------------------------- */

function navigate(view, entryId) {
  STATE.view = view;
  STATE.entryId = entryId || null;
  window.scrollTo(0, 0);
  render();
}

/* ---------------------------------------------------------------------- */
/* Render: root switch                                                    */
/* ---------------------------------------------------------------------- */

function render() {
  const root = document.getElementById('view-root');
  if (STATE.view === 'home') root.innerHTML = renderHome();
  else if (STATE.view === 'detail') root.innerHTML = renderDetail(getEntry(STATE.entryId));
  else if (STATE.view === 'database') root.innerHTML = renderDatabase();
  else if (STATE.view === 'review') root.innerHTML = renderReviewQueue();
  else if (STATE.view === 'duplicates') root.innerHTML = renderDuplicates();
  attachRootHandlers();
}

/* ---------------------------------------------------------------------- */
/* HOME VIEW                                                              */
/* ---------------------------------------------------------------------- */

function filteredEntries() {
  const q = STATE.search.trim().toLowerCase();
  return ALL_ENTRIES.filter((e) => {
    // Favorites tab pulls from both Reading and Watching, ignoring the format toggle.
    if (STATE.showFavoritesOnly) {
      if (!e.favorite) return false;
    } else if (e.format !== STATE.format) {
      return false;
    }
    if (STATE.shelf !== 'ALL' && e.shelf !== STATE.shelf) return false;
    if (STATE.tagFilter) {
      const allTags = [...(e.tags || []), ...(e.customTags || [])];
      if (!allTags.includes(STATE.tagFilter)) return false;
    }
    if (STATE.smutFilter && (e.smutRating || 0) < STATE.smutFilter) return false;
    if (STATE.qualityFilter && (e.qualityRating || 0) < STATE.qualityFilter) return false;
    if (q) {
      const hay = [e.title, e.altTitle, e.author, e.artist, e.notes, ...(e.tags || []), ...(e.customTags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function topTags(entries) {
  const counts = {};
  entries.forEach((e) => (e.tags || []).concat(e.customTags || []).forEach((t) => {
    const v = String(t || '').trim();
    if (!v || v.toLowerCase() === 'nan' || v.toLowerCase() === 'none') return;
    counts[v] = (counts[v] || 0) + 1;
  }));
  // Show every real tag, alphabetically, so nothing is hidden behind a top-N cutoff.
  return Object.keys(counts).sort((a, b) => a.localeCompare(b));
}

function renderCoverCard(e) {
  const isSuggested = !e.coverUrl && e.suggestedMatch && e.suggestedMatch.coverUrl;
  const coverSrc = e.coverUrl || (e.suggestedMatch ? e.suggestedMatch.coverUrl : null);
  const cover = coverSrc
    ? `<img src="${escapeHtml(coverSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="${isSuggested ? 'opacity:.55' : ''}" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>🍆</div>'">`
    : `<div class="cover-placeholder">🍆</div>`;
  const flagColor = e.semi && e.semi.flag ? FLAG_HEX[e.semi.flag] : (e.uke && e.uke.flag ? FLAG_HEX[e.uke.flag] : null);
  return `
    <div class="cover-card" data-open-entry="${e.id}">
      <div class="cover-thumb">
        ${cover}
        ${e.favorite ? '<div class="cover-fav-badge">💜</div>' : ''}
        ${isSuggested ? '<div class="cover-fav-badge" style="right:auto;left:5px;" title="Suggested match, unconfirmed">🔎</div>' : ''}
        ${STATE.showFavoritesOnly ? `<div class="cover-format-badge">${e.format === 'reading' ? '📖' : '📺'}</div>` : ''}
        ${flagColor ? `<div class="cover-flag-dot"><span style="color:${flagColor}">&#9873;</span></div>` : ''}
      </div>
      <div class="cover-title">${escapeHtml(e.title)}</div>
      ${e.author ? `<div class="cover-sub">${escapeHtml(e.author)}</div>` : ''}
    </div>`;
}

function renderHome() {
  const entries = filteredEntries();
  const tags = topTags(ALL_ENTRIES.filter((e) => e.format === STATE.format));

  let body = '';
  if (STATE.shelf === 'ALL' && !STATE.tagFilter && !STATE.search && !STATE.showFavoritesOnly && !STATE.smutFilter && !STATE.qualityFilter) {
    // grouped by shelf
    const shelvesToShow = STATE.format === 'reading' ? SHELVES_READING : ['Completed'];
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      body += `<div class="section-title">${escapeHtml(shelf)} <span style="opacity:.6">(${group.length})</span></div>`;
      body += `<div class="cover-grid">${group.map(renderCoverCard).join('')}</div>`;
    });
    if (!body) body = `<div class="empty-state">Nothing here yet. Tap + to add a ${STATE.format === 'reading' ? 'manhwa/manga' : 'anime'}.</div>`;
  } else {
    body = entries.length
      ? `<div class="cover-grid">${entries.map(renderCoverCard).join('')}</div>`
      : `<div class="empty-state">No matches. Try clearing filters.</div>`;
  }

  const shelfChips = STATE.format === 'reading'
    ? ['ALL', ...SHELVES_READING].map((s) => `<div class="chip ${STATE.shelf === s ? 'active' : ''}" data-shelf="${escapeHtml(s)}">${s === 'ALL' ? 'All' : escapeHtml(s)}</div>`).join('')
    : '';

  const tagChips = tags.map((t) => `<div class="chip ${STATE.tagFilter === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`).join('');

  const smutChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.smutFilter && n <= STATE.smutFilter ? 'active' : ''}" data-smut-filter="${n}" title="${n}+ eggplants">🍆</span>`).join('');
  const qualityChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.qualityFilter && n <= STATE.qualityFilter ? 'active' : ''}" data-quality-filter="${n}" title="${n}+ hearts">💗</span>`).join('');

  return `
    <div class="app-header">
      <div class="brand-row">
        <h1><span class="egg">🍆</span>Yaoi Journal</h1>
        <button class="icon-btn" data-open-settings="1">⚙️</button>
      </div>
      <div class="search-bar">
        <span>🔍</span>
        <input type="search" id="search-input" placeholder="Search all reads &amp; anime..." value="${escapeHtml(STATE.search)}">
      </div>
      <div class="tab-row">
        <div class="tab-pill ${!STATE.showFavoritesOnly ? 'active' : ''}" data-fav="0">All</div>
        <div class="tab-pill fav ${STATE.showFavoritesOnly ? 'active' : ''}" data-fav="1">💜 Favorites</div>
      </div>
      <div class="format-row">
        <div class="format-btn ${STATE.format === 'reading' ? 'active' : ''}" data-format="reading">📖 Reading (Manhwa/Manga)</div>
        <div class="format-btn ${STATE.format === 'watching' ? 'active' : ''}" data-format="watching">📺 Watching (Anime)</div>
      </div>
      ${shelfChips ? `<div class="filter-section-label">Status</div><div class="shelf-row">${shelfChips}</div>` : ''}
      ${tagChips ? `<div class="filter-section-label">Tags</div><div class="tag-row">${tagChips}</div>` : ''}
      <div class="filter-section-label">Ratings</div>
      <div class="rating-pick-row">${smutChips}</div>
      <div class="rating-pick-row">${qualityChips}</div>
    </div>
    <main>${body}</main>
    <button class="fab" data-add-entry="1">+</button>
    ${renderBottomNav('home')}
  `;
}

function renderBottomNav(active) {
  return `
    <div class="bottom-nav">
      <button data-nav="home" class="${active === 'home' ? 'active' : ''}"><span class="icon">🏠</span>Journal</button>
      <button data-nav="database" class="${active === 'database' ? 'active' : ''}"><span class="icon">🗂️</span>Database</button>
    </div>`;
}

/* ---------------------------------------------------------------------- */
/* DETAIL / JOURNAL VIEW                                                  */
/* ---------------------------------------------------------------------- */

function renderRatingIcons(value, icon, max = 5) {
  let out = '';
  for (let i = 1; i <= max; i++) out += `<span class="${i <= value ? 'filled' : ''}" data-rate="${i}">${icon}</span>`;
  return out;
}

function renderFlagPicker(current, who) {
  // Use the monochrome "⚑" glyph (not the colored 🚩 emoji) so CSS color actually
  // tints it per flag-color choice, instead of always rendering red.
  return FLAG_COLORS.map((c) => `<div class="flag-dot ${current === c ? 'selected' : ''}" data-flag-pick="${who}:${c}" title="${c[0].toUpperCase()}${c.slice(1)} flag"><span class="flag-glyph" style="color:${FLAG_HEX[c]}">&#9873;</span></div>`).join('');
}

function renderCharPhoto(photo) {
  return photo ? `<img src="${photo}" alt="">` : '📷';
}

function renderTagCloud(e) {
  const auto = (e.tags || []).map((t) => `<div class="tag-chip">${escapeHtml(t)}</div>`);
  const custom = (e.customTags || []).map((t) => `<div class="tag-chip custom">${escapeHtml(t)} <button data-remove-tag="${escapeHtml(t)}">✕</button></div>`);
  return auto.concat(custom).join('') || '<span style="color:var(--text-dim);font-size:12.5px;">No tags yet.</span>';
}

function renderDetail(e) {
  if (!e) return `<div class="empty-state">Entry not found.</div>${renderBottomNav('home')}`;
  const isReading = e.format === 'reading';

  // Summary pulled live from the reference platform — prefer a confirmed reference's
  // cached summary, fall back to a not-yet-applied suggested match's summary.
  const topSummaryText = (e.referenceUrl && e.referenceStatus === 'confirmed' && e.summaryCache)
    ? e.summaryCache
    : (e.suggestedMatch && e.suggestedMatch.summary) ? e.suggestedMatch.summary : '';
  const topSummaryUnconfirmed = !(e.referenceUrl && e.referenceStatus === 'confirmed') && e.suggestedMatch;

  const detailsHtml = isReading ? `
      <div class="field-row"><label>Author</label><div class="value plain">${escapeHtml(e.author) || '—'}</div></div>
      <div class="field-row"><label>Artist</label><div class="value plain">${escapeHtml(e.artist) || '—'}</div></div>
      ${e.totalChapters ? `<div class="field-row"><label>Chapters</label><div class="value plain">${e.totalChapters}</div></div>` : ''}
      ${e.totalSeasons ? `<div class="field-row"><label>Seasons</label><div class="value plain">${e.totalSeasons}</div></div>` : ''}
      <div class="field-row"><label>Status</label><div class="value plain">${escapeHtml(e.status) || '—'}</div></div>
      ${topSummaryText ? `
        <div class="field-row">
          <label>Summary ${topSummaryUnconfirmed ? '(unconfirmed match)' : ''}</label>
          <div class="value plain">${escapeHtml(topSummaryText.slice(0, 260))}${topSummaryText.length > 260 ? '…' : ''}</div>
        </div>` : ''}
  ` : `
      <div class="field-row"><label>Notes (legacy)</label><div class="value plain">${escapeHtml(e.legacyNote) || '—'}</div></div>
      ${topSummaryText ? `
        <div class="field-row">
          <label>Summary ${topSummaryUnconfirmed ? '(unconfirmed match)' : ''}</label>
          <div class="value plain">${escapeHtml(topSummaryText.slice(0, 260))}${topSummaryText.length > 260 ? '…' : ''}</div>
        </div>` : ''}
  `;

  const shelfToggles = isReading ? `
    <div class="field-row" style="margin-top:4px;">
      <label>Shelf</label>
      <div class="status-toggle-row">
        ${SHELVES_READING.map((s) => `<div class="status-toggle ${e.shelf === s ? 'active' : ''}" data-set-shelf="${s}">${s}</div>`).join('')}
      </div>
    </div>` : '';

  let referencePanel;
  if (e.referenceUrl && e.referenceStatus === 'confirmed') {
    referencePanel = `
      <div class="summary-text">${escapeHtml(e.summaryCache) || '<em>No summary cached — tap refresh.</em>'}</div>
      <div class="summary-source">
        <a href="${escapeHtml(e.referenceUrl)}" target="_blank">${escapeHtml(e.referenceSite || 'source')} ↗</a>
        &nbsp;·&nbsp;
        <button class="ref-btn" data-refresh-ref="1">↻ Refresh</button>
        <button class="ref-btn" data-open-crossref="1">Change link</button>
      </div>`;
  } else if (e.suggestedMatch) {
    const sm = e.suggestedMatch;
    referencePanel = `
      <div style="font-size:11.5px;color:var(--yellow);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">🔎 Suggested match (${escapeHtml(sm.confidence || 'unconfirmed')}) — not yet applied</div>
      <div class="match-preview">
        ${sm.coverUrl ? `<img src="${escapeHtml(sm.coverUrl)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
        <div class="info">
          <strong>${escapeHtml(sm.title || e.title)}</strong>
          ${sm.altTitle ? escapeHtml(sm.altTitle) + '<br>' : ''}
          ${sm.author ? 'By ' + escapeHtml(sm.author) + '<br>' : ''}
          ${(sm.tags || []).slice(0, 6).join(', ')}
          <p style="margin:6px 0 0;">${escapeHtml((sm.summary || '').slice(0, 220))}${(sm.summary || '').length > 220 ? '…' : ''}</p>
        </div>
      </div>
      ${sm.notes ? `<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">${escapeHtml(sm.notes)}</div>` : ''}
      <div class="modal-actions" style="margin-top:0;">
        <button class="btn-ghost" data-dismiss-suggested="1">Dismiss</button>
        <button class="btn-primary" data-use-suggested="1">✓ Use this match</button>
      </div>
      ${sm.url ? `<div style="margin-top:8px;"><a href="${escapeHtml(sm.url)}" target="_blank" style="font-size:11.5px;">View on ${escapeHtml(sm.site || 'Anime-Planet')} ↗</a></div>` : ''}
  `;
  } else {
    referencePanel = `
      <div style="color:var(--text-dim);font-size:12.5px;margin-bottom:8px;">Not linked to a reference page yet.</div>
      <button class="ref-btn" data-open-crossref="1">🔗 Cross-reference from Anime-Planet</button>
  `;
  }

  return `
    <div class="detail-header">
      <button class="back-btn" data-nav="home">← Back</button>
      <h2>${escapeHtml(e.title)}</h2>
      <button class="icon-btn" data-toggle-fav="1">${e.favorite ? '💜' : '🤍'}</button>
    </div>
    <div class="journal">

      <!-- 1. Cover + details -->
      <div class="panel">
        <div class="split-row">
          <div>
            <div class="cover-slot">${e.coverUrl ? `<img src="${escapeHtml(e.coverUrl)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='🍆'">` : '🍆'}</div>
            <label class="upload-btn" style="margin-top:6px;display:block;text-align:center;font-size:11px;padding:6px 4px;cursor:pointer;">📷 ${e.coverUrl ? 'Change cover' : 'Upload cover'}<input type="file" accept="image/*" style="display:none" id="cover-upload-input"></label>
          </div>
          <div>
            <div class="field-row"><label>Title</label><div class="value plain">${escapeHtml(e.title)}</div></div>
            ${e.altTitle ? `<div class="field-row"><label>Alt title</label><div class="value plain">${escapeHtml(e.altTitle)}</div></div>` : ''}
            ${detailsHtml}
          </div>
        </div>
        ${shelfToggles}
      </div>

      <!-- 2. Ratings -->
      <div class="panel">
        <div class="rating-row">
          <div class="rating-block">
            <div class="label">Smut Level</div>
            <div class="rating-icons" data-rating="smutRating">${renderRatingIcons(e.smutRating, '🍆')}</div>
          </div>
          <div class="rating-block">
            <div class="label">Overall</div>
            <div class="rating-icons" data-rating="qualityRating">${renderRatingIcons(e.qualityRating, '💗')}</div>
          </div>
        </div>
      </div>

      <!-- 3. Uke / Semi -->
      <div class="panel">
        <div class="char-cols">
          <div class="char-col">
            <div class="char-col-head">
              <h4>Semi (Top)</h4>
              <div class="flag-picker">${renderFlagPicker(e.semi.flag, 'semi')}</div>
            </div>
            <label class="char-photo-slot" style="cursor:pointer;">
              ${renderCharPhoto(e.semi.photo)}
              <input type="file" accept="image/*" style="display:none" data-char-photo="semi">
            </label>
            <textarea placeholder="Notes on the semi..." data-char-notes="semi">${escapeHtml(e.semi.notes)}</textarea>
          </div>
          <div class="char-col">
            <div class="char-col-head">
              <h4>Uke (Bottom)</h4>
              <div class="flag-picker">${renderFlagPicker(e.uke.flag, 'uke')}</div>
            </div>
            <label class="char-photo-slot" style="cursor:pointer;">
              ${renderCharPhoto(e.uke.photo)}
              <input type="file" accept="image/*" style="display:none" data-char-photo="uke">
            </label>
            <textarea placeholder="Notes on the uke..." data-char-notes="uke">${escapeHtml(e.uke.notes)}</textarea>
          </div>
        </div>
      </div>

      <!-- 4. Tags -->
      <div class="panel">
        <div class="panel-title">Tags</div>
        <div class="tag-cloud">${renderTagCloud(e)}</div>
        <div class="add-tag-row">
          <input type="text" id="new-tag-input" placeholder="Add your own tag...">
          <button data-add-tag="1">Add</button>
        </div>
      </div>

      <!-- 5. Summary (from reference) -->
      <div class="panel">
        <div class="panel-title">Summary</div>
        ${referencePanel}
      </div>

      <!-- 6. User notes -->
      <div class="panel">
        <div class="panel-title">Your Notes / Review</div>
        <textarea id="user-notes" placeholder="Your thoughts...">${escapeHtml(e.notes)}</textarea>
      </div>

      <!-- 7. Screencaps -->
      <div class="panel">
        <div class="panel-title">Screencaps</div>
        <label class="upload-btn">📎 Add photo(s)<input type="file" accept="image/*" multiple id="screencap-input"></label>
        <div class="screencap-grid">
          ${(e.screencaps || []).map((src, i) => `<div class="screencap-thumb"><img src="${src}"><button class="del" data-del-screencap="${i}">✕</button></div>`).join('')}
        </div>
      </div>

      <!-- PDF / read link -->
      <div class="panel">
        <div class="panel-title">Read Link</div>
        <div class="pdf-row">
          <input type="text" id="pdf-link" placeholder="https:// or a note like 'Panels > BL folder'" value="${escapeHtml(e.pdfLink)}">
        </div>
        ${e.pdfLink && /^https?:\/\//.test(e.pdfLink) ? `<a class="open-link" href="${escapeHtml(e.pdfLink)}" target="_blank" style="display:inline-block;margin-top:8px;">Open</a>` : ''}
      </div>

    </div>
    ${renderBottomNav('home')}
  `;
}

/* ---------------------------------------------------------------------- */
/* DATABASE / REFERENCE VIEW                                              */
/* ---------------------------------------------------------------------- */

function needsReview(e) {
  // Anything missing both a real cover and a confirmed reference link should be
  // looked at, whether or not a suggested match already exists for it.
  return !e.coverUrl && !e.referenceUrl;
}

function renderDatabase() {
  const rows = ALL_ENTRIES.slice().sort((a, b) => a.title.localeCompare(b.title));
  const reviewCount = ALL_ENTRIES.filter(needsReview).length;
  const dupCount = findDuplicateGroups().length;
  const cols = ['Title', 'Format', 'Shelf', 'Author', 'Tags', 'Semi Flag', 'Uke Flag', 'Smut', 'Quality', 'Favorite', 'Notes'];
  const trs = rows.map((e) => `
    <tr>
      <td>${escapeHtml(e.title)}</td>
      <td>${e.format}</td>
      <td>${escapeHtml(e.shelf)}</td>
      <td>${escapeHtml(e.author)}</td>
      <td>${escapeHtml((e.tags || []).concat(e.customTags || []).join(', '))}</td>
      <td>${e.semi.flag || ''}</td>
      <td>${e.uke.flag || ''}</td>
      <td>${e.smutRating || 0}</td>
      <td>${e.qualityRating || 0}</td>
      <td>${e.favorite ? 'Yes' : ''}</td>
      <td>${escapeHtml(e.notes)}</td>
    </tr>`).join('');

  return `
    <div class="app-header">
      <div class="brand-row"><h1>🗂️ Database Mode</h1></div>
      <div class="search-bar"><span>🔍</span><input type="search" id="db-search" placeholder="Filter table..."></div>
    </div>
    <main>
      <div class="panel" style="margin-bottom:14px;">
        <div class="panel-title">Data Cleanup Tools</div>
        <div class="export-row">
          <button class="ref-btn" data-nav="review">🔎 Review missing cover/reference (${reviewCount})</button>
          <button class="ref-btn" data-nav="duplicates">🧬 Review duplicates (${dupCount})</button>
        </div>
      </div>
      <div class="export-row">
        <button class="ref-btn" data-export-csv="1">⬇ Export CSV</button>
        <span style="color:var(--text-dim);font-size:12.5px;align-self:center;">${rows.length} total entries</span>
      </div>
      <div class="db-table-wrap">
        <table class="db-table" id="db-table">
          <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
    </main>
    ${renderBottomNav('database')}
  `;
}

/* ---------------------------------------------------------------------- */
/* BULK SUGGESTED-MATCH REVIEW                                            */
/* ---------------------------------------------------------------------- */

function renderReviewCard(e) {
  const sm = e.suggestedMatch;
  const cover = (sm && sm.coverUrl)
    ? `<img src="${escapeHtml(sm.coverUrl)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>🍆</div>'">`
    : `<div class="cover-placeholder">🍆</div>`;
  return `
    <div class="panel review-card" data-entry="${e.id}">
      <div class="review-card-row">
        <div class="cover-thumb" style="width:78px;flex:0 0 78px;">${cover}</div>
        <div class="review-card-info">
          <strong>${escapeHtml(e.title)}</strong>
          <div style="font-size:11px;color:var(--text-dim);margin:2px 0 4px;">${e.format === 'reading' ? '📖' : '📺'} ${escapeHtml(e.shelf)}${e.author ? ' · ' + escapeHtml(e.author) : ''}</div>
          ${sm ? `
            <div style="font-size:11.5px;color:var(--yellow);">Suggested: ${escapeHtml(sm.title || '')} <span style="opacity:.7">(${escapeHtml(sm.confidence || 'unconfirmed')})</span></div>
            ${sm.tags && sm.tags.length ? `<div style="font-size:11px;color:var(--text-dim);">${escapeHtml(sm.tags.slice(0, 5).join(', '))}</div>` : ''}
          ` : `<div style="font-size:11.5px;color:var(--text-dim);">No suggested match found — needs a manual cross-reference.</div>`}
        </div>
      </div>
      <div class="modal-actions" style="margin-top:10px;">
        <button class="ref-btn" data-open-entry="${e.id}">Open</button>
        ${sm ? `
          <button class="btn-ghost" data-review-dismiss="${e.id}">Dismiss</button>
          <button class="btn-primary" data-review-use="${e.id}">✓ Use this match</button>
        ` : `<button class="ref-btn" data-open-entry="${e.id}">🔗 Cross-reference manually</button>`}
      </div>
    </div>`;
}

function renderReviewQueue() {
  const items = ALL_ENTRIES.filter(needsReview).sort((a, b) => a.title.localeCompare(b.title));
  const body = items.length
    ? items.map(renderReviewCard).join('')
    : `<div class="empty-state">Everything has a cover or reference link. 🎉</div>`;
  return `
    <div class="app-header">
      <div class="brand-row">
        <button class="back-btn" data-nav="database">← Back</button>
        <h1>Review Missing Cover/Reference</h1>
      </div>
      <div style="color:var(--text-dim);font-size:12px;padding:0 2px;">${items.length} item${items.length === 1 ? '' : 's'} to check. Approving applies the suggested cover, tags, author, and reference link to your journal entry.</div>
    </div>
    <main>${body}</main>
    ${renderBottomNav('database')}
  `;
}

/* ---------------------------------------------------------------------- */
/* DUPLICATE REVIEW                                                       */
/* ---------------------------------------------------------------------- */

function duplicateKey(title) {
  const stop = new Set(['the', 'a', 'an', 'of', 'and']);
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .sort()
    .join(' ');
}

function findDuplicateGroups() {
  const groups = {};
  ALL_ENTRIES.forEach((e) => {
    const key = duplicateKey(e.title);
    if (!key) return;
    const groupKey = e.format + '::' + key;
    (groups[groupKey] = groups[groupKey] || []).push(e);
  });
  return Object.values(groups).filter((g) => g.length > 1);
}

function renderDuplicateGroup(group) {
  const items = group.map((e) => {
    const coverSrc = e.coverUrl || (e.suggestedMatch ? e.suggestedMatch.coverUrl : null);
    const cover = coverSrc
      ? `<img src="${escapeHtml(coverSrc)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>🍆</div>'">`
      : `<div class="cover-placeholder">🍆</div>`;
    return `
      <div class="dup-item">
        <div class="cover-thumb" style="width:64px;flex:0 0 64px;">${cover}</div>
        <div class="review-card-info">
          <strong>${escapeHtml(e.title)}</strong>
          <div style="font-size:11px;color:var(--text-dim);">${escapeHtml(e.shelf)}${e.author ? ' · ' + escapeHtml(e.author) : ''}</div>
          <div style="font-size:11px;color:var(--text-dim);">Updated ${e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : '—'}${e.favorite ? ' · 💜 favorite' : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="ref-btn" data-open-entry="${e.id}">Open</button>
          <button class="btn-ghost" data-dup-delete="${e.id}">Delete this one</button>
        </div>
      </div>`;
  }).join('');
  return `<div class="panel"><div class="panel-title">Possible duplicate</div>${items}</div>`;
}

function renderDuplicates() {
  const groups = findDuplicateGroups();
  const body = groups.length
    ? groups.map(renderDuplicateGroup).join('')
    : `<div class="empty-state">No duplicates detected. 🎉</div>`;
  return `
    <div class="app-header">
      <div class="brand-row">
        <button class="back-btn" data-nav="database">← Back</button>
        <h1>Review Duplicates</h1>
      </div>
      <div style="color:var(--text-dim);font-size:12px;padding:0 2px;">${groups.length} possible duplicate group${groups.length === 1 ? '' : 's'}. Compare the details, then delete the one you don't want to keep.</div>
    </div>
    <main>${body}</main>
    ${renderBottomNav('database')}
  `;
}

function exportCsv() {
  const rows = ALL_ENTRIES.slice().sort((a, b) => a.title.localeCompare(b.title));
  const cols = ['title', 'altTitle', 'format', 'shelf', 'author', 'artist', 'isNovel', 'status', 'tags', 'semiFlag', 'semiNotes', 'ukeFlag', 'ukeNotes', 'smutRating', 'qualityRating', 'favorite', 'notes', 'referenceUrl', 'pdfLink'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  rows.forEach((e) => {
    lines.push([
      e.title, e.altTitle, e.format, e.shelf, e.author, e.artist, e.isNovel, e.status,
      (e.tags || []).concat(e.customTags || []).join('; '),
      e.semi.flag, e.semi.notes, e.uke.flag, e.uke.notes,
      e.smutRating, e.qualityRating, e.favorite, e.notes, e.referenceUrl, e.pdfLink
    ].map(esc).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'yaoi-journal-export.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------- */
/* Cross-reference (Anime-Planet) flow                                    */
/* ---------------------------------------------------------------------- */

function openCrossRefModal(entryId) {
  const e = getEntry(entryId);
  const proxy = getProxyUrl();
  const searchUrl = 'https://www.anime-planet.com/manga/all?name=' + encodeURIComponent(e.title);
  openModal(`
    <h3>Cross-reference "${escapeHtml(e.title)}"</h3>
    ${proxy ? '' : `<div style="background:var(--pink-soft);color:var(--pink);padding:8px 10px;border-radius:8px;font-size:12px;margin-bottom:10px;">No proxy URL set yet. Add one in Settings (⚙️) to enable live fetching — see the setup notes I gave you.</div>`}
    <p style="font-size:12.5px;color:var(--text-dim);">1. Find the title on Anime-Planet, then paste its page URL below.</p>
    <a class="ref-btn" href="${searchUrl}" target="_blank" style="display:inline-block;margin-bottom:10px;text-decoration:none;">🔍 Search Anime-Planet for this title ↗</a>
    <div class="field-row"><label>Anime-Planet URL</label><input type="text" id="crossref-url" placeholder="https://www.anime-planet.com/manga/..."></div>
    <div class="modal-actions">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
      <button class="btn-primary" data-fetch-ref="${entryId}">Preview</button>
    </div>
    <div id="crossref-preview"></div>
  `);
}

async function fetchReferencePreview(entryId) {
  const urlInput = document.getElementById('crossref-url');
  const url = urlInput.value.trim();
  if (!url) { showToast('Paste a URL first'); return; }
  const proxy = getProxyUrl();
  if (!proxy) { showToast('Set your proxy URL in Settings first'); return; }
  const previewEl = document.getElementById('crossref-preview');
  previewEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);">Fetching…</div>';
  try {
    const resp = await fetch(proxy + '?action=fetchReference&url=' + encodeURIComponent(url));
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    previewEl.innerHTML = `
      <div class="match-preview">
        <img src="${escapeHtml(data.coverUrl || '')}" referrerpolicy="no-referrer" onerror="this.style.display='none'">
        <div class="info">
          <strong>${escapeHtml(data.title || '(no title found)')}</strong>
          ${data.altTitle ? escapeHtml(data.altTitle) + '<br>' : ''}
          ${data.author ? 'By ' + escapeHtml(data.author) + '<br>' : ''}
          ${(data.tags || []).slice(0, 8).join(', ')}
          <p style="margin:6px 0 0;">${escapeHtml((data.summary || '').slice(0, 220))}${(data.summary || '').length > 220 ? '…' : ''}</p>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" data-close-modal="1">Cancel</button>
        <button class="btn-primary" data-confirm-ref="${entryId}">✓ Use this — apply to my journal</button>
      </div>
    `;
    previewEl._pendingData = data;
    previewEl._pendingUrl = url;
  } catch (err) {
    previewEl.innerHTML = `<div style="color:var(--red-flag);font-size:12.5px;padding:8px 0;">Couldn't fetch: ${escapeHtml(err.message)}</div>`;
  }
}

async function confirmReference(entryId) {
  const previewEl = document.getElementById('crossref-preview');
  const data = previewEl._pendingData;
  const url = previewEl._pendingUrl;
  const e = getEntry(entryId);
  if (data.coverUrl) e.coverUrl = data.coverUrl;
  e.referenceUrl = url;
  e.referenceSite = url.includes('mangago') ? 'MangaGo' : 'Anime-Planet';
  e.referenceStatus = 'confirmed';
  e.summaryCache = data.summary || '';
  e.summaryCachedAt = new Date().toISOString();
  if (data.tags && data.tags.length) {
    const merged = new Set([...(e.tags || []), ...data.tags]);
    e.tags = Array.from(merged);
  }
  if (!e.author && data.author) e.author = data.author;
  if (!e.altTitle && data.altTitle) e.altTitle = data.altTitle;
  await saveEntry(e);
  closeModal();
  showToast('Linked! Summary & cover pulled in.');
  navigate('detail', entryId);
}

/* ---------------------------------------------------------------------- */
/* Settings modal                                                         */
/* ---------------------------------------------------------------------- */

function openSettingsModal() {
  openModal(`
    <h3>⚙️ Settings</h3>
    <div class="field-row">
      <label>Cross-reference proxy URL (your Apps Script web app URL)</label>
      <input type="text" id="proxy-url-input" value="${escapeHtml(getProxyUrl())}" placeholder="https://script.google.com/macros/s/.../exec">
    </div>
    <p style="font-size:11.5px;color:var(--text-dim);">This is only used when you tap "Cross-reference" on an entry — it fetches the Anime-Planet page server-side so the app can read the summary/cover. No reading data is ever sent out.</p>
    <div class="modal-actions">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
      <button class="btn-primary" data-save-settings="1">Save</button>
    </div>
  `);
}

/* ---------------------------------------------------------------------- */
/* Add entry modal                                                        */
/* ---------------------------------------------------------------------- */

function openAddModal() {
  openModal(`
    <h3>Add new ${STATE.format === 'reading' ? 'manhwa/manga' : 'anime'}</h3>
    <div class="field-row"><label>Title *</label><input type="text" id="add-title"></div>
    <div class="field-row"><label>Author</label><input type="text" id="add-author"></div>
    <div class="modal-actions">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
      <button class="btn-primary" data-submit-add="1">Add</button>
    </div>
  `);
}

async function submitAdd() {
  const title = document.getElementById('add-title').value.trim();
  if (!title) { showToast('Title is required'); return; }
  const author = document.getElementById('add-author').value.trim();
  const entry = {
    id: uid(STATE.format === 'reading' ? 'manhwa' : 'anime'),
    format: STATE.format, title, altTitle: '', author, artist: '', isNovel: false,
    totalSeasons: null, totalChapters: null, epilogue: '', officialLink: '', released: null,
    status: '', currentlyReadingRaw: '', downloaded: '',
    shelf: STATE.format === 'reading' ? 'Plan to Read' : 'Completed',
    tags: [], customTags: [], notes: '', favorite: false,
    coverUrl: null, referenceUrl: null, referenceSite: null, referenceStatus: 'none', suggestedMatch: null,
    summaryCache: null, summaryCachedAt: null, smutRating: 0, qualityRating: 0,
    semi: { flag: null, notes: '', photo: null }, uke: { flag: null, notes: '', photo: null },
    screencaps: [], pdfLink: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  await saveEntry(entry);
  closeModal();
  showToast('Added');
  navigate('detail', entry.id);
}

/* ---------------------------------------------------------------------- */
/* Event delegation                                                       */
/* ---------------------------------------------------------------------- */

function attachRootHandlers() {
  const root = document.getElementById('view-root');

  root.querySelectorAll('[data-open-entry]').forEach((el) => {
    el.onclick = () => navigate('detail', el.getAttribute('data-open-entry'));
  });
  root.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => navigate(el.getAttribute('data-nav'));
  });
  const searchInput = root.querySelector('#search-input');
  if (searchInput) {
    searchInput.oninput = (ev) => { STATE.search = ev.target.value; renderHomeInPlace(); };
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
  root.querySelectorAll('[data-fav]').forEach((el) => {
    el.onclick = () => { STATE.showFavoritesOnly = el.getAttribute('data-fav') === '1'; render(); };
  });
  root.querySelectorAll('[data-format]').forEach((el) => {
    el.onclick = () => { STATE.format = el.getAttribute('data-format'); STATE.shelf = 'ALL'; STATE.tagFilter = null; STATE.smutFilter = null; STATE.qualityFilter = null; render(); };
  });
  root.querySelectorAll('[data-shelf]').forEach((el) => {
    el.onclick = () => { STATE.shelf = el.getAttribute('data-shelf'); render(); };
  });
  root.querySelectorAll('[data-tag]').forEach((el) => {
    el.onclick = () => {
      const t = el.getAttribute('data-tag');
      STATE.tagFilter = STATE.tagFilter === t ? null : t;
      render();
    };
  });
  root.querySelectorAll('[data-smut-filter]').forEach((el) => {
    el.onclick = () => {
      const n = Number(el.getAttribute('data-smut-filter'));
      STATE.smutFilter = STATE.smutFilter === n ? null : n;
      render();
    };
  });
  root.querySelectorAll('[data-quality-filter]').forEach((el) => {
    el.onclick = () => {
      const n = Number(el.getAttribute('data-quality-filter'));
      STATE.qualityFilter = STATE.qualityFilter === n ? null : n;
      render();
    };
  });
  const addBtn = root.querySelector('[data-add-entry]');
  if (addBtn) addBtn.onclick = openAddModal;
  const settingsBtn = root.querySelector('[data-open-settings]');
  if (settingsBtn) settingsBtn.onclick = openSettingsModal;

  // Detail view handlers
  const favBtn = root.querySelector('[data-toggle-fav]');
  if (favBtn) favBtn.onclick = async () => {
    const e = getEntry(STATE.entryId); e.favorite = !e.favorite; await saveEntry(e); render();
  };
  root.querySelectorAll('[data-set-shelf]').forEach((el) => {
    el.onclick = async () => {
      const e = getEntry(STATE.entryId); e.shelf = el.getAttribute('data-set-shelf'); await saveEntry(e); render(); showToast('Shelf updated');
    };
  });
  root.querySelectorAll('[data-rating]').forEach((container) => {
    const field = container.getAttribute('data-rating');
    container.querySelectorAll('[data-rate]').forEach((star) => {
      star.onclick = async () => {
        const e = getEntry(STATE.entryId);
        const val = Number(star.getAttribute('data-rate'));
        e[field] = e[field] === val ? 0 : val; // tap same value again to clear
        await saveEntry(e); render();
      };
    });
  });
  root.querySelectorAll('[data-flag-pick]').forEach((el) => {
    el.onclick = async () => {
      const [who, color] = el.getAttribute('data-flag-pick').split(':');
      const e = getEntry(STATE.entryId);
      e[who].flag = e[who].flag === color ? null : color;
      await saveEntry(e); render();
    };
  });
  root.querySelectorAll('[data-char-notes]').forEach((el) => {
    el.onblur = async () => {
      const who = el.getAttribute('data-char-notes');
      const e = getEntry(STATE.entryId);
      e[who].notes = el.value;
      await saveEntry(e);
    };
  });
  root.querySelectorAll('[data-char-photo]').forEach((el) => {
    el.onchange = async () => {
      if (!el.files[0]) return;
      const who = el.getAttribute('data-char-photo');
      const dataUrl = await fileToCompressedDataUrl(el.files[0], 500);
      const e = getEntry(STATE.entryId);
      e[who].photo = dataUrl;
      await saveEntry(e); render();
    };
  });
  const coverUploadInput = root.querySelector('#cover-upload-input');
  if (coverUploadInput) coverUploadInput.onchange = async () => {
    if (!coverUploadInput.files[0]) return;
    const dataUrl = await fileToCompressedDataUrl(coverUploadInput.files[0], 700);
    const e = getEntry(STATE.entryId);
    e.coverUrl = dataUrl;
    await saveEntry(e);
    showToast('Cover updated!');
    render();
  };
  const addTagBtn = root.querySelector('[data-add-tag]');
  if (addTagBtn) addTagBtn.onclick = async () => {
    const input = document.getElementById('new-tag-input');
    const val = input.value.trim();
    if (!val) return;
    const e = getEntry(STATE.entryId);
    e.customTags = e.customTags || [];
    if (!e.customTags.includes(val)) e.customTags.push(val);
    await saveEntry(e); render();
  };
  root.querySelectorAll('[data-remove-tag]').forEach((el) => {
    el.onclick = async () => {
      const t = el.getAttribute('data-remove-tag');
      const e = getEntry(STATE.entryId);
      e.customTags = (e.customTags || []).filter((x) => x !== t);
      await saveEntry(e); render();
    };
  });
  const notesArea = root.querySelector('#user-notes');
  if (notesArea) {
    const autoGrow = () => { notesArea.style.height = 'auto'; notesArea.style.height = (notesArea.scrollHeight + 2) + 'px'; };
    autoGrow();
    notesArea.oninput = autoGrow;
    notesArea.onblur = async () => {
      const e = getEntry(STATE.entryId); e.notes = notesArea.value; await saveEntry(e);
    };
  }
  const pdfInput = root.querySelector('#pdf-link');
  if (pdfInput) pdfInput.onblur = async () => {
    const e = getEntry(STATE.entryId); e.pdfLink = pdfInput.value.trim(); await saveEntry(e); render();
  };
  const screencapInput = root.querySelector('#screencap-input');
  if (screencapInput) screencapInput.onchange = async () => {
    const e = getEntry(STATE.entryId);
    e.screencaps = e.screencaps || [];
    for (const file of screencapInput.files) {
      const dataUrl = await fileToCompressedDataUrl(file, 900);
      e.screencaps.push(dataUrl);
    }
    await saveEntry(e); render();
  };
  root.querySelectorAll('[data-del-screencap]').forEach((el) => {
    el.onclick = async () => {
      const idx = Number(el.getAttribute('data-del-screencap'));
      const e = getEntry(STATE.entryId);
      e.screencaps.splice(idx, 1);
      await saveEntry(e); render();
    };
  });
  const crossRefBtn = root.querySelector('[data-open-crossref]');
  if (crossRefBtn) crossRefBtn.onclick = () => openCrossRefModal(STATE.entryId);
  const useSuggestedBtn = root.querySelector('[data-use-suggested]');
  if (useSuggestedBtn) useSuggestedBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    const sm = e.suggestedMatch;
    if (!sm) return;
    if (sm.coverUrl) e.coverUrl = sm.coverUrl;
    if (sm.url) { e.referenceUrl = sm.url; e.referenceSite = sm.site || 'Anime-Planet'; e.referenceStatus = 'confirmed'; }
    if (sm.summary) e.summaryCache = sm.summary;
    if (sm.tags && sm.tags.length) {
      const merged = new Set([...(e.tags || []), ...sm.tags]);
      e.tags = Array.from(merged);
    }
    if (!e.author && sm.author) e.author = sm.author;
    if (!e.altTitle && sm.altTitle) e.altTitle = sm.altTitle;
    e.suggestedMatch = null;
    await saveEntry(e);
    showToast('Applied!');
    render();
  };
  const dismissSuggestedBtn = root.querySelector('[data-dismiss-suggested]');
  if (dismissSuggestedBtn) dismissSuggestedBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    e.suggestedMatch = null;
    await saveEntry(e);
    showToast('Dismissed');
    render();
  };
  const refreshRefBtn = root.querySelector('[data-refresh-ref]');
  if (refreshRefBtn) refreshRefBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    openCrossRefModal(STATE.entryId);
    document.getElementById('crossref-url').value = e.referenceUrl;
  };

  // Database view
  const exportBtn = root.querySelector('[data-export-csv]');
  if (exportBtn) exportBtn.onclick = exportCsv;
  const dbSearch = root.querySelector('#db-search');
  if (dbSearch) dbSearch.oninput = () => {
    const q = dbSearch.value.toLowerCase();
    root.querySelectorAll('#db-table tbody tr').forEach((tr) => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  };

  // Bulk suggested-match review queue
  root.querySelectorAll('[data-review-use]').forEach((el) => {
    el.onclick = async () => {
      const id = el.getAttribute('data-review-use');
      const e = getEntry(id);
      const sm = e && e.suggestedMatch;
      if (!sm) return;
      if (sm.coverUrl) e.coverUrl = sm.coverUrl;
      if (sm.url) { e.referenceUrl = sm.url; e.referenceSite = sm.site || 'Anime-Planet'; e.referenceStatus = 'confirmed'; }
      if (sm.summary) e.summaryCache = sm.summary;
      if (sm.tags && sm.tags.length) {
        const merged = new Set([...(e.tags || []), ...sm.tags]);
        e.tags = Array.from(merged);
      }
      if (!e.author && sm.author) e.author = sm.author;
      if (!e.altTitle && sm.altTitle) e.altTitle = sm.altTitle;
      e.suggestedMatch = null;
      await saveEntry(e);
      showToast('Applied!');
      render();
    };
  });
  root.querySelectorAll('[data-review-dismiss]').forEach((el) => {
    el.onclick = async () => {
      const id = el.getAttribute('data-review-dismiss');
      const e = getEntry(id);
      if (!e) return;
      e.suggestedMatch = null;
      await saveEntry(e);
      showToast('Dismissed');
      render();
    };
  });

  // Duplicate review
  root.querySelectorAll('[data-dup-delete]').forEach((el) => {
    el.onclick = async () => {
      const id = el.getAttribute('data-dup-delete');
      const e = getEntry(id);
      if (!e) return;
      if (!confirm(`Delete "${e.title}"? This can't be undone.`)) return;
      await deleteEntry(id);
      showToast('Deleted');
      render();
    };
  });
}

// Re-render just the home list portion when typing in search (keeps focus in input)
function renderHomeInPlace() {
  const root = document.getElementById('view-root');
  const main = root.querySelector('main');
  const entries = filteredEntries();
  let body = '';
  if (STATE.shelf === 'ALL' && !STATE.tagFilter && !STATE.search && !STATE.showFavoritesOnly && !STATE.smutFilter && !STATE.qualityFilter) {
    const shelvesToShow = STATE.format === 'reading' ? SHELVES_READING : ['Completed'];
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      body += `<div class="section-title">${escapeHtml(shelf)} <span style="opacity:.6">(${group.length})</span></div>`;
      body += `<div class="cover-grid">${group.map(renderCoverCard).join('')}</div>`;
    });
    if (!body) body = `<div class="empty-state">Nothing here yet.</div>`;
  } else {
    body = entries.length
      ? `<div class="cover-grid">${entries.map(renderCoverCard).join('')}</div>`
      : `<div class="empty-state">No matches. Try clearing filters.</div>`;
  }
  if (main) {
    main.innerHTML = body;
    main.querySelectorAll('[data-open-entry]').forEach((el) => {
      el.onclick = () => navigate('detail', el.getAttribute('data-open-entry'));
    });
  }
}

/* ---------------------------------------------------------------------- */
/* Global modal button delegation (settings/add/crossref use event         */
/* delegation on the overlay itself since they're re-rendered often)       */
/* ---------------------------------------------------------------------- */

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.matches('[data-close-modal]')) closeModal();
  if (t.matches('[data-save-settings]')) {
    const val = document.getElementById('proxy-url-input').value;
    setProxyUrl(val);
    closeModal();
    showToast('Settings saved');
  }
  if (t.matches('[data-submit-add]')) submitAdd();
  if (t.matches('[data-fetch-ref]')) fetchReferencePreview(t.getAttribute('data-fetch-ref'));
  if (t.matches('[data-confirm-ref]')) confirmReference(t.getAttribute('data-confirm-ref'));
});
document.getElementById('overlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'overlay') closeModal();
});

/* ---------------------------------------------------------------------- */
/* Scroll-away filter header (home view only)                             */
/* ---------------------------------------------------------------------- */

let _lastScrollY = 0;
window.addEventListener('scroll', () => {
  if (STATE.view !== 'home') return;
  const header = document.querySelector('.app-header');
  if (!header) return;
  const y = window.scrollY;
  if (y > _lastScrollY && y > 90) {
    header.classList.add('header-hidden');
  } else {
    header.classList.remove('header-hidden');
  }
  _lastScrollY = y;
}, { passive: true });

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */

async function boot() {
  try {
    db = await openDB();
    await ensureSeeded();
    await loadAllEntries();
    render();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  } catch (err) {
    const isFileProtocol = location.protocol === 'file:';
    document.getElementById('view-root').innerHTML = `
      <div style="max-width:520px;margin:60px auto;padding:20px;font-family:-apple-system,sans-serif;color:#f4f2ff;">
        <h2 style="color:#ff4fc3;">Couldn't load the app</h2>
        <p style="color:#a99fc0;font-size:14px;line-height:1.5;">${
          isFileProtocol
            ? "You're opening this file directly (file://). Browsers block apps like this from loading their data file that way. Serve the folder over http instead — see the instructions you were given, or run a local server (e.g. <code>python3 -m http.server</code> in this folder, then open http://localhost:8000)."
            : 'Something went wrong loading your data. Check that seed_data.json is in the same folder as index.html, and check the browser console (right-click → Inspect → Console) for the exact error.'
        }</p>
        <p style="color:#6b6b7a;font-size:12px;">Technical detail: ${escapeHtml(err.message || String(err))}</p>
      </div>`;
    console.error('Boot failed:', err);
  }
}

boot();
