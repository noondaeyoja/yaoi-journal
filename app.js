/* ==========================================================================
   Yaoi Journal — standalone PWA
   All data lives in IndexedDB on this device. No account, no server database.
   The only network calls this app makes are (a) hotlinking cover images
   directly from anime-planet's own CDN, and (b) an optional proxy call to
   your own Apps Script endpoint to pull a summary/metadata preview when you
   cross-reference a title. Nothing you type is ever sent anywhere.
   ========================================================================== */

const DB_NAME = 'yaoiJournalDB';
const DB_VERSION = 2;
const STORE_ENTRIES = 'entries';
const STORE_META = 'meta';
const STORE_REACTIONS = 'reactions';

const SHELVES_READING = ['Currently Reading', 'Completed', 'Plan to Read', 'Discontinued'];
const FLAG_COLORS = ['green', 'red', 'black'];
const FLAG_HEX = { green: '#4ade80', red: '#f87171', black: '#6b6b7a' };

/* ---------------------------------------------------------------------- */
/* Firebase (cross-device sync)                                          */
/* Firestore is the cross-device source of truth; IndexedDB stays as a   */
/* fast local cache so the app still works offline. Data lives under     */
/* users/{uid}/entries/{entryId}, locked down to that uid by security    */
/* rules — nobody else can read or write it.                              */
/* ---------------------------------------------------------------------- */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCyBqSubWsKqBIUzPeSD_1DJcanZTe3byY",
  authDomain: "yaoi-journal.firebaseapp.com",
  projectId: "yaoi-journal",
  storageBucket: "yaoi-journal.firebasestorage.app",
  messagingSenderId: "831194325870",
  appId: "1:831194325870:web:473e60f21f69e8ccae177f",
  measurementId: "G-9BDDPEG94P"
};
firebase.initializeApp(FIREBASE_CONFIG);
const fbAuth = firebase.auth();
const fbStore = firebase.firestore();
try { fbStore.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}

let CURRENT_USER = null;         // signed-in Firebase user, or null = show the sign-in screen
let FIRESTORE_UNSUB = null;      // unsubscribe fn for the live cross-device entries listener
let AUTH_MODE = 'signin';        // 'signin' | 'signup'
let AUTH_ERROR = '';
let AUTH_BUSY = false;
let SYNC_BUSY = false;           // true while the initial pull/push migration is running

// Raw HD-scan lines already fully handled (auto-tagged, manually confirmed,
// or explicitly skipped) — see the HD-match tool. Prevents "re-matching the
// same titles" every time the same drive listing gets pasted back in.
let HD_RESOLVED_RAW = new Set();
// Duplicate-group signatures the user has explicitly said "not a duplicate,
// keep both" for — see Review Duplicates. Prevents that same pair from
// re-surfacing every visit.
let IGNORED_DUP_GROUPS = new Set();

let db = null;
let ALL_ENTRIES = [];              // in-memory cache, synced with IndexedDB
let ALL_REACTIONS = [];            // meme/reaction image library, in-memory cache
let DETAIL_EDIT_MODE = false;      // whether the detail page's top fields are in edit mode
let TAG_EDIT_MODE = false;         // whether the Tags panel is showing its editable (toggle/add/save) UI
let TAG_ENTRIES_FILTER = null;     // which tag name the "view entries with this tag" screen is showing
let TAG_FILTER_OPEN = false;       // whether the homepage tag multi-select dropdown panel is open
let FILTERS_COLLAPSED = false;     // whether the homepage search/tabs/format/Status/Tags/Ratings&Flags block is tucked away
let STATE = {
  view: 'home',            // 'home' | 'detail' | 'tags' | 'database' | 'review' | 'duplicates'
  entryId: null,
  format: 'reading',        // 'reading' | 'watching'
  showFavoritesOnly: false,
  showOnDriveOnly: false,   // "On Yaoi Drive" homepage tab — entries tagged as saved on the drive
  shelf: 'ALL',             // 'ALL' or one of SHELVES_READING
  tagFilters: [],           // array of tag strings; entry matches if it has ANY of these
  smutFilter: null,         // null or 1-5, meaning "at least N eggplants"
  qualityFilter: null,      // null or 1-5, meaning "at least N hearts"
  flagFilter: null,         // null or 'green'|'red'|'black'
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
      if (!_db.objectStoreNames.contains(STORE_REACTIONS)) {
        _db.createObjectStore(STORE_REACTIONS, { keyPath: 'id' });
      }
    };
    // If another tab/window has this same site open on an older version, the
    // upgrade needed here would otherwise hang forever waiting for that other
    // connection to close. onversionchange lets THIS connection release
    // itself the moment a newer version is requested elsewhere (so an old
    // tab doesn't block a new one), and onblocked surfaces a clear message
    // instead of silently hanging if some other tab can't close itself.
    req.onsuccess = (e) => {
      const _db = e.target.result;
      _db.onversionchange = () => { _db.close(); };
      resolve(_db);
    };
    req.onerror = (e) => reject(e.target.error);
    req.onblocked = () => {
      document.getElementById('view-root').innerHTML = `
        <div style="max-width:480px;margin:80px auto;padding:20px;font-family:-apple-system,sans-serif;color:#f4f2ff;text-align:center;">
          <h2 style="color:#ff4fc3;">Almost there</h2>
          <p style="color:#a99fc0;font-size:14px;line-height:1.5;">Yaoi Journal is open in another tab or window somewhere on this device. Close it, then reload this page to finish updating.</p>
        </div>`;
    };
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
  pushEntryToFirestore(entry);
}

function getEntry(id) {
  return ALL_ENTRIES.find((e) => e.id === id);
}

async function deleteEntry(id) {
  await idbDelete(STORE_ENTRIES, id);
  ALL_ENTRIES = ALL_ENTRIES.filter((e) => e.id !== id);
  deleteEntryFromFirestore(id);
}

/* ---------------------------------------------------------------------- */
/* Reactions / meme library                                              */
/* A separate small IndexedDB store (+ Firestore subcollection) of        */
/* uploaded reaction/meme images, reusable across any journal entry.      */
/* ---------------------------------------------------------------------- */

async function loadAllReactions() {
  ALL_REACTIONS = await idbGetAll(STORE_REACTIONS);
}

// SHA-256 of the image bytes (not the whole data-URL string, so the same
// picture re-saved at the same compression settings always hashes the same)
// — used to catch "you already have this meme" on upload.
async function hashDataUrl(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function findReactionByHash(hash) {
  return ALL_REACTIONS.find((r) => r.hash === hash);
}

async function saveReaction(reaction) {
  reaction.updatedAt = new Date().toISOString();
  await idbPut(STORE_REACTIONS, reaction);
  const idx = ALL_REACTIONS.findIndex((r) => r.id === reaction.id);
  if (idx > -1) ALL_REACTIONS[idx] = reaction; else ALL_REACTIONS.push(reaction);
  pushReactionToFirestore(reaction);
}

async function deleteReaction(id) {
  await idbDelete(STORE_REACTIONS, id);
  ALL_REACTIONS = ALL_REACTIONS.filter((r) => r.id !== id);
  deleteReactionFromFirestore(id);
}

function userReactionsCol() {
  if (!CURRENT_USER) return null;
  return fbStore.collection('users').doc(CURRENT_USER.uid).collection('reactions');
}

function pushReactionToFirestore(reaction) {
  const col = userReactionsCol();
  if (!col) return;
  const json = JSON.stringify(reaction);
  if (json.length > 900 * 1024) {
    console.error(`Reaction image too large to sync to Firestore (kept locally on this device only).`);
    return;
  }
  col.doc(reaction.id).set(reaction).catch((err) => console.error('Reaction sync failed:', err));
}

function deleteReactionFromFirestore(id) {
  const col = userReactionsCol();
  if (!col) return;
  col.doc(id).delete().catch((err) => console.error('Reaction delete sync failed:', err));
}

// Same last-write-wins merge philosophy as syncWithFirestore, applied to the
// much smaller reactions library.
async function syncReactionsWithFirestore(user) {
  const col = fbStore.collection('users').doc(user.uid).collection('reactions');
  const snap = await col.get();
  if (snap.empty) {
    if (ALL_REACTIONS.length) {
      const batch = fbStore.batch();
      ALL_REACTIONS.forEach((r) => {
        if (JSON.stringify(r).length <= 900 * 1024) batch.set(col.doc(r.id), r);
      });
      await batch.commit();
    }
    return;
  }
  const remote = snap.docs.map((d) => d.data());
  const localById = new Map(ALL_REACTIONS.map((r) => [r.id, r]));
  const merged = [];
  const toLocal = [];
  remote.forEach((rr) => {
    const lr = localById.get(rr.id);
    if (!lr) { merged.push(rr); toLocal.push(rr); }
    else {
      const rt = new Date(rr.updatedAt || 0).getTime();
      const lt = new Date(lr.updatedAt || 0).getTime();
      merged.push(rt > lt ? rr : lr);
      if (rt > lt) toLocal.push(rr);
    }
    localById.delete(rr.id);
  });
  localById.forEach((lr) => merged.push(lr));
  if (toLocal.length) await idbBulkPut(STORE_REACTIONS, toLocal);
  ALL_REACTIONS = merged;
}

/* ---------------------------------------------------------------------- */
/* Firestore sync layer                                                   */
/* Best-effort: these never block or throw into the caller. Firestore's   */
/* own offline queue (enablePersistence above) means a write made while   */
/* offline just sits queued and flushes once the connection comes back.   */
/* ---------------------------------------------------------------------- */

function userEntriesCol() {
  if (!CURRENT_USER) return null;
  return fbStore.collection('users').doc(CURRENT_USER.uid).collection('entries');
}

/* ---------------------------------------------------------------------- */
/* Small cross-device "app state" sync — deleted-tag memory, HD-match      */
/* resolved lines, ignored duplicate-groups. These are tiny arrays (not    */
/* image data) so they all live in one Firestore doc, separate from the    */
/* per-entry sync above. Same best-effort, never-throws philosophy.       */
/* ---------------------------------------------------------------------- */

function metaDocRef() {
  if (!CURRENT_USER) return null;
  return fbStore.collection('users').doc(CURRENT_USER.uid).collection('meta').doc('appState');
}

function pushMetaField(field, value) {
  const ref = metaDocRef();
  if (!ref) return;
  ref.set({ [field]: value }, { merge: true }).catch((err) => console.error('Meta sync failed:', err));
}

// Pulls whatever's already in Firestore and unions it into the local sets,
// so a deletion/resolution made on one device shows up on the other without
// ever silently losing one side's decisions.
async function pullMetaState() {
  const ref = metaDocRef();
  if (!ref) return;
  try {
    const snap = await ref.get();
    if (!snap.exists) return;
    const data = snap.data() || {};
    if (Array.isArray(data.deletedTagKeys) && data.deletedTagKeys.length) {
      DELETED_TAG_KEYS = new Set([...DELETED_TAG_KEYS, ...data.deletedTagKeys]);
      await idbPut(STORE_META, { key: 'deletedTagKeys', value: Array.from(DELETED_TAG_KEYS) });
    }
    if (Array.isArray(data.hdResolvedRaw) && data.hdResolvedRaw.length) {
      HD_RESOLVED_RAW = new Set([...HD_RESOLVED_RAW, ...data.hdResolvedRaw]);
      await idbPut(STORE_META, { key: 'hdResolvedRaw', value: Array.from(HD_RESOLVED_RAW) });
    }
    if (Array.isArray(data.ignoredDupGroups) && data.ignoredDupGroups.length) {
      IGNORED_DUP_GROUPS = new Set([...IGNORED_DUP_GROUPS, ...data.ignoredDupGroups]);
      await idbPut(STORE_META, { key: 'ignoredDupGroups', value: Array.from(IGNORED_DUP_GROUPS) });
    }
  } catch (err) {
    console.error('Meta pull failed:', err);
  }
}

// Firestore caps each document at 1MiB. Manually-uploaded cover images are
// stored as base64 data URLs and, on rare oversized uploads, could push a
// single entry over that limit. Rather than fail the whole sync, drop just
// the embedded image from the copy that goes to Firestore (it still lives
// fine in local IndexedDB on this device) and warn once.
const FIRESTORE_DOC_SAFE_BYTES = 900 * 1024;
function firestoreSafeEntry(entry) {
  const json = JSON.stringify(entry);
  if (json.length <= FIRESTORE_DOC_SAFE_BYTES) return entry;
  if (entry.coverUrl && entry.coverUrl.startsWith('data:')) {
    const trimmed = { ...entry, coverUrl: null, coverTooLargeForSync: true };
    if (JSON.stringify(trimmed).length <= FIRESTORE_DOC_SAFE_BYTES) {
      console.warn(`Entry "${entry.title || entry.id}" cover image too large for Firestore sync — kept locally, not synced.`);
      return trimmed;
    }
  }
  console.error(`Entry "${entry.title || entry.id}" is too large to sync to Firestore even after trimming; skipping remote sync for this entry.`);
  return null;
}

function pushEntryToFirestore(entry) {
  const col = userEntriesCol();
  if (!col) return;
  const safe = firestoreSafeEntry(entry);
  if (!safe) return;
  col.doc(entry.id).set(safe).catch((err) => console.error('Firestore save failed:', err));
}

function deleteEntryFromFirestore(id) {
  const col = userEntriesCol();
  if (!col) return;
  col.doc(id).delete().catch((err) => console.error('Firestore delete failed:', err));
}

// Runs once right after sign-in. If this account has never synced before
// (no entries in Firestore yet), push everything currently on this device
// up as the starting point. Otherwise merge: newest updatedAt wins per
// entry, id-by-id, and any local-only or remote-only entries get copied
// over so nothing is ever silently dropped.
async function syncWithFirestore(user) {
  const col = fbStore.collection('users').doc(user.uid).collection('entries');
  const snap = await col.get();

  if (snap.empty) {
    if (ALL_ENTRIES.length) await firestoreBulkWrite(col, ALL_ENTRIES);
    return;
  }

  const remoteEntries = snap.docs.map((d) => d.data());
  const localById = new Map(ALL_ENTRIES.map((e) => [e.id, e]));
  const merged = [];
  const toLocal = [];
  const toRemote = [];

  remoteEntries.forEach((re) => {
    const le = localById.get(re.id);
    if (!le) {
      merged.push(re);
      toLocal.push(re);
    } else {
      const rt = new Date(re.updatedAt || 0).getTime();
      const lt = new Date(le.updatedAt || 0).getTime();
      if (rt > lt) { merged.push(re); toLocal.push(re); }
      else { merged.push(le); if (lt > rt) toRemote.push(le); }
    }
    localById.delete(re.id);
  });
  // Anything left in localById exists only on this device — push it up.
  localById.forEach((le) => { merged.push(le); toRemote.push(le); });

  if (toLocal.length) await idbBulkPut(STORE_ENTRIES, toLocal);
  if (toRemote.length) await firestoreBulkWrite(col, toRemote);
  ALL_ENTRIES = merged;
}

async function firestoreBulkWrite(col, entries) {
  const CHUNK = 400; // stay under Firestore's 500-writes-per-batch limit
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = fbStore.batch();
    entries.slice(i, i + CHUNK).forEach((e) => {
      const safe = firestoreSafeEntry(e);
      if (safe) batch.set(col.doc(e.id), safe);
    });
    await batch.commit();
  }
}

// Live cross-device updates: if she edits on her phone while the desktop
// tab is open, this picks up the change without a manual refresh. The
// very first snapshot right after subscribing just echoes what
// syncWithFirestore() already merged, so it's skipped to avoid redundant
// work and a spurious re-render.
function startFirestoreListener(user) {
  if (FIRESTORE_UNSUB) { FIRESTORE_UNSUB(); FIRESTORE_UNSUB = null; }
  const col = fbStore.collection('users').doc(user.uid).collection('entries');
  let skippedFirst = false;
  FIRESTORE_UNSUB = col.onSnapshot((snap) => {
    if (!skippedFirst) { skippedFirst = true; return; }
    let changed = false;
    snap.docChanges().forEach((change) => {
      const data = change.doc.data();
      if (change.type === 'removed') {
        if (ALL_ENTRIES.some((e) => e.id === data.id)) {
          ALL_ENTRIES = ALL_ENTRIES.filter((e) => e.id !== data.id);
          idbDelete(STORE_ENTRIES, data.id).catch(() => {});
          changed = true;
        }
        return;
      }
      const idx = ALL_ENTRIES.findIndex((e) => e.id === data.id);
      const local = idx > -1 ? ALL_ENTRIES[idx] : null;
      const rt = new Date(data.updatedAt || 0).getTime();
      const lt = local ? new Date(local.updatedAt || 0).getTime() : -1;
      if (rt >= lt) {
        if (idx > -1) ALL_ENTRIES[idx] = data; else ALL_ENTRIES.push(data);
        idbPut(STORE_ENTRIES, data).catch(() => {});
        changed = true;
      }
    });
    if (changed && ['home', 'detail', 'tagEntries', 'tags', 'database'].includes(STATE.view)) render();
  }, (err) => console.error('Firestore listener error:', err));
}

/* ---------------------------------------------------------------------- */
/* Utilities                                                              */
/* ---------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Some author/artist fields came in as comma-joined names with no space
// after the comma (e.g. "Paengyibuhseot,Solanine") — a data artifact from
// the original import. This just fixes the display spacing; stored data is
// untouched.
function formatNames(s) {
  return String(s == null ? '' : s).replace(/,(?!\s)/g, ', ');
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
  DETAIL_EDIT_MODE = false;
  TAG_EDIT_MODE = false;
  TAG_FILTER_OPEN = false;
  window.scrollTo(0, 0);
  render();
}

/* ---------------------------------------------------------------------- */
/* Auth screen — gates the whole app behind a signed-in Firebase account  */
/* so the same journal follows her across phone and desktop.              */
/* ---------------------------------------------------------------------- */

function renderAuthScreen() {
  const isSignup = AUTH_MODE === 'signup';
  return `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-title">💜 Yaoi Journal</div>
        <div class="auth-sub">Sign in to keep your journal in sync between your phone and desktop.</div>
        <div class="auth-tabs">
          <div class="auth-tab ${!isSignup ? 'active' : ''}" data-auth-tab="signin">Sign In</div>
          <div class="auth-tab ${isSignup ? 'active' : ''}" data-auth-tab="signup">Create Account</div>
        </div>
        <div class="field-row">
          <label>Email</label>
          <input type="email" id="auth-email" class="value" autocomplete="username" placeholder="you@example.com">
        </div>
        <div class="field-row">
          <label>Password</label>
          <input type="password" id="auth-password" class="value" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="${isSignup ? 'At least 6 characters' : 'Your password'}">
        </div>
        ${AUTH_ERROR ? `<div class="auth-error">${escapeHtml(AUTH_ERROR)}</div>` : ''}
        <button class="btn-primary auth-submit-btn" data-auth-submit="1" ${AUTH_BUSY ? 'disabled' : ''}>
          ${AUTH_BUSY ? 'Please wait…' : (isSignup ? 'Create Account' : 'Sign In')}
        </button>
        ${!isSignup ? `<div class="auth-forgot" data-auth-forgot="1">Forgot password?</div>` : ''}
      </div>
    </div>`;
}

function attachAuthHandlers() {
  const root = document.getElementById('view-root');
  root.querySelectorAll('[data-auth-tab]').forEach((el) => {
    el.onclick = () => {
      AUTH_MODE = el.getAttribute('data-auth-tab');
      AUTH_ERROR = '';
      render();
    };
  });
  const submitBtn = root.querySelector('[data-auth-submit]');
  const emailInput = root.querySelector('#auth-email');
  const passInput = root.querySelector('#auth-password');
  const doSubmit = () => authSubmit(emailInput.value.trim(), passInput.value);
  if (submitBtn) submitBtn.onclick = doSubmit;
  [emailInput, passInput].forEach((el) => {
    if (el) el.onkeydown = (ev) => { if (ev.key === 'Enter') doSubmit(); };
  });
  const forgotEl = root.querySelector('[data-auth-forgot]');
  if (forgotEl) forgotEl.onclick = () => authForgotPassword((emailInput && emailInput.value.trim()) || '');
}

async function authSubmit(email, password) {
  if (!email || !password) { AUTH_ERROR = 'Enter an email and password.'; render(); return; }
  AUTH_BUSY = true; AUTH_ERROR = ''; render();
  try {
    if (AUTH_MODE === 'signup') {
      await fbAuth.createUserWithEmailAndPassword(email, password);
    } else {
      await fbAuth.signInWithEmailAndPassword(email, password);
    }
    // onAuthStateChanged (wired in boot()) picks up the signed-in user from here.
  } catch (err) {
    AUTH_ERROR = authErrorMessage(err);
    AUTH_BUSY = false;
    render();
  }
}

async function authForgotPassword(email) {
  if (!email) { AUTH_ERROR = 'Enter your email above first, then tap "Forgot password?" again.'; render(); return; }
  try {
    await fbAuth.sendPasswordResetEmail(email);
    showToast(`Password reset email sent to ${email}`);
  } catch (err) {
    AUTH_ERROR = authErrorMessage(err);
    render();
  }
}

function authErrorMessage(err) {
  const code = err && err.code || '';
  if (code === 'auth/email-already-in-use') return 'That email already has an account — try Sign In instead.';
  if (code === 'auth/invalid-email') return 'That doesn\'t look like a valid email address.';
  if (code === 'auth/weak-password') return 'Password needs to be at least 6 characters.';
  if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') return 'Wrong email or password.';
  if (code === 'auth/too-many-requests') return 'Too many attempts — wait a bit and try again.';
  return (err && err.message) || 'Something went wrong. Try again.';
}

async function signOutOfAccount() {
  if (FIRESTORE_UNSUB) { FIRESTORE_UNSUB(); FIRESTORE_UNSUB = null; }
  await fbAuth.signOut();
}

/* ---------------------------------------------------------------------- */
/* Render: root switch                                                    */
/* ---------------------------------------------------------------------- */

function render() {
  const root = document.getElementById('view-root');
  if (!CURRENT_USER) {
    root.innerHTML = renderAuthScreen();
    attachAuthHandlers();
    return;
  }
  if (STATE.view === 'home') root.innerHTML = renderHome();
  else if (STATE.view === 'detail') root.innerHTML = renderDetail(getEntry(STATE.entryId));
  else if (STATE.view === 'tags') root.innerHTML = renderTagManager();
  else if (STATE.view === 'tagEntries') root.innerHTML = renderTagEntries();
  else if (STATE.view === 'hdMatch') root.innerHTML = renderHdMatch();
  else if (STATE.view === 'reactions') root.innerHTML = renderReactionsLibrary();
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
    // Favorites and On Yaoi Drive tabs both pull from Reading + Watching,
    // ignoring the format toggle — same as each other.
    if (STATE.showFavoritesOnly) {
      if (!e.favorite) return false;
    } else if (STATE.showOnDriveOnly) {
      if (!isOnDrive(e)) return false;
    } else if (e.format !== STATE.format) {
      return false;
    }
    if (STATE.shelf !== 'ALL' && e.shelf !== STATE.shelf) return false;
    if (STATE.tagFilters.length) {
      const allTags = [...(e.tags || []), ...(e.customTags || [])];
      if (!STATE.tagFilters.some((t) => allTags.includes(t))) return false;
    }
    if (STATE.smutFilter && (e.smutRating || 0) < STATE.smutFilter) return false;
    if (STATE.qualityFilter && (e.qualityRating || 0) < STATE.qualityFilter) return false;
    if (STATE.flagFilter) {
      const hasFlag = (e.semi && e.semi.flag === STATE.flagFilter) || (e.uke && e.uke.flag === STATE.flagFilter);
      if (!hasFlag) return false;
    }
    if (q) {
      const hay = [e.title, e.altTitle, e.author, e.artist, e.notes, ...(e.tags || []), ...(e.customTags || [])]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// "BL", "Yaoi", "Manhwa", "Webtoon(s)" and "Favorite(s)" are redundant or
// migrated-away-from tags — redundant because the whole app is BL/yaoi
// manhwa/webtoons already, and "Favorite" because it's now the entry.favorite
// flag instead of a plain tag (see the one-time migration in boot()). They're
// blocked from ever being (re-)created and hidden from every tag display —
// cloud, homepage dropdown, database table — without needing to touch
// already-stored data (though the favorite migration does clean that up too).
const HIDDEN_TAG_KEYS = new Set(['bl', 'yaoi', 'manhwa', 'webtoon', 'webtoons', 'favorite', 'favorites'].map((t) => t.toLowerCase()));
// Tags the user has explicitly deleted via the Tag Manager. Persisted in
// IndexedDB (and synced via Firestore) so a deleted tag can't resurface from
// a future HD-drive scan, cross-reference pull, or other import.
let DELETED_TAG_KEYS = new Set();
function isHiddenTag(t) {
  const norm = normalizeTagKey(t);
  return HIDDEN_TAG_KEYS.has(norm) || DELETED_TAG_KEYS.has(norm);
}
// Strips blocked/deleted tag names out of a list of incoming tags (from a
// cross-reference pull, suggested match, etc.) before merging them into an
// entry, so they're never (re-)imported in the first place.
function sanitizeIncomingTags(tags) {
  return (tags || []).filter((t) => !isHiddenTag(t));
}
async function recordDeletedTag(name) {
  DELETED_TAG_KEYS.add(normalizeTagKey(name));
  const arr = Array.from(DELETED_TAG_KEYS);
  await idbPut(STORE_META, { key: 'deletedTagKeys', value: arr });
  pushMetaField('deletedTagKeys', arr);
}

// One-time cleanup, run once per device (idempotent either way): strips the
// now-blocked "Favorite"/"BL"/"Yaoi"/"Manhwa"/"Webtoon(s)" tags out of every
// entry's stored tags, and for "Favorite" specifically, carries that meaning
// over into the real entry.favorite flag first so nothing is lost.
async function runFavoriteTagMigrationOnce() {
  try {
    const done = await idbGet(STORE_META, 'favoriteTagMigrationDone');
    if (done && done.value) return;
    let touched = 0;
    for (const e of ALL_ENTRIES) {
      let changed = false;
      const wasFavoriteTagged = [...(e.tags || []), ...(e.customTags || [])].some((t) => normalizeTagKey(t) === 'favorite' || normalizeTagKey(t) === 'favorites');
      if (wasFavoriteTagged && !e.favorite) { e.favorite = true; changed = true; }
      const stripBlocked = (list) => (list || []).filter((t) => !HIDDEN_TAG_KEYS.has(normalizeTagKey(t)));
      const newTags = stripBlocked(e.tags);
      const newCustom = stripBlocked(e.customTags);
      if (newTags.length !== (e.tags || []).length) { e.tags = newTags; changed = true; }
      if (newCustom.length !== (e.customTags || []).length) { e.customTags = newCustom; changed = true; }
      if (changed) { await saveEntry(e); touched++; }
    }
    await idbPut(STORE_META, { key: 'favoriteTagMigrationDone', value: true });
    if (touched) console.log(`Favorite/blocked-tag migration: updated ${touched} entries.`);
  } catch (err) {
    console.error('Favorite tag migration failed:', err);
  }
}

// "On HD" is the tag the HD-match tool (and the HD-scan import) uses to mark
// a title as physically saved on the Yaoi Drive. Matched case/spacing-agnostic
// via normalizeTagKey so a rename like "on hd" or "On-HD" still counts.
const ON_DRIVE_TAG_KEY = 'onhd';
function isOnDrive(e) {
  return [...(e.tags || []), ...(e.customTags || [])].some((t) => normalizeTagKey(t) === ON_DRIVE_TAG_KEY);
}

function topTags(entries) {
  const counts = {};
  entries.forEach((e) => (e.tags || []).concat(e.customTags || []).forEach((t) => {
    const v = String(t || '').trim();
    if (!v || v.toLowerCase() === 'nan' || v.toLowerCase() === 'none' || isHiddenTag(v)) return;
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
        ${(STATE.showFavoritesOnly || STATE.showOnDriveOnly) ? `<div class="cover-format-badge">${e.format === 'reading' ? '📖' : '📺'}</div>` : ''}
        ${flagColor ? `<div class="cover-flag-dot"><span style="color:${flagColor}">&#9873;</span></div>` : ''}
      </div>
      <div class="cover-title">${escapeHtml(e.title)}</div>
      ${e.author ? `<div class="cover-sub">${escapeHtml(formatNames(e.author))}</div>` : ''}
    </div>`;
}

// Wraps a horizontal-scroll row with left/right arrow buttons so it can be
// navigated by click as well as by touch/swipe.
function scrollRow(rowId, innerHtml) {
  return `
    <div class="scroll-row-wrap">
      <button class="scroll-arrow left" data-scroll-target="${rowId}" data-dir="-1" aria-label="Scroll left">‹</button>
      <div class="cover-row-scroll" id="${rowId}">${innerHtml}</div>
      <button class="scroll-arrow right" data-scroll-target="${rowId}" data-dir="1" aria-label="Scroll right">›</button>
    </div>`;
}

function renderHome() {
  const entries = filteredEntries();
  const tags = topTags(ALL_ENTRIES.filter((e) => e.format === STATE.format));

  let body = '';
  if (STATE.shelf === 'ALL' && !STATE.tagFilters.length && !STATE.search && !STATE.showFavoritesOnly && !STATE.showOnDriveOnly && !STATE.smutFilter && !STATE.qualityFilter && !STATE.flagFilter) {
    // Suggested-matches row sits above the shelf rows, same section-title +
    // horizontal-scroll treatment, so unconfirmed matches are easy to spot
    // and jump into without leaving the homepage.
    const suggestedGroup = entries.filter((e) => e.suggestedMatch);
    if (suggestedGroup.length > 0) {
      body += `<div class="section-title">🔎 Suggested Matches <span style="opacity:.6">(${suggestedGroup.length})</span></div>`;
      body += scrollRow('row-suggested', suggestedGroup.map(renderCoverCard).join(''));
    }
    // grouped by shelf, each group scrolls horizontally so hundreds of entries
    // don't turn into an endless vertical scroll.
    const shelvesToShow = STATE.format === 'reading' ? SHELVES_READING : ['Completed'];
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      const rowId = 'row-' + shelf.replace(/[^a-z0-9]+/gi, '-');
      body += `<div class="section-title">${escapeHtml(shelf)} <span style="opacity:.6">(${group.length})</span></div>`;
      body += scrollRow(rowId, group.map(renderCoverCard).join(''));
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

  const tagMsPanel = tags.map((t) => `
    <label class="tag-ms-item"><input type="checkbox" data-tag-ms-item="${escapeHtml(t)}" ${STATE.tagFilters.includes(t) ? 'checked' : ''}><span>${escapeHtml(t)}</span></label>
  `).join('');
  const tagMultiselect = `
    <div class="tag-multiselect">
      <button class="tag-ms-toggle" data-tag-ms-toggle="1">🏷️ Tags${STATE.tagFilters.length ? ` (${STATE.tagFilters.length})` : ''} <span class="chevron">${TAG_FILTER_OPEN ? '▴' : '▾'}</span></button>
      <div class="tag-ms-panel ${TAG_FILTER_OPEN ? 'open' : ''}" id="tag-ms-panel">
        ${tagMsPanel || '<div style="color:var(--text-dim);font-size:12px;padding:4px;">No tags yet.</div>'}
        ${STATE.tagFilters.length ? `<button class="ref-btn" style="width:100%;margin-top:6px;" data-tag-ms-clear="1">Clear selected</button>` : ''}
      </div>
    </div>`;

  const smutChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.smutFilter && n <= STATE.smutFilter ? 'active' : ''}" data-smut-filter="${n}" title="${n}+ eggplants">🍆</span>`).join('');
  const qualityChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.qualityFilter && n <= STATE.qualityFilter ? 'active' : ''}" data-quality-filter="${n}" title="${n}+ hearts">❤️</span>`).join('');
  const flagChips = FLAG_COLORS.map((c) => `<span class="rating-pick-icon flag-filter-icon ${STATE.flagFilter === c ? 'active' : ''}" data-flag-filter="${c}" style="color:${FLAG_HEX[c]}" title="${c} flag">&#9873;</span>`).join('');

  return `
    <div class="app-header">
      <div class="brand-row">
        <h1><span class="egg">🍆</span>Yaoi Journal</h1>
        <button class="icon-btn" data-open-settings="1">⚙️</button>
      </div>
      <button class="filters-toggle-btn" data-toggle-filters="1">${FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters'}</button>
      <div class="filters-collapsible ${FILTERS_COLLAPSED ? 'collapsed' : ''}" id="filters-collapsible">
        <div class="search-bar">
          <span>🔍</span>
          <input type="search" id="search-input" placeholder="Search all reads &amp; anime..." value="${escapeHtml(STATE.search)}">
        </div>
        <div class="format-row">
          <div class="format-btn ${STATE.format === 'reading' ? 'active' : ''}" data-format="reading">📖 Reading (Manhwa/Manga)</div>
          <div class="format-btn ${STATE.format === 'watching' ? 'active' : ''}" data-format="watching">📺 Watching (Anime)</div>
        </div>
        ${shelfChips ? `<div class="filter-section-label">Status</div><div class="shelf-row">${shelfChips}</div>` : ''}
        <div class="filter-section-label">Tags</div>
        ${tagMultiselect}
        <div class="filter-section-label">Ratings &amp; Flags</div>
        <div class="rating-pick-row">${smutChips}<span class="rating-pick-divider"></span>${qualityChips}<span class="rating-pick-divider"></span>${flagChips}</div>
      </div>
    </div>
    <main>${body}</main>
    <button class="fab" data-add-entry="1">+</button>
    ${renderBottomNav(STATE.showFavoritesOnly ? 'favorites' : (STATE.showOnDriveOnly ? 'onDrive' : 'home'))}
  `;
}

function renderBottomNav(active) {
  return `
    <div class="bottom-nav">
      <button data-nav="home" class="${active === 'home' ? 'active' : ''}"><span class="icon">🏠</span>Journal</button>
      <button data-nav-filter="favorites" class="${active === 'favorites' ? 'active' : ''}"><span class="icon">💜</span>Favorites</button>
      <button data-nav-filter="onDrive" class="${active === 'onDrive' ? 'active' : ''}"><span class="icon">💾</span>On HD</button>
      <button data-nav="tags" class="${active === 'tags' ? 'active' : ''}"><span class="icon">🏷️</span>Tags</button>
      <button data-nav="reactions" class="${active === 'reactions' ? 'active' : ''}"><span class="icon">🎭</span>Reactions</button>
      <button data-nav="database" class="${active === 'database' ? 'active' : ''}"><span class="icon">🗂️</span>Database</button>
    </div>`;
}

/* ---------------------------------------------------------------------- */
/* TAG MANAGEMENT VIEW                                                    */
/* ---------------------------------------------------------------------- */

function allTagCounts() {
  const counts = {};
  ALL_ENTRIES.forEach((e) => (e.tags || []).concat(e.customTags || []).forEach((t) => {
    const v = String(t || '').trim();
    if (!v || v.toLowerCase() === 'nan' || v.toLowerCase() === 'none') return;
    counts[v] = (counts[v] || 0) + 1;
  }));
  return counts;
}

// Collapse a tag name down to just its letters/digits so "Crazy Bottom",
// "crazy-bottom" and "CrazyBottom" all compare equal — used to catch subtle
// near-duplicate tags as the user types a new one.
function normalizeTagKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Finds existing tags that look like they might be the same concept as
// `query` — substring matches (either direction) plus a small edit-distance
// tolerance for typos/spacing/casing differences. Exact matches (already
// caught by the "already exists" check in the Add handler) are excluded.
function findSimilarTags(query) {
  const q = normalizeTagKey(query);
  if (!q || q.length < 2) return [];
  const names = Object.keys(allTagCounts());
  const results = [];
  for (const name of names) {
    const norm = normalizeTagKey(name);
    if (!norm || norm === q) continue;
    let match = norm.includes(q) || q.includes(norm);
    if (!match) {
      const dist = levenshteinDistance(norm, q);
      if (dist <= 2 && Math.max(norm.length, q.length) >= 4) match = true;
    }
    if (match) results.push(name);
  }
  return results.slice(0, 6);
}

function renderTagManager() {
  const counts = allTagCounts();
  const names = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  const rows = names.map((t) => `
    <div class="tagmgr-row" data-tag-name="${escapeHtml(t)}">
      <div class="tagmgr-click-area" data-tagmgr-view="${escapeHtml(t)}" title="View entries tagged &quot;${escapeHtml(t)}&quot;">
        <div class="tagmgr-name">${escapeHtml(t)}${isHiddenTag(t) ? ' <span style="color:var(--text-dim);font-size:10.5px;">(hidden from filters)</span>' : ''}</div>
        <div class="tagmgr-count">${counts[t]} entr${counts[t] === 1 ? 'y' : 'ies'}</div>
      </div>
      <div class="tagmgr-actions">
        <button class="icon-btn-inline" data-tagmgr-rename="${escapeHtml(t)}" title="Rename this tag everywhere">✏️</button>
        <button class="icon-btn-inline" data-tagmgr-delete="${escapeHtml(t)}" title="Delete this tag everywhere">🗑️</button>
      </div>
    </div>`).join('');

  return `
    <div class="app-header">
      <div class="brand-row"><h1>🏷️ Manage Tags</h1></div>
      <div class="search-bar"><span>🔍</span><input type="search" id="tagmgr-search" placeholder="Filter tags..."></div>
    </div>
    <main>
      <div class="account-panel">
        <div class="account-info">
          <div class="account-label">Synced account</div>
          <div class="account-email">${escapeHtml(CURRENT_USER ? CURRENT_USER.email : '')}</div>
        </div>
        <button class="icon-btn-inline" data-sign-out="1" title="Sign out">Sign Out</button>
      </div>
      <button class="ref-btn" style="width:100%;margin-bottom:12px;" data-nav="hdMatch">💾 Match Owned Titles from a List</button>
      <div style="color:var(--text-dim);font-size:12px;margin-bottom:10px;">
        ${names.length} unique tag${names.length === 1 ? '' : 's'} across ${ALL_ENTRIES.length} entries. Tap a tag to see its entries. Renaming applies everywhere the tag is used — rename to an existing tag name to merge two tags together. Deleting removes it from every entry (can't be undone).
      </div>
      <div id="tagmgr-list">${rows || '<div class="empty-state">No tags yet.</div>'}</div>
    </main>
    ${renderBottomNav('tags')}
  `;
}

function renderTagEntries() {
  const t = TAG_ENTRIES_FILTER;
  const entries = t ? ALL_ENTRIES.filter((e) => (e.tags || []).concat(e.customTags || []).includes(t)) : [];
  const body = entries.length
    ? `<div class="cover-grid">${entries.map(renderCoverCard).join('')}</div>`
    : `<div class="empty-state">No entries have this tag.</div>`;
  return `
    <div class="app-header">
      <div class="brand-row">
        <button class="back-btn" data-nav="tags">← Back</button>
        <h1>🏷️ ${escapeHtml(t || '')}</h1>
      </div>
      <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} tagged "${escapeHtml(t || '')}"</div>
    </div>
    <main>${body}</main>
    ${renderBottomNav('tags')}
  `;
}

/* ---------------------------------------------------------------------- */
/* MATCH OWNED TITLES FROM A LIST (e.g. folder/file names off a hard      */
/* drive) — paste raw names, get them fuzzy-matched to journal entries,   */
/* and confidently-matched ones auto-tagged. Reusable any time the drive  */
/* gets new downloads.                                                    */
/* ---------------------------------------------------------------------- */

let HD_MATCH_STATE = { raw: '', tagName: 'On HD', results: null };

// Strips the noise that owned-file/folder names tend to carry (uploader
// credits, WIP/status flags, chapter/volume numbers, parentheticals) down
// to (hopefully) just the title, so it can be compared against a journal
// entry's title/alt title.
function cleanCandidateTitle(raw) {
  let s = String(raw || '');
  s = s.replace(/\.(pdf|zip|cbz|cbr|epub|jpg|png)$/i, '');
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\s+by\s+.+$/i, '');
  const noiseRe = /\s*[-–—:]?\s*(w\.?i\.?p\.?|uncensored|complete(d)?|incomplete|discontinued|ongoing|not in eng|idk|ch\.?\s*\d+(\.\d+)?|chapter\s*\d+(\.\d+)?|vol\.?\s*\d+|s\d+|season\s*\d+|dj|\d{4})\s*$/i;
  let prev;
  do { prev = s; s = s.replace(noiseRe, ''); } while (s !== prev && s.trim());
  s = s.replace(/^[\s\-–—:.,]+|[\s\-–—:.,]+$/g, '');
  return s.trim();
}

// Some names bundle several alt names together ("Title A : Title B : 제목").
// Try each chunk as its own candidate.
function splitAltSegments(s) {
  return String(s || '').split(/\s*[:|/]\s*/).map((x) => x.trim()).filter(Boolean);
}

function candidateKeysForRaw(raw) {
  const cleaned = cleanCandidateTitle(raw);
  const segs = splitAltSegments(cleaned);
  const all = [cleaned, ...segs].filter(Boolean);
  return Array.from(new Set(all.map((s) => normalizeTagKey(s)).filter((k) => k.length >= 3)));
}

function entryTitleKeys(e) {
  const names = [e.title, ...String(e.altTitle || '').split(/\s*\/\s*/)].filter(Boolean);
  const expanded = [];
  names.forEach((n) => { expanded.push(n); splitAltSegments(n).forEach((x) => expanded.push(x)); });
  return Array.from(new Set(expanded.map((s) => normalizeTagKey(s)).filter((k) => k.length >= 3)));
}

// Runs every pasted line against every journal entry's title/alt-title keys.
// Exact (post-cleanup, post-normalization) matches are "confident" — safe to
// auto-tag. Everything else that at least shares a meaningful substring is
// "uncertain" and left for a manual tap-to-confirm; anything with no overlap
// at all is "unmatched".
// Normalizes a raw HD-scan line for the "already handled" registry — just
// enough to recognize the exact same line pasted again, without collapsing
// distinct lines (e.g. different volumes) into each other the way
// normalizeTagKey's alphanumeric-only stripping would.
function rawLineKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function markHdRawResolved(raws) {
  raws.forEach((r) => HD_RESOLVED_RAW.add(rawLineKey(r)));
  const arr = Array.from(HD_RESOLVED_RAW);
  await idbPut(STORE_META, { key: 'hdResolvedRaw', value: arr });
  pushMetaField('hdResolvedRaw', arr);
}

function findHdMatches(rawText) {
  const allLines = String(rawText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = allLines.filter((l) => !HD_RESOLVED_RAW.has(rawLineKey(l)));
  const alreadyResolvedCount = allLines.length - lines.length;
  const entryKeyMap = new Map();
  ALL_ENTRIES.forEach((e) => {
    entryTitleKeys(e).forEach((k) => {
      if (!entryKeyMap.has(k)) entryKeyMap.set(k, []);
      if (!entryKeyMap.get(k).some((x) => x.id === e.id)) entryKeyMap.get(k).push(e);
    });
  });

  const confidentMap = new Map();
  const uncertain = [];
  const unmatched = [];

  lines.forEach((raw) => {
    const keys = candidateKeysForRaw(raw);
    if (!keys.length) { unmatched.push(raw); return; }
    let exactEntries = [];
    keys.forEach((k) => { if (entryKeyMap.has(k)) exactEntries.push(...entryKeyMap.get(k)); });
    exactEntries = Array.from(new Set(exactEntries));
    if (exactEntries.length) {
      exactEntries.forEach((e) => {
        if (!confidentMap.has(e.id)) confidentMap.set(e.id, { entry: e, matchedRaw: [] });
        confidentMap.get(e.id).matchedRaw.push(raw);
      });
      return;
    }
    let possible = [];
    for (const [k, entries] of entryKeyMap) {
      for (const primaryKey of keys) {
        if (primaryKey.length >= 5 && k.length >= 5 && (k.includes(primaryKey) || primaryKey.includes(k))) {
          possible.push(...entries);
          break;
        }
      }
    }
    possible = Array.from(new Set(possible)).slice(0, 3);
    if (possible.length) uncertain.push({ raw, candidates: possible, confirmed: false });
    else unmatched.push(raw);
  });

  return { confident: Array.from(confidentMap.values()), uncertain, unmatched, alreadyResolvedCount };
}

function renderHdMatch() {
  const r = HD_MATCH_STATE.results;
  let resultsHtml = '';
  if (r) {
    resultsHtml = `
      ${r.alreadyResolvedCount ? `<div style="color:var(--text-dim);font-size:11.5px;padding:0 2px 8px;">✅ ${r.alreadyResolvedCount} line${r.alreadyResolvedCount === 1 ? '' : 's'} already handled from a previous run — skipped so you're not re-deciding the same titles.</div>` : ''}
      <div class="panel">
        <div class="panel-title">✅ Will tag ${r.confident.length} entr${r.confident.length === 1 ? 'y' : 'ies'}</div>
        ${r.confident.length ? `
          <div style="max-height:220px;overflow-y:auto;font-size:12.5px;color:var(--text-dim);margin-bottom:8px;">
            ${r.confident.map((c) => `<div>${escapeHtml(c.entry.title)}</div>`).join('')}
          </div>
          <button class="btn-primary" data-hdmatch-apply="1">Apply "${escapeHtml(HD_MATCH_STATE.tagName)}" tag to these</button>
        ` : `<div style="color:var(--text-dim);font-size:12px;">No exact matches found.</div>`}
      </div>
      <div class="panel">
        <div class="panel-title">🤔 Possible matches (${r.uncertain.length}) — tap to confirm</div>
        ${r.uncertain.length ? r.uncertain.map((u, i) => `
          <div class="tagmgr-row" style="flex-direction:column;align-items:stretch;gap:6px;">
            <div style="font-size:12.5px;color:var(--text);">"${escapeHtml(u.raw)}"</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${u.confirmed
                ? `<span style="font-size:11.5px;color:var(--yellow);">✓ Tagged as ${escapeHtml(u.confirmed)}</span>`
                : u.candidates.map((c) => `<button class="ref-btn" data-hdmatch-confirm="${i}:${c.id}">${escapeHtml(c.title)}</button>`).join('') + `<button class="btn-ghost" data-hdmatch-skip="${i}">Not a match</button>`}
            </div>
          </div>
        `).join('') : `<div style="color:var(--text-dim);font-size:12px;">Nothing in between — every line was either an exact match or no match.</div>`}
      </div>
      <div class="panel">
        <div class="panel-title">❓ No match found (${r.unmatched.length})</div>
        <div style="color:var(--text-dim);font-size:11.5px;margin-bottom:6px;">Not in your journal yet, or too different to recognize automatically. Tap ✕ to permanently ignore junk lines (like stray numbers) so they stop showing up here.</div>
        <div style="max-height:220px;overflow-y:auto;">
          ${r.unmatched.map((u, i) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--text-dim);padding:3px 0;"><span>${escapeHtml(u)}</span><button class="icon-btn-inline" data-hdmatch-skip-unmatched="${i}" title="Ignore this line permanently">✕</button></div>`).join('') || '<div>—</div>'}
        </div>
      </div>
    `;
  }
  return `
    <div class="app-header">
      <div class="brand-row">
        <button class="back-btn" data-nav="tags">← Back</button>
        <h1>💾 Match Owned Titles</h1>
      </div>
    </div>
    <main>
      <div class="panel">
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">
          Paste folder or file names from your hard drive below (one per line). Exact matches get auto-tagged; anything fuzzy gets a tap-to-confirm option instead.
        </div>
        <div class="field-row"><label>Tag to apply</label><input type="text" id="hdmatch-tagname" value="${escapeHtml(HD_MATCH_STATE.tagName)}"></div>
        <div class="field-row"><label>Names (one per line)</label><textarea id="hdmatch-raw" rows="8" placeholder="Paste folder/file names here...">${escapeHtml(HD_MATCH_STATE.raw)}</textarea></div>
        <button class="btn-primary" data-hdmatch-find="1">Find Matches</button>
      </div>
      ${resultsHtml}
    </main>
    ${renderBottomNav('tags')}
  `;
}

/* ---------------------------------------------------------------------- */
/* REACTIONS / MEME LIBRARY                                               */
/* A standalone library of uploaded meme/reaction images, reusable across */
/* any journal entry via the "Add from Reactions" picker on the detail    */
/* page's Images section. Duplicate uploads (by image hash) get flagged.  */
/* ---------------------------------------------------------------------- */

function renderReactionsLibrary() {
  const items = ALL_REACTIONS.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const grid = items.length
    ? `<div class="cover-grid">${items.map((r) => `
        <div class="reaction-thumb">
          <img src="${r.dataUrl}" alt="">
          <button class="del" data-del-reaction="${r.id}">✕</button>
        </div>`).join('')}</div>`
    : `<div class="empty-state">No reactions/memes saved yet. Tap "Add" to upload some.</div>`;
  return `
    <div class="app-header">
      <div class="brand-row"><h1>🎭 Reactions Library</h1></div>
      <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">${items.length} saved. Use these on any read's Images section.</div>
      <label class="upload-btn">📎 Add reaction(s)/meme(s)<input type="file" accept="image/*" multiple id="reaction-upload-input"></label>
    </div>
    <main>${grid}</main>
    ${renderBottomNav('reactions')}
  `;
}

// Shared by the library's own upload button and the detail-page "Add from
// Reactions" picker's own file input (a picker can also add brand-new images
// straight into the library while attaching them to an entry).
async function addReactionFiles(fileList) {
  const added = [];
  for (const file of fileList) {
    const dataUrl = await fileToCompressedDataUrl(file, 800);
    const hash = await hashDataUrl(dataUrl);
    const dupe = findReactionByHash(hash);
    if (dupe) {
      if (!confirm('This looks like a duplicate of a reaction/meme you already saved. Add it again anyway?')) continue;
    }
    const reaction = { id: uid('reaction'), dataUrl, hash, createdAt: new Date().toISOString() };
    await saveReaction(reaction);
    added.push(reaction);
  }
  return added;
}

function openReactionPickerModal(entryId) {
  const items = ALL_REACTIONS.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  openModal(`
    <h3>🎭 Add from Reactions</h3>
    <p style="font-size:12px;color:var(--text-dim);">Tap to select, then Add. Or upload a brand-new one straight into this entry.</p>
    <label class="upload-btn" style="margin-bottom:10px;">📎 Upload new<input type="file" accept="image/*" multiple id="reaction-picker-upload"></label>
    <div class="reaction-picker-grid" id="reaction-picker-grid">
      ${items.length ? items.map((r) => `<div class="reaction-thumb pickable" data-pick-reaction="${r.id}"><img src="${r.dataUrl}" alt=""></div>`).join('') : '<div class="empty-state">No reactions saved yet — upload one above.</div>'}
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
      <button class="btn-primary" data-add-picked-reactions="${entryId}">Add Selected</button>
    </div>
  `);
  const grid = document.getElementById('reaction-picker-grid');
  const selected = new Set();
  if (grid) {
    grid.querySelectorAll('[data-pick-reaction]').forEach((el) => {
      el.onclick = () => {
        const id = el.getAttribute('data-pick-reaction');
        if (selected.has(id)) { selected.delete(id); el.classList.remove('selected'); }
        else { selected.add(id); el.classList.add('selected'); }
      };
    });
  }
  const uploadInput = document.getElementById('reaction-picker-upload');
  if (uploadInput) uploadInput.onchange = async () => {
    if (!uploadInput.files.length) return;
    const added = await addReactionFiles(uploadInput.files);
    added.forEach((r) => selected.add(r.id));
    openReactionPickerModal(entryId); // re-render with the new uploads visible
    added.forEach((r) => {
      const el = document.querySelector(`[data-pick-reaction="${r.id}"]`);
      if (el) el.classList.add('selected');
    });
  };
  const addBtn = document.querySelector('[data-add-picked-reactions]');
  if (addBtn) addBtn.onclick = async () => {
    const e = getEntry(entryId);
    e.screencaps = e.screencaps || [];
    selected.forEach((id) => {
      const r = ALL_REACTIONS.find((x) => x.id === id);
      if (r) e.screencaps.push(r.dataUrl);
    });
    await saveEntry(e);
    closeModal();
    showToast(`Added ${selected.size} image${selected.size === 1 ? '' : 's'}`);
    render();
  };
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

// Yaoi/BL titles are notorious for having several names (English, romanized,
// native-script) floating around. When a reference-platform match gives us a
// different (usually more "official") title, keep every prior name around by
// folding them into Alt Title instead of just discarding them.
function applyTitleSwap(e, sm) {
  if (sm.title && sm.title.trim() && sm.title.trim() !== e.title) {
    const parts = [e.altTitle, e.title, sm.altTitle].map((t) => (t || '').trim()).filter(Boolean);
    e.altTitle = Array.from(new Set(parts)).join(' / ');
    e.title = sm.title.trim();
  } else if (sm.altTitle && !e.altTitle) {
    e.altTitle = sm.altTitle;
  }
}

// Pending (unsaved) tag edits for whichever entry is currently open. Clicking a
// tag just toggles it here; nothing is written to the entry until Save Tags.
let TAG_EDIT_STATE = { entryId: null, removed: new Set(), added: [] };
function getTagEditState(entryId) {
  if (TAG_EDIT_STATE.entryId !== entryId) {
    TAG_EDIT_STATE = { entryId, removed: new Set(), added: [] };
  }
  return TAG_EDIT_STATE;
}

function renderTagCloud(e) {
  const ts = getTagEditState(e.id);
  const existing = (e.tags || []).filter((t) => !isHiddenTag(t)).map((t) => ({ t, custom: false }))
    .concat((e.customTags || []).filter((t) => !isHiddenTag(t)).map((t) => ({ t, custom: true })));
  const existingChips = existing.map(({ t, custom }) => {
    const removed = ts.removed.has(t);
    return `<div class="tag-chip ${custom ? 'custom' : ''} ${removed ? 'tag-removed' : ''}" data-toggle-tag="${escapeHtml(t)}" title="Tap to ${removed ? 'keep' : 'remove'}">${escapeHtml(t)}</div>`;
  });
  const addedChips = ts.added.map((t) => `<div class="tag-chip custom" data-toggle-added="${escapeHtml(t)}" title="Tap to undo">${escapeHtml(t)} ✕</div>`);
  return existingChips.concat(addedChips).join('') || '<span style="color:var(--text-dim);font-size:12.5px;">No tags yet.</span>';
}

// Plain, non-interactive tag display shown when the Tags panel isn't in edit mode.
function renderTagCloudReadOnly(e) {
  const all = (e.tags || []).filter((t) => !isHiddenTag(t)).map((t) => ({ t, custom: false }))
    .concat((e.customTags || []).filter((t) => !isHiddenTag(t)).map((t) => ({ t, custom: true })));
  if (!all.length) return '<span style="color:var(--text-dim);font-size:12.5px;">No tags yet.</span>';
  return all.map(({ t, custom }) => `<div class="tag-chip readonly ${custom ? 'custom' : ''}">${escapeHtml(t)}</div>`).join('');
}

function renderDetail(e) {
  if (!e) return `<div class="empty-state">Entry not found.</div>${renderBottomNav('home')}`;
  const isReading = e.format === 'reading';

  // Unconfirmed matching workflow (suggested-match preview, or the plain
  // "not linked yet" cross-reference prompt) lives with the cover image.
  // Once a match is confirmed, that same information becomes the Summary
  // block and moves into the head/details column instead.
  let matchColumnHtml = '';
  let confirmedSummaryHtml = '';
  if (e.referenceUrl && e.referenceStatus === 'confirmed') {
    confirmedSummaryHtml = `
      <div class="field-row" style="margin-top:12px;">
        <label>Summary</label>
        <div class="summary-text">${escapeHtml(e.summaryCache) || '<em>No summary cached — tap refresh.</em>'}</div>
        <div class="summary-source">
          <a href="${escapeHtml(e.referenceUrl)}" target="_blank">${escapeHtml(e.referenceSite || 'source')} ↗</a>
          &nbsp;·&nbsp;
          <button class="ref-btn" data-refresh-ref="1">↻ Refresh</button>
          <button class="ref-btn" data-open-crossref="1">Change link</button>
        </div>
      </div>`;
  } else if (e.suggestedMatch) {
    const sm = e.suggestedMatch;
    matchColumnHtml = `
      <div class="match-suggest-box">
        <button class="ref-btn" style="width:100%;margin-bottom:8px;" data-generate-match="1">🔎 Generate Suggested Match</button>
        <div style="font-size:10.5px;color:var(--yellow);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">🔎 Suggested match (${escapeHtml(sm.confidence || 'unconfirmed')})${sm.site ? ' — ' + escapeHtml(sm.site) : ''}</div>
        <div class="match-preview compact">
          ${sm.coverUrl ? `<img src="${escapeHtml(sm.coverUrl)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
          <div class="info">
            <strong>${escapeHtml(sm.title || e.title)}</strong>
            ${sm.altTitle ? escapeHtml(sm.altTitle) + '<br>' : ''}
            ${sm.author ? 'By ' + escapeHtml(sm.author) + '<br>' : ''}
            <p style="margin:6px 0 0;">${escapeHtml((sm.summary || '').slice(0, 160))}${(sm.summary || '').length > 160 ? '…' : ''}</p>
          </div>
        </div>
        ${sm.notes ? `<div style="font-size:10.5px;color:var(--text-dim);margin-bottom:6px;">${escapeHtml(sm.notes)}</div>` : ''}
        <div class="modal-actions" style="margin-top:0;">
          <button class="btn-ghost" data-dismiss-suggested="1">Dismiss</button>
          <button class="btn-primary" data-use-suggested="1">✓ Use match</button>
        </div>
        ${sm.url ? `<div style="margin-top:6px;"><a href="${escapeHtml(sm.url)}" target="_blank" style="font-size:11px;">View on ${escapeHtml(sm.site || 'Anime-Planet')} ↗</a></div>` : ''}
      </div>`;
  } else {
    matchColumnHtml = `
      <div class="match-suggest-box">
        <button class="ref-btn" style="width:100%;margin-bottom:8px;" data-generate-match="1">🔎 Generate Suggested Match</button>
        <div style="color:var(--text-dim);font-size:11.5px;margin-bottom:8px;">Not linked to a reference page yet.</div>
        <button class="ref-btn" data-open-crossref="1">🔗 Cross-reference manually</button>
      </div>`;
  }

  // Display vs. edit mode for the top fields (Title, Alt Title, Novel, Author,
  // Artist, Chapters/Seasons, Status) — toggled by the pencil icon.
  let topFieldsHtml;
  if (DETAIL_EDIT_MODE) {
    topFieldsHtml = isReading ? `
      <div class="field-row"><label>Title</label><input type="text" id="edit-title" value="${escapeHtml(e.title)}"></div>
      <div class="field-row"><label>Alt title</label><input type="text" id="edit-altTitle" placeholder="Other names this goes by..." value="${escapeHtml(e.altTitle || '')}"></div>
      <div class="field-row"><label>Novel (author)</label><input type="text" id="edit-novelAuthor" placeholder="Original novel's author, if adapted" value="${escapeHtml(e.novelAuthor || '')}"></div>
      <div class="field-row"><label>Author</label><input type="text" id="edit-author" value="${escapeHtml(e.author || '')}"></div>
      <div class="field-row"><label>Artist</label><input type="text" id="edit-artist" value="${escapeHtml(e.artist || '')}"></div>
      <div class="field-row"><label>Chapters</label><input type="number" id="edit-chapters" value="${e.totalChapters || ''}"></div>
      <div class="field-row"><label>Seasons</label><input type="number" id="edit-seasons" value="${e.totalSeasons || ''}"></div>
      <div class="field-row"><label>Status</label><input type="text" id="edit-status" value="${escapeHtml(e.status || '')}"></div>
      <div class="modal-actions" style="margin-top:6px;">
        <button class="btn-ghost" data-cancel-edit="1">Cancel</button>
        <button class="btn-primary" data-save-edit="1">Save</button>
      </div>
    ` : `
      <div class="field-row"><label>Title</label><input type="text" id="edit-title" value="${escapeHtml(e.title)}"></div>
      <div class="field-row"><label>Alt title</label><input type="text" id="edit-altTitle" placeholder="Other names this goes by..." value="${escapeHtml(e.altTitle || '')}"></div>
      <div class="field-row"><label>Notes (legacy)</label><input type="text" id="edit-legacyNote" value="${escapeHtml(e.legacyNote || '')}"></div>
      <div class="modal-actions" style="margin-top:6px;">
        <button class="btn-ghost" data-cancel-edit="1">Cancel</button>
        <button class="btn-primary" data-save-edit="1">Save</button>
      </div>
    `;
  } else {
    topFieldsHtml = isReading ? `
      <div class="field-row"><label>Title</label><div class="value plain">${escapeHtml(e.title)} <button class="icon-btn-inline" data-edit-toggle="1" title="Edit details">✏️</button></div></div>
      ${e.altTitle ? `<div class="field-row"><label>Alt title</label><div class="value plain">${escapeHtml(e.altTitle)}</div></div>` : ''}
      ${(e.isNovel || e.novelAuthor) ? `<div class="field-row"><label>Novel</label><div class="value plain">${escapeHtml(formatNames(e.novelAuthor)) || '—'}</div></div>` : ''}
      <div class="field-row"><label>Author</label><div class="value plain">${escapeHtml(formatNames(e.author)) || '—'}</div></div>
      <div class="field-row"><label>Artist</label><div class="value plain">${escapeHtml(formatNames(e.artist)) || '—'}</div></div>
      ${e.totalChapters ? `<div class="field-row"><label>Chapters</label><div class="value plain">${e.totalChapters}</div></div>` : ''}
      ${e.totalSeasons ? `<div class="field-row"><label>Seasons</label><div class="value plain">${e.totalSeasons}</div></div>` : ''}
      <div class="field-row"><label>Status</label><div class="value plain">${escapeHtml(e.status) || '—'}</div></div>
    ` : `
      <div class="field-row"><label>Title</label><div class="value plain">${escapeHtml(e.title)} <button class="icon-btn-inline" data-edit-toggle="1" title="Edit details">✏️</button></div></div>
      ${e.altTitle ? `<div class="field-row"><label>Alt title</label><div class="value plain">${escapeHtml(e.altTitle)}</div></div>` : ''}
      <div class="field-row"><label>Notes (legacy)</label><div class="value plain">${escapeHtml(e.legacyNote) || '—'}</div></div>
    `;
  }

  const shelfSelect = isReading ? `
    <select class="shelf-select" data-shelf-select="1">
      ${SHELVES_READING.map((s) => `<option value="${escapeHtml(s)}" ${e.shelf === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
    </select>` : '';

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
            <div class="cover-actions-row">
              <label class="upload-btn small">📷 ${e.coverUrl ? 'Change' : 'Upload'}<input type="file" accept="image/*" style="display:none" id="cover-upload-input"></label>
              ${shelfSelect}
            </div>
          </div>
          <div>
            ${topFieldsHtml}
            ${confirmedSummaryHtml}
            ${matchColumnHtml}
          </div>
        </div>
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
            <div class="rating-icons" data-rating="qualityRating">${renderRatingIcons(e.qualityRating, '❤️')}</div>
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
        <div class="panel-title-row">
          <div class="panel-title" style="margin:0;">Tags</div>
          ${!TAG_EDIT_MODE ? `<button class="icon-btn-inline" data-tag-edit-toggle="1" title="Edit tags">✏️</button>` : ''}
        </div>
        ${TAG_EDIT_MODE ? `
          <div style="color:var(--text-dim);font-size:11px;margin-bottom:6px;">Tap a tag to mark it for removal, add new ones below, then Save.</div>
          <div class="tag-cloud">${renderTagCloud(e)}</div>
          <div class="add-tag-row">
            <input type="text" id="new-tag-input" placeholder="Add your own tag..." autocomplete="off">
            <button data-add-tag="1">Add</button>
          </div>
          <div id="tag-similar-box"></div>
          <div class="modal-actions" style="margin-top:10px;">
            <button class="btn-ghost" data-cancel-tag-edit="1">Cancel</button>
            <button class="btn-primary" data-save-tags="1">Save Tags</button>
          </div>
        ` : `
          <div class="tag-cloud">${renderTagCloudReadOnly(e)}</div>
        `}
      </div>

      <!-- 6. User notes -->
      <div class="panel">
        <div class="panel-title">Your Notes / Review</div>
        <textarea id="user-notes" placeholder="Your thoughts...">${escapeHtml(e.notes)}</textarea>
      </div>

      <!-- 7. Images (screencaps, fanart, meme reactions — all in one place) -->
      <div class="panel">
        <div class="panel-title">Images</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
          <label class="upload-btn" style="flex:1;">📎 Add photo(s)<input type="file" accept="image/*" multiple id="screencap-input"></label>
          <button class="ref-btn" style="flex:1;" data-open-reaction-picker="1">🎭 Add from Reactions</button>
        </div>
        <div class="screencap-grid">
          ${(e.screencaps || []).map((src, i) => `<div class="screencap-thumb"><img src="${src}" data-view-screencap="${i}"><button class="del" data-del-screencap="${i}">✕</button></div>`).join('')}
        </div>
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
      <td>${escapeHtml(formatNames(e.author))}</td>
      <td>${escapeHtml((e.tags || []).concat(e.customTags || []).filter((t) => !isHiddenTag(t)).join(', '))}</td>
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
          <div style="font-size:11px;color:var(--text-dim);margin:2px 0 4px;">${e.format === 'reading' ? '📖' : '📺'} ${escapeHtml(e.shelf)}${e.author ? ' · ' + escapeHtml(formatNames(e.author)) : ''}</div>
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

// Stable signature for a duplicate group (sorted entry ids) — used to
// remember "not a duplicate, keep both" decisions across visits/re-scans.
function dupGroupSignature(group) {
  return group.map((e) => e.id).sort().join('|');
}

function findDuplicateGroups() {
  const groups = {};
  ALL_ENTRIES.forEach((e) => {
    const key = duplicateKey(e.title);
    if (!key) return;
    const groupKey = e.format + '::' + key;
    (groups[groupKey] = groups[groupKey] || []).push(e);
  });
  return Object.values(groups).filter((g) => g.length > 1 && !IGNORED_DUP_GROUPS.has(dupGroupSignature(g)));
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
          <div style="font-size:11px;color:var(--text-dim);">${escapeHtml(e.shelf)}${e.author ? ' · ' + escapeHtml(formatNames(e.author)) : ''}</div>
          <div style="font-size:11px;color:var(--text-dim);">Updated ${e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : '—'}${e.favorite ? ' · 💜 favorite' : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="ref-btn" data-open-entry="${e.id}">Open</button>
          <button class="btn-ghost" data-dup-delete="${e.id}">Delete this one</button>
        </div>
      </div>`;
  }).join('');
  return `<div class="panel"><div class="panel-title">Possible duplicate</div>${items}<button class="ref-btn" style="width:100%;margin-top:8px;" data-dup-not-duplicate="${dupGroupSignature(group)}">Not duplicates — keep both, stop asking</button></div>`;
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
  const apSearchUrl = 'https://www.anime-planet.com/manga/all?name=' + encodeURIComponent(e.title);
  const mgSearchUrl = 'https://www.mangago.me/r/l_search/?name=' + encodeURIComponent(e.title);
  openModal(`
    <h3>Cross-reference "${escapeHtml(e.title)}"</h3>
    ${proxy ? '' : `<div style="background:var(--pink-soft);color:var(--pink);padding:8px 10px;border-radius:8px;font-size:12px;margin-bottom:10px;">No proxy URL set yet. Add one in Settings (⚙️) to enable live fetching — see the setup notes I gave you.</div>`}
    <p style="font-size:12.5px;color:var(--text-dim);">1. Find the title on Anime-Planet or MangaGo, then paste its page URL below.</p>
    <div style="display:flex;gap:8px;margin-bottom:10px;">
      <a class="ref-btn" href="${apSearchUrl}" target="_blank" style="flex:1;text-align:center;text-decoration:none;">🔍 Anime-Planet ↗</a>
      <a class="ref-btn" href="${mgSearchUrl}" target="_blank" style="flex:1;text-align:center;text-decoration:none;">🔍 MangaGo ↗</a>
    </div>
    <div class="field-row"><label>Anime-Planet or MangaGo URL</label><input type="text" id="crossref-url" placeholder="https://www.anime-planet.com/manga/... or https://www.mangago.me/..."></div>
    <div class="modal-actions">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
      <button class="btn-primary" data-fetch-ref="${entryId}">Preview</button>
    </div>
    <div style="border-top:1px solid var(--border);margin:12px 0;padding-top:10px;">
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 8px;">Getting a 403? Use the bookmarklet instead — it runs in your own browser on the page itself (no server, no blocking). Set it up once in Settings (⚙️), then: open the title on Anime-Planet/MangaGo → tap the bookmarklet → come back here and tap Paste.</p>
      <button class="ref-btn" style="width:100%;" data-paste-ref="${entryId}">📋 Paste from clipboard (bookmarklet)</button>
    </div>
    <div id="crossref-preview"></div>
  `);
}

// Reads whatever the cross-reference bookmarklet (see openSettingsModal) just
// copied to the clipboard and previews it exactly like a live fetch would —
// this is the free, no-server-IP-blocking path: the bookmarklet runs on the
// title's actual page, in her own browser, so it never gets a 403.
async function pasteReferenceFromClipboard(entryId) {
  const previewEl = document.getElementById('crossref-preview');
  if (!previewEl) return;
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    showToast("Couldn't read the clipboard — your browser may need permission, or paste isn't supported here");
    return;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    showToast("That doesn't look like bookmarklet data — run the bookmarklet on the title's page first");
    return;
  }
  if (!data || !data.sourceUrl) { showToast("That doesn't look like bookmarklet data"); return; }
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
  previewEl._pendingUrl = data.sourceUrl;
  showToast('Loaded from clipboard!');
}

/* ---------------------------------------------------------------------- */
/* Cross-reference bookmarklet — a small script that runs on Anime-Planet */
/* or MangaGo's own page, in the user's own browser (her own IP, no       */
/* server involved), so it's immune to the IP-based 403 blocking that     */
/* Apps Script's server hits. Written as a real function (with normal     */
/* regex literals) and turned into a "javascript:" URL via .toString() +  */
/* encodeURIComponent at render time — never hand-escaped, so nothing     */
/* about it can get mangled the way manually-escaped bookmarklets do.     */
/* ---------------------------------------------------------------------- */

function hdBookmarkletSource() {
  var Q = String.fromCharCode(34);
  var html = document.documentElement.innerHTML;
  var url = location.href;
  function dec(s) {
    if (!s) return s;
    return s.replace(/&amp;rsquo;|&rsquo;/g, String.fromCharCode(8217))
      .replace(/&amp;ldquo;|&ldquo;/g, String.fromCharCode(8220))
      .replace(/&amp;rdquo;|&rdquo;/g, String.fromCharCode(8221))
      .replace(/&amp;mdash;|&mdash;/g, String.fromCharCode(8212))
      .replace(/&amp;hellip;|&hellip;/g, String.fromCharCode(8230))
      .replace(/&amp;/g, '&').replace(/&quot;/g, Q).replace(/&#39;/g, String.fromCharCode(39))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  function meta(p) {
    var re = new RegExp('<meta[^>]+(?:property|name)=' + Q + p + Q + '[^>]+content=' + Q + '([^' + Q + ']*)' + Q, 'i');
    var m = html.match(re);
    if (m) return dec(m[1]);
    re = new RegExp('<meta[^>]+content=' + Q + '([^' + Q + ']*)' + Q + '[^>]+(?:property|name)=' + Q + p + Q, 'i');
    m = html.match(re);
    return m ? dec(m[1]) : '';
  }
  var data;
  if (url.indexOf('anime-planet.com') > -1) {
    var title = meta('og:title').replace(/\s*(Manga|Anime)?\s*\|\s*Anime-Planet$/i, '').trim();
    var alt = '';
    var am = html.match(/Alt title:\s*<\/[a-z]+>?\s*([^<\n]+)/i) || html.match(/Alt title:\s*([^\n<]+)/i);
    if (am) alt = dec(am[1]).trim();
    var tagRe = new RegExp('<a[^>]+href=' + Q + 'https://www\\.anime-planet\\.com/(?:manga|anime)/tags/[^' + Q + ']+' + Q + '[^>]*>([^<]+)</a>', 'g');
    var tags = [], tm;
    while ((tm = tagRe.exec(html)) !== null) { var tg = dec(tm[1]).trim(); if (tg && tags.indexOf(tg) === -1) tags.push(tg); }
    var author = '';
    var sm = html.match(/([A-Za-z0-9 .'-]+)\s*<\/[a-z]+>?\s*(Original Creator|Story\s*&\s*Art|Author|Artist)/i);
    if (sm) author = sm[1].trim();
    data = { site: 'Anime-Planet', sourceUrl: url, title: title, altTitle: alt, coverUrl: meta('og:image'), summary: meta('og:description'), tags: tags, author: author };
  } else if (url.indexOf('mangago.me') > -1) {
    data = { site: 'MangaGo', sourceUrl: url, title: meta('og:title'), altTitle: '', coverUrl: meta('og:image'), summary: meta('og:description'), tags: [], author: '' };
  } else {
    alert('Open an Anime-Planet or MangaGo title page first, then tap this bookmarklet.');
    return;
  }
  var text = JSON.stringify(data);
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0'; ta.style.left = '0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  alert('Copied "' + (data.title || 'this title') + '" — go back to Yaoi Journal and tap "Paste from clipboard".');
}

function bookmarkletHref() {
  return 'javascript:' + encodeURIComponent('(' + hdBookmarkletSource.toString() + ')();');
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

// Shared by the manual "Generate Suggested Match" button and the automatic
// background sweep. `kind` tells Anime-Planet whether to search its manga
// or anime catalog — MangaGo only has manga, so it's skipped for anime kind.
async function trySearchSite(proxy, title, site, kind) {
  try {
    const resp = await fetch(proxy + '?action=searchMatch&site=' + site + '&kind=' + kind + '&title=' + encodeURIComponent(title));
    const data = await resp.json();
    if (data.error) return null;
    return data;
  } catch (err) {
    return null;
  }
}

async function findSuggestedMatchData(proxy, entry) {
  const kind = entry.format === 'watching' ? 'anime' : 'manga';
  let data = await trySearchSite(proxy, entry.title, 'anime-planet', kind);
  if (!data && kind === 'manga') data = await trySearchSite(proxy, entry.title, 'mangago', kind);
  return data;
}

function dataToSuggestedMatch(data) {
  return {
    title: data.title,
    altTitle: data.altTitle,
    coverUrl: data.coverUrl,
    summary: data.summary,
    tags: data.tags,
    author: data.author,
    url: data.sourceUrl,
    site: data.site,
    confidence: data.confidence || 'auto',
  };
}

// Tries to find this entry on Anime-Planet first, then falls back to
// MangaGo (manga only), so the user doesn't have to hunt down and paste a
// URL manually.
async function generateSuggestedMatch(entryId) {
  const e = getEntry(entryId);
  const proxy = getProxyUrl();
  if (!proxy) { showToast('Set your proxy URL in Settings first'); return; }
  showToast(e.format === 'watching' ? 'Searching Anime-Planet…' : 'Searching Anime-Planet & MangaGo…');
  const data = await findSuggestedMatchData(proxy, e);
  if (!data) { showToast('No match found'); return; }
  e.suggestedMatch = dataToSuggestedMatch(data);
  await saveEntry(e);
  showToast('Suggested match found!');
  render();
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
    const merged = new Set([...(e.tags || []), ...sanitizeIncomingTags(data.tags)]);
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
    <div style="border-top:1px solid var(--border);margin-top:16px;padding-top:14px;">
      <div class="panel-title" style="margin-bottom:6px;">📋 Cross-reference bookmarklet (free 403 workaround)</div>
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 8px;">Anime-Planet and MangaGo both block Google's servers, so the proxy above can 403 even when it's set up correctly. This bookmarklet runs on the title's own page in <em>your</em> browser instead — same free, no account needed, just one extra tap per title.</p>
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 8px;"><strong>Desktop:</strong> drag this link to your bookmarks bar: <a href="${bookmarkletHref()}" class="ref-btn" style="display:inline-block;text-decoration:none;">💾 Yaoi Ref Grab</a></p>
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 8px;"><strong>Phone:</strong> bookmark any page first, then edit that bookmark and replace its URL with the code below, then save.</p>
      <textarea readonly style="width:100%;height:70px;font-size:10px;font-family:monospace;" onclick="this.select()">${escapeHtml(bookmarkletHref())}</textarea>
      <p style="font-size:11px;color:var(--text-dim);margin:8px 0 0;">To use it: open the title on Anime-Planet or MangaGo → tap the bookmarklet → it copies the info → come back here, open the entry, tap Cross-reference → Paste from clipboard. Site redesigns can occasionally break the scraping — if a field comes back blank, just fill it in by hand.</p>
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
    format: STATE.format, title, altTitle: '', novelAuthor: '', author, artist: '', isNovel: false,
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

  const signOutBtn = root.querySelector('[data-sign-out]');
  if (signOutBtn) signOutBtn.onclick = () => {
    if (confirm('Sign out of this account on this device?')) signOutOfAccount();
  };

  root.querySelectorAll('[data-open-entry]').forEach((el) => {
    el.onclick = () => navigate('detail', el.getAttribute('data-open-entry'));
  });
  root.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      const view = el.getAttribute('data-nav');
      if (view === 'home') { STATE.showFavoritesOnly = false; STATE.showOnDriveOnly = false; }
      navigate(view);
    };
  });
  root.querySelectorAll('[data-nav-filter]').forEach((el) => {
    el.onclick = () => {
      const which = el.getAttribute('data-nav-filter');
      STATE.showFavoritesOnly = which === 'favorites';
      STATE.showOnDriveOnly = which === 'onDrive';
      navigate('home');
    };
  });
  const searchInput = root.querySelector('#search-input');
  if (searchInput) {
    searchInput.oninput = (ev) => { STATE.search = ev.target.value; renderHomeInPlace(); };
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
  root.querySelectorAll('[data-format]').forEach((el) => {
    el.onclick = () => { STATE.format = el.getAttribute('data-format'); STATE.shelf = 'ALL'; STATE.tagFilters = []; STATE.smutFilter = null; STATE.qualityFilter = null; STATE.flagFilter = null; render(); };
  });
  root.querySelectorAll('[data-shelf]').forEach((el) => {
    el.onclick = () => { STATE.shelf = el.getAttribute('data-shelf'); render(); };
  });
  const tagMsToggle = root.querySelector('[data-tag-ms-toggle]');
  if (tagMsToggle) tagMsToggle.onclick = () => { TAG_FILTER_OPEN = !TAG_FILTER_OPEN; render(); };
  root.querySelectorAll('[data-tag-ms-item]').forEach((el) => {
    el.onchange = () => {
      const t = el.getAttribute('data-tag-ms-item');
      if (el.checked) {
        if (!STATE.tagFilters.includes(t)) STATE.tagFilters.push(t);
      } else {
        STATE.tagFilters = STATE.tagFilters.filter((x) => x !== t);
      }
      render();
    };
  });
  const tagMsClear = root.querySelector('[data-tag-ms-clear]');
  if (tagMsClear) tagMsClear.onclick = () => { STATE.tagFilters = []; render(); };
  const filtersToggleBtn = root.querySelector('[data-toggle-filters]');
  if (filtersToggleBtn) filtersToggleBtn.onclick = () => {
    FILTERS_COLLAPSED = !FILTERS_COLLAPSED;
    const filtersEl = document.getElementById('filters-collapsible');
    if (filtersEl) filtersEl.classList.toggle('collapsed', FILTERS_COLLAPSED);
    filtersToggleBtn.textContent = FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters';
  };
  root.querySelectorAll('[data-scroll-target]').forEach((btn) => {
    btn.onclick = () => {
      const target = document.getElementById(btn.getAttribute('data-scroll-target'));
      if (!target) return;
      target.scrollBy({ left: Number(btn.getAttribute('data-dir')) * 300, behavior: 'smooth' });
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
  root.querySelectorAll('[data-flag-filter]').forEach((el) => {
    el.onclick = () => {
      const c = el.getAttribute('data-flag-filter');
      STATE.flagFilter = STATE.flagFilter === c ? null : c;
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
  const shelfSelectEl = root.querySelector('[data-shelf-select]');
  if (shelfSelectEl) shelfSelectEl.onchange = async () => {
    const e = getEntry(STATE.entryId);
    e.shelf = shelfSelectEl.value;
    await saveEntry(e);
    showToast('Shelf updated');
    render();
  };
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
  const editToggleBtn = root.querySelector('[data-edit-toggle]');
  if (editToggleBtn) editToggleBtn.onclick = () => { DETAIL_EDIT_MODE = true; render(); };
  const cancelEditBtn = root.querySelector('[data-cancel-edit]');
  if (cancelEditBtn) cancelEditBtn.onclick = () => { DETAIL_EDIT_MODE = false; render(); };
  const saveEditBtn = root.querySelector('[data-save-edit]');
  if (saveEditBtn) saveEditBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    const grab = (id) => document.getElementById(id);
    if (grab('edit-title')) e.title = grab('edit-title').value.trim() || e.title;
    if (grab('edit-altTitle')) e.altTitle = grab('edit-altTitle').value.trim();
    if (grab('edit-novelAuthor')) e.novelAuthor = grab('edit-novelAuthor').value.trim();
    if (grab('edit-author')) e.author = grab('edit-author').value.trim();
    if (grab('edit-artist')) e.artist = grab('edit-artist').value.trim();
    if (grab('edit-chapters')) e.totalChapters = grab('edit-chapters').value ? Number(grab('edit-chapters').value) : null;
    if (grab('edit-seasons')) e.totalSeasons = grab('edit-seasons').value ? Number(grab('edit-seasons').value) : null;
    if (grab('edit-status')) e.status = grab('edit-status').value.trim();
    if (grab('edit-legacyNote')) e.legacyNote = grab('edit-legacyNote').value.trim();
    await saveEntry(e);
    DETAIL_EDIT_MODE = false;
    showToast('Saved!');
    render();
  };
  const tagEditToggleBtn = root.querySelector('[data-tag-edit-toggle]');
  if (tagEditToggleBtn) tagEditToggleBtn.onclick = () => { TAG_EDIT_MODE = true; render(); };
  const cancelTagEditBtn = root.querySelector('[data-cancel-tag-edit]');
  if (cancelTagEditBtn) cancelTagEditBtn.onclick = () => {
    TAG_EDIT_MODE = false;
    TAG_EDIT_STATE = { entryId: null, removed: new Set(), added: [] };
    render();
  };
  const addTagBtn = root.querySelector('[data-add-tag]');
  if (addTagBtn) addTagBtn.onclick = () => {
    const input = document.getElementById('new-tag-input');
    const val = input.value.trim();
    if (!val) return;
    if (isHiddenTag(val)) { showToast('That tag is blocked or was deleted before — it\'s hidden on purpose'); return; }
    const ts = getTagEditState(STATE.entryId);
    const e = getEntry(STATE.entryId);
    const already = [...(e.tags || []), ...(e.customTags || []), ...ts.added].some((t) => t.toLowerCase() === val.toLowerCase());
    if (!already) ts.added.push(val);
    input.value = '';
    const box = document.getElementById('tag-similar-box');
    if (box) box.innerHTML = '';
    render();
  };
  const newTagInput = root.querySelector('#new-tag-input');
  const similarBox = root.querySelector('#tag-similar-box');
  if (newTagInput && similarBox) {
    newTagInput.oninput = () => {
      const val = newTagInput.value.trim();
      if (!val) { similarBox.innerHTML = ''; return; }
      const similar = findSimilarTags(val);
      if (!similar.length) { similarBox.innerHTML = ''; return; }
      similarBox.innerHTML = `
        <div class="tag-similar-box">
          <div class="label">Similar tag${similar.length === 1 ? '' : 's'} already exist — tap to reuse instead of creating a near-duplicate</div>
          ${similar.map((t) => `<span class="tag-similar-chip" data-use-similar-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
        </div>`;
    };
    similarBox.onclick = (ev) => {
      const chip = ev.target.closest('[data-use-similar-tag]');
      if (!chip) return;
      const name = chip.getAttribute('data-use-similar-tag');
      const ts = getTagEditState(STATE.entryId);
      const e = getEntry(STATE.entryId);
      const already = [...(e.tags || []), ...(e.customTags || []), ...ts.added].some((t) => t.toLowerCase() === name.toLowerCase());
      if (!already) ts.added.push(name);
      newTagInput.value = '';
      similarBox.innerHTML = '';
      render();
    };
  }
  root.querySelectorAll('[data-toggle-tag]').forEach((el) => {
    el.onclick = () => {
      const t = el.getAttribute('data-toggle-tag');
      const ts = getTagEditState(STATE.entryId);
      if (ts.removed.has(t)) ts.removed.delete(t); else ts.removed.add(t);
      render();
    };
  });
  root.querySelectorAll('[data-toggle-added]').forEach((el) => {
    el.onclick = () => {
      const t = el.getAttribute('data-toggle-added');
      const ts = getTagEditState(STATE.entryId);
      ts.added = ts.added.filter((x) => x !== t);
      render();
    };
  });
  const saveTagsBtn = root.querySelector('[data-save-tags]');
  if (saveTagsBtn) saveTagsBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    const ts = getTagEditState(STATE.entryId);
    e.tags = (e.tags || []).filter((t) => !ts.removed.has(t));
    e.customTags = (e.customTags || []).filter((t) => !ts.removed.has(t)).concat(ts.added);
    await saveEntry(e);
    TAG_EDIT_STATE = { entryId: null, removed: new Set(), added: [] };
    TAG_EDIT_MODE = false;
    showToast('Tags saved!');
    render();
  };
  const notesArea = root.querySelector('#user-notes');
  if (notesArea) {
    const autoGrow = () => { notesArea.style.height = 'auto'; notesArea.style.height = (notesArea.scrollHeight + 2) + 'px'; };
    autoGrow();
    notesArea.oninput = autoGrow;
    notesArea.onblur = async () => {
      const e = getEntry(STATE.entryId); e.notes = notesArea.value; await saveEntry(e);
    };
  }
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
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const idx = Number(el.getAttribute('data-del-screencap'));
      const e = getEntry(STATE.entryId);
      e.screencaps.splice(idx, 1);
      await saveEntry(e); render();
    };
  });
  const reactionPickerBtn = root.querySelector('[data-open-reaction-picker]');
  if (reactionPickerBtn) reactionPickerBtn.onclick = () => openReactionPickerModal(STATE.entryId);
  const reactionUploadInput = root.querySelector('#reaction-upload-input');
  if (reactionUploadInput) reactionUploadInput.onchange = async () => {
    if (!reactionUploadInput.files.length) return;
    await addReactionFiles(reactionUploadInput.files);
    render();
  };
  root.querySelectorAll('[data-del-reaction]').forEach((el) => {
    el.onclick = async () => {
      const id = el.getAttribute('data-del-reaction');
      if (!confirm('Delete this reaction/meme from your library? Any entries it\'s already attached to keep their own copy.')) return;
      await deleteReaction(id);
      showToast('Deleted');
      render();
    };
  });
  root.querySelectorAll('[data-view-screencap]').forEach((imgEl) => {
    imgEl.onclick = () => {
      openModal(`
        <div class="lightbox-wrap">
          <img src="${imgEl.getAttribute('src')}" class="lightbox-img" alt="Screencap, tap and hold to save">
          <button class="lightbox-close" data-close-modal="1">✕ Close</button>
        </div>`);
    };
  });
  const crossRefBtn = root.querySelector('[data-open-crossref]');
  if (crossRefBtn) crossRefBtn.onclick = () => openCrossRefModal(STATE.entryId);
  const generateMatchBtn = root.querySelector('[data-generate-match]');
  if (generateMatchBtn) generateMatchBtn.onclick = () => generateSuggestedMatch(STATE.entryId);
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
    applyTitleSwap(e, sm);
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

  // Tag management view
  const tagmgrSearch = root.querySelector('#tagmgr-search');
  if (tagmgrSearch) tagmgrSearch.oninput = () => {
    const q = tagmgrSearch.value.toLowerCase();
    root.querySelectorAll('.tagmgr-row').forEach((row) => {
      row.style.display = row.getAttribute('data-tag-name').toLowerCase().includes(q) ? '' : 'none';
    });
  };
  root.querySelectorAll('[data-tagmgr-view]').forEach((el) => {
    el.onclick = () => {
      TAG_ENTRIES_FILTER = el.getAttribute('data-tagmgr-view');
      navigate('tagEntries');
    };
  });
  root.querySelectorAll('[data-tagmgr-rename]').forEach((el) => {
    el.onclick = async () => {
      const oldName = el.getAttribute('data-tagmgr-rename');
      const newName = prompt('Rename tag "' + oldName + '" to:', oldName);
      if (!newName || !newName.trim() || newName.trim() === oldName) return;
      const nn = newName.trim();
      if (isHiddenTag(nn)) { showToast('That name is blocked/hidden — pick another'); return; }
      for (const e of ALL_ENTRIES) {
        let changed = false;
        if ((e.tags || []).includes(oldName)) {
          e.tags = Array.from(new Set(e.tags.map((t) => (t === oldName ? nn : t))));
          changed = true;
        }
        if ((e.customTags || []).includes(oldName)) {
          e.customTags = Array.from(new Set(e.customTags.map((t) => (t === oldName ? nn : t))));
          changed = true;
        }
        if (changed) await saveEntry(e);
      }
      showToast('Renamed');
      render();
    };
  });
  root.querySelectorAll('[data-tagmgr-delete]').forEach((el) => {
    el.onclick = async () => {
      const name = el.getAttribute('data-tagmgr-delete');
      if (!confirm('Delete tag "' + name + '" from every entry? This can\'t be undone.')) return;
      for (const e of ALL_ENTRIES) {
        let changed = false;
        if ((e.tags || []).includes(name)) { e.tags = e.tags.filter((t) => t !== name); changed = true; }
        if ((e.customTags || []).includes(name)) { e.customTags = e.customTags.filter((t) => t !== name); changed = true; }
        if (changed) await saveEntry(e);
      }
      await recordDeletedTag(name);
      showToast('Deleted — won\'t come back from future imports either');
      render();
    };
  });

  // HD-match / bulk tag-from-list view
  const hdRaw = root.querySelector('#hdmatch-raw');
  if (hdRaw) hdRaw.oninput = () => { HD_MATCH_STATE.raw = hdRaw.value; };
  const hdTagName = root.querySelector('#hdmatch-tagname');
  if (hdTagName) hdTagName.oninput = () => { HD_MATCH_STATE.tagName = hdTagName.value; };
  const hdFindBtn = root.querySelector('[data-hdmatch-find]');
  if (hdFindBtn) hdFindBtn.onclick = () => {
    HD_MATCH_STATE.raw = hdRaw ? hdRaw.value : HD_MATCH_STATE.raw;
    HD_MATCH_STATE.tagName = hdTagName ? hdTagName.value : HD_MATCH_STATE.tagName;
    if (!HD_MATCH_STATE.raw.trim()) { showToast('Paste some names first'); return; }
    if (!HD_MATCH_STATE.tagName.trim()) { showToast('Give the tag a name first'); return; }
    HD_MATCH_STATE.results = findHdMatches(HD_MATCH_STATE.raw);
    render();
  };
  const hdApplyBtn = root.querySelector('[data-hdmatch-apply]');
  if (hdApplyBtn) hdApplyBtn.onclick = async () => {
    const tagName = HD_MATCH_STATE.tagName.trim();
    const r = HD_MATCH_STATE.results;
    if (!r) return;
    let count = 0;
    for (const { entry, matchedRaw } of r.confident) {
      const already = [...(entry.tags || []), ...(entry.customTags || [])].some((t) => t.toLowerCase() === tagName.toLowerCase());
      if (!already) {
        entry.customTags = [...(entry.customTags || []), tagName];
        await saveEntry(entry);
        count++;
      }
      await markHdRawResolved(matchedRaw);
    }
    showToast(`Tagged ${count} entr${count === 1 ? 'y' : 'ies'} "${tagName}"`);
    render();
  };
  root.querySelectorAll('[data-hdmatch-confirm]').forEach((el) => {
    el.onclick = async () => {
      const [idxStr, entryId] = el.getAttribute('data-hdmatch-confirm').split(':');
      const idx = Number(idxStr);
      const r = HD_MATCH_STATE.results;
      if (!r || !r.uncertain[idx]) return;
      const entry = getEntry(entryId);
      const tagName = HD_MATCH_STATE.tagName.trim();
      const already = [...(entry.tags || []), ...(entry.customTags || [])].some((t) => t.toLowerCase() === tagName.toLowerCase());
      if (!already) {
        entry.customTags = [...(entry.customTags || []), tagName];
        await saveEntry(entry);
      }
      await markHdRawResolved([r.uncertain[idx].raw]);
      r.uncertain[idx].confirmed = entry.title;
      showToast(`Tagged "${entry.title}"`);
      render();
    };
  });
  root.querySelectorAll('[data-hdmatch-skip]').forEach((el) => {
    el.onclick = async () => {
      const idx = Number(el.getAttribute('data-hdmatch-skip'));
      const r = HD_MATCH_STATE.results;
      if (!r || !r.uncertain[idx]) return;
      await markHdRawResolved([r.uncertain[idx].raw]);
      r.uncertain.splice(idx, 1);
      showToast('Skipped — won\'t ask again');
      render();
    };
  });
  root.querySelectorAll('[data-hdmatch-skip-unmatched]').forEach((el) => {
    el.onclick = async () => {
      const idx = Number(el.getAttribute('data-hdmatch-skip-unmatched'));
      const r = HD_MATCH_STATE.results;
      if (!r || r.unmatched[idx] == null) return;
      await markHdRawResolved([r.unmatched[idx]]);
      r.unmatched.splice(idx, 1);
      showToast('Ignored');
      render();
    };
  });

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
        const merged = new Set([...(e.tags || []), ...sanitizeIncomingTags(sm.tags)]);
        e.tags = Array.from(merged);
      }
      if (!e.author && sm.author) e.author = sm.author;
      applyTitleSwap(e, sm);
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
  root.querySelectorAll('[data-dup-not-duplicate]').forEach((el) => {
    el.onclick = async () => {
      const sig = el.getAttribute('data-dup-not-duplicate');
      IGNORED_DUP_GROUPS.add(sig);
      const arr = Array.from(IGNORED_DUP_GROUPS);
      await idbPut(STORE_META, { key: 'ignoredDupGroups', value: arr });
      pushMetaField('ignoredDupGroups', arr);
      showToast('Got it — won\'t flag these as duplicates again');
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
  if (STATE.shelf === 'ALL' && !STATE.tagFilters.length && !STATE.search && !STATE.showFavoritesOnly && !STATE.showOnDriveOnly && !STATE.smutFilter && !STATE.qualityFilter && !STATE.flagFilter) {
    const suggestedGroup = entries.filter((e) => e.suggestedMatch);
    if (suggestedGroup.length > 0) {
      body += `<div class="section-title">🔎 Suggested Matches <span style="opacity:.6">(${suggestedGroup.length})</span></div>`;
      body += scrollRow('row-suggested', suggestedGroup.map(renderCoverCard).join(''));
    }
    const shelvesToShow = STATE.format === 'reading' ? SHELVES_READING : ['Completed'];
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      const rowId = 'row-' + shelf.replace(/[^a-z0-9]+/gi, '-');
      body += `<div class="section-title">${escapeHtml(shelf)} <span style="opacity:.6">(${group.length})</span></div>`;
      body += scrollRow(rowId, group.map(renderCoverCard).join(''));
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
    main.querySelectorAll('[data-scroll-target]').forEach((btn) => {
      btn.onclick = () => {
        const target = document.getElementById(btn.getAttribute('data-scroll-target'));
        if (!target) return;
        target.scrollBy({ left: Number(btn.getAttribute('data-dir')) * 300, behavior: 'smooth' });
      };
    });
  }
}

/* ---------------------------------------------------------------------- */
/* Global modal button delegation (settings/add/crossref use event         */
/* delegation on the overlay itself since they're re-rendered often)       */
/* ---------------------------------------------------------------------- */

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (TAG_FILTER_OPEN && !t.closest('.tag-multiselect') && STATE.view === 'home') {
    TAG_FILTER_OPEN = false;
    render();
    return;
  }
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
  if (t.matches('[data-paste-ref]')) pasteReferenceFromClipboard(t.getAttribute('data-paste-ref'));
});
document.getElementById('overlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'overlay') closeModal();
});

/* ---------------------------------------------------------------------- */
/* Filter section collapse (home view) — manual arrow toggle only, no     */
/* longer tied to scroll direction. See attachRootHandlers for the click  */
/* handler on [data-toggle-filters].                                     */
/* ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */

// Once a day (per device), quietly try to find suggested matches for a
// small batch of entries that don't have one yet — so the Suggested
// Matches row on the homepage keeps filling in on its own over time,
// without the user having to open every single entry and tap the button.
// Capped and paced with a short delay between requests so this doesn't
// hammer Anime-Planet/MangaGo or blow through Apps Script's quota.
const AUTO_MATCH_BATCH_SIZE = 20;
const AUTO_MATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function autoMatchSweepIfDue() {
  try {
    const proxy = getProxyUrl();
    if (!proxy) return; // nothing to do until a proxy URL is configured

    const meta = await idbGet(STORE_META, 'lastAutoMatchRun');
    const lastRun = meta && meta.value ? new Date(meta.value).getTime() : 0;
    if (Date.now() - lastRun < AUTO_MATCH_INTERVAL_MS) return;

    // Record the attempt now, so a reload mid-sweep (or a very large
    // backlog that takes several days of batches to clear) doesn't
    // re-trigger another sweep later today.
    await idbPut(STORE_META, { key: 'lastAutoMatchRun', value: new Date().toISOString() });

    const candidates = ALL_ENTRIES
      .filter((e) => !e.suggestedMatch && e.referenceStatus !== 'confirmed')
      .slice(0, AUTO_MATCH_BATCH_SIZE);
    if (!candidates.length) return;

    let foundCount = 0;
    for (const e of candidates) {
      const data = await findSuggestedMatchData(proxy, e);
      if (data) {
        e.suggestedMatch = dataToSuggestedMatch(data);
        await saveEntry(e);
        foundCount++;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    if (foundCount > 0) {
      showToast(`Found ${foundCount} new suggested match${foundCount === 1 ? '' : 'es'}`);
      if (STATE.view === 'home') render();
    }
  } catch (err) {
    // Best-effort background task — a failure here shouldn't disrupt the user.
    console.error('Auto-match sweep failed:', err);
  }
}

async function boot() {
  try {
    db = await openDB();
    await ensureSeeded();
    await loadAllEntries();
    await loadAllReactions();
    const savedDeleted = await idbGet(STORE_META, 'deletedTagKeys');
    if (savedDeleted && Array.isArray(savedDeleted.value)) DELETED_TAG_KEYS = new Set(savedDeleted.value);
    const savedResolved = await idbGet(STORE_META, 'hdResolvedRaw');
    if (savedResolved && Array.isArray(savedResolved.value)) HD_RESOLVED_RAW = new Set(savedResolved.value);
    const savedIgnoredDup = await idbGet(STORE_META, 'ignoredDupGroups');
    if (savedIgnoredDup && Array.isArray(savedIgnoredDup.value)) IGNORED_DUP_GROUPS = new Set(savedIgnoredDup.value);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    fbAuth.onAuthStateChanged(async (user) => {
      CURRENT_USER = user;
      if (user) {
        SYNC_BUSY = true;
        try {
          await syncWithFirestore(user);
          await syncReactionsWithFirestore(user);
          await pullMetaState();
          startFirestoreListener(user);
        } catch (err) {
          console.error('Firestore sync failed:', err);
          showToast("Couldn't sync — check your connection");
        }
        SYNC_BUSY = false;
        autoMatchSweepIfDue();
        runFavoriteTagMigrationOnce();
      }
      render();
    });
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
