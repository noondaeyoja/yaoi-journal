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
// Session-only persistence: closing the browser/tab fully ends the login,
// so the next visit requires signing in again (rather than staying signed
// in indefinitely). This is a deliberate privacy choice for a personal,
// single-user app that also holds a live Google Drive connection.
fbAuth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(() => {});
const fbStore = firebase.firestore();
try { fbStore.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}

let CURRENT_USER = null;         // signed-in Firebase user, or null = show the sign-in screen
let FIRESTORE_UNSUB = null;      // unsubscribe fn for the live cross-device entries listener
let AUTH_ERROR = '';
let AUTH_BUSY = false;
let SYNC_BUSY = false;           // true while the initial pull/push migration is running

// Lightweight local "screen lock" (not a real sign-out): if the tab/app is
// backgrounded for a while on mobile and then comes back, we show a simple
// unlock overlay instead of the data straightaway. Purely client-side and
// in-memory — doesn't touch the Firebase session or the Drive connection,
// it's just a casual privacy shield against someone glancing at the phone.
let APP_LOCKED = false;
let LOCK_HIDDEN_AT = null;
const LOCK_THRESHOLD_MS = 60000; // 1 minute
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    LOCK_HIDDEN_AT = Date.now();
  } else if (LOCK_HIDDEN_AT) {
    const elapsed = Date.now() - LOCK_HIDDEN_AT;
    LOCK_HIDDEN_AT = null;
    if (elapsed >= LOCK_THRESHOLD_MS && CURRENT_USER) {
      APP_LOCKED = true;
      render();
    }
  }
});

// Google Drive access token (for image upload/download), separate from the
// Firebase Auth session above. Firebase keeps you signed in persistently,
// but this token is only good for ~1hr and is NOT silently refreshed on
// reload — so DRIVE_NEEDS_RECONNECT flips true whenever a Drive call fails
// from an expired/missing token, and the UI offers a one-click reconnect
// (re-running Google sign-in) rather than failing silently.
let DRIVE_ACCESS_TOKEN = null;
let DRIVE_TOKEN_EXPIRES_AT = 0;
let DRIVE_NEEDS_RECONNECT = false;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'Yaoi Journal Images';
let DRIVE_FOLDER_ID = null; // cached once found/created, see ensureDriveFolder()

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
let TAG_SUGGESTIONS_OPEN = true;    // whether the Tags screen's Suggestions panel is expanded
let DB_SETTINGS_OPEN = false;       // whether the Database screen's inline Settings panel is expanded
let DB_TABLE_OPEN = false;          // whether the Database screen's full data table is expanded
let FILTERS_COLLAPSED = false;     // whether the homepage search/tabs/format/Status/Tags/Ratings&Flags block is tucked away
let SEARCH_INPUT_SHOULD_FOCUS = false; // one-shot flag: refocus the global search box after it causes a view jump
let STATE = {
  view: 'home',            // 'home' | 'detail' | 'tags' | 'database' | 'review' | 'duplicates'
  entryId: null,
  format: 'reading',        // 'reading' | 'watching'
  showFavoritesOnly: false,
  showOnDriveOnly: false,   // "On Yaoi Drive" homepage tab — entries tagged as saved on the drive
  showHentaiOnly: false,    // "Hentai" filter — entries tagged as hentai
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
  // Once it's up on Drive, the base64 copy doesn't need to also ride along
  // in Firestore — keeps this doc tiny regardless of image size.
  const safe = (reaction.driveId && reaction.dataUrl) ? { ...reaction, dataUrl: null } : reaction;
  const json = JSON.stringify(safe);
  if (json.length > 900 * 1024) {
    console.error(`Reaction image too large to sync to Firestore (kept locally on this device only).`);
    showToast(`That reaction image is too big to back up to the cloud — kept on this device only.`);
    return;
  }
  col.doc(reaction.id).set(safe).catch((err) => {
    console.error('Reaction sync failed:', err);
    showToast(`Couldn't back up that reaction to the cloud — saved locally, will retry later.`);
  });
}

function deleteReactionFromFirestore(id) {
  const col = userReactionsCol();
  if (!col) return;
  col.doc(id).delete().catch((err) => console.error('Reaction delete sync failed:', err));
}

function reactionSafeForFirestore(r) {
  return (r.driveId && r.dataUrl) ? { ...r, dataUrl: null } : r;
}

// Same last-write-wins merge philosophy as syncWithFirestore, applied to the
// much smaller reactions library.
async function syncReactionsWithFirestore(user) {
  const col = fbStore.collection('users').doc(user.uid).collection('reactions');
  // See the matching comment in syncWithFirestore — force a real server
  // read so this boot-time merge never acts on a stale multi-tab cache.
  const snap = await col.get({ source: 'server' }).catch(() => col.get());
  if (snap.empty) {
    if (ALL_REACTIONS.length) {
      const batch = fbStore.batch();
      ALL_REACTIONS.forEach((r) => {
        const safe = reactionSafeForFirestore(r);
        if (JSON.stringify(safe).length <= 900 * 1024) batch.set(col.doc(r.id), safe);
      });
      await batch.commit();
    }
    return;
  }
  const remote = snap.docs.map((d) => d.data());
  const localById = new Map(ALL_REACTIONS.map((r) => [r.id, r]));
  const merged = [];
  const toLocal = [];
  const toRemote = [];
  remote.forEach((rr) => {
    const lr = localById.get(rr.id);
    if (!lr) { merged.push(rr); toLocal.push(rr); }
    else {
      const rt = new Date(rr.updatedAt || 0).getTime();
      const lt = new Date(lr.updatedAt || 0).getTime();
      merged.push(rt > lt ? rr : lr);
      if (rt > lt) toLocal.push(rr);
      else if (lt > rt) toRemote.push(lr);
    }
    localById.delete(rr.id);
  });
  // This used to just get added to `merged` and nothing else — a reaction
  // that only existed locally (e.g. its very first upload never made it up,
  // whether from being offline, an oversized image, or a dropped request)
  // stayed local-only forever, because nothing ever retried the push on a
  // later sync. Now every local-only reaction gets pushed up again here too.
  localById.forEach((lr) => { merged.push(lr); toRemote.push(lr); });
  if (toLocal.length) await idbBulkPut(STORE_REACTIONS, toLocal);
  if (toRemote.length) {
    const batch = fbStore.batch();
    let anySkipped = false;
    toRemote.forEach((r) => {
      const safe = reactionSafeForFirestore(r);
      if (JSON.stringify(safe).length <= 900 * 1024) batch.set(col.doc(r.id), safe);
      else anySkipped = true;
    });
    await batch.commit().catch((err) => console.error('Reaction bulk sync failed:', err));
    if (anySkipped) showToast('Some reaction images are too large to back up to the cloud — kept on this device only.');
  }
  ALL_REACTIONS = merged;
  toLocal.forEach((r) => { hydrateDriveReaction(r).catch(() => {}); });
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
    const snap = await ref.get({ source: 'server' }).catch(() => ref.get());
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
    if (Array.isArray(data.userHiddenTagKeys) && data.userHiddenTagKeys.length) {
      USER_HIDDEN_TAG_KEYS = new Set([...USER_HIDDEN_TAG_KEYS, ...data.userHiddenTagKeys]);
      await idbPut(STORE_META, { key: 'userHiddenTagKeys', value: Array.from(USER_HIDDEN_TAG_KEYS) });
    }
    if (Array.isArray(data.ignoredTagSuggestions) && data.ignoredTagSuggestions.length) {
      IGNORED_TAG_SUGGESTIONS = new Set([...IGNORED_TAG_SUGGESTIONS, ...data.ignoredTagSuggestions]);
      await idbPut(STORE_META, { key: 'ignoredTagSuggestions', value: Array.from(IGNORED_TAG_SUGGESTIONS) });
    }
    if (Array.isArray(data.reactionGroups) && data.reactionGroups.length) {
      const localGroupIds = new Set(REACTION_GROUPS.map((g) => g.id));
      const newOnes = data.reactionGroups.filter((g) => g && g.id && !localGroupIds.has(g.id));
      if (newOnes.length) {
        REACTION_GROUPS = REACTION_GROUPS.concat(newOnes);
        await idbPut(STORE_META, { key: 'reactionGroups', value: REACTION_GROUPS });
      }
    }
    // Only fill in the proxy URL from the cloud if this device doesn't
    // already have one set locally — never overwrite a value someone just
    // typed in on this device with an older/blank remote one.
    if (typeof data.proxyUrl === 'string' && data.proxyUrl && !localStorage.getItem('yj_proxy_url')) {
      localStorage.setItem('yj_proxy_url', data.proxyUrl);
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
// Strips the heaviest fields one at a time (biggest offender first — usually
// screencaps, since there can be several) until the doc fits, instead of
// only ever trimming coverUrl. The old version gave up and returned null —
// meaning the ENTIRE entry (title, tags, reference link, favorite status,
// everything) silently never synced at all, not just the image — which is
// exactly the "manual match doesn't show up, images don't show up" bug.
// Now only the oversized image fields get dropped from the synced copy;
// everything else about the entry still makes it to the cloud, and the
// images stay fully intact in this device's own local IndexedDB.
function firestoreSafeEntry(entry) {
  let candidate = entry;
  // Images that have already made it to Drive don't need to ride along as
  // base64 in Firestore at all anymore — drop them unconditionally (not
  // just when oversized) so entries stay small no matter how many photos
  // get added over time, instead of only trimming once already too big.
  if (candidate.coverDriveId && candidate.coverUrl && candidate.coverUrl.startsWith('data:')) {
    candidate = { ...candidate, coverUrl: null };
  }
  if (candidate.screencapDriveIds && candidate.screencapDriveIds.length && candidate.screencaps && candidate.screencaps.length) {
    candidate = { ...candidate, screencaps: [] };
  }
  if (candidate.semi && candidate.semi.photoDriveId && candidate.semi.photo) {
    candidate = { ...candidate, semi: { ...candidate.semi, photo: null } };
  }
  if (candidate.uke && candidate.uke.photoDriveId && candidate.uke.photo) {
    candidate = { ...candidate, uke: { ...candidate.uke, photo: null } };
  }
  const trimmedFields = [];
  if (JSON.stringify(candidate).length <= FIRESTORE_DOC_SAFE_BYTES) {
    return { safe: candidate, trimmedFields };
  }
  if (candidate.screencaps && candidate.screencaps.length) {
    candidate = { ...candidate, screencaps: [], screencapsTooLargeForSync: true };
    trimmedFields.push('screencaps');
  }
  if (JSON.stringify(candidate).length > FIRESTORE_DOC_SAFE_BYTES && candidate.uke && candidate.uke.photo) {
    candidate = { ...candidate, uke: { ...candidate.uke, photo: null }, ukePhotoTooLargeForSync: true };
    trimmedFields.push('uke photo');
  }
  if (JSON.stringify(candidate).length > FIRESTORE_DOC_SAFE_BYTES && candidate.semi && candidate.semi.photo) {
    candidate = { ...candidate, semi: { ...candidate.semi, photo: null }, semiPhotoTooLargeForSync: true };
    trimmedFields.push('semi photo');
  }
  if (JSON.stringify(candidate).length > FIRESTORE_DOC_SAFE_BYTES && candidate.coverUrl && candidate.coverUrl.startsWith('data:')) {
    candidate = { ...candidate, coverUrl: null, coverTooLargeForSync: true };
    trimmedFields.push('cover image');
  }
  if (JSON.stringify(candidate).length <= FIRESTORE_DOC_SAFE_BYTES) {
    console.warn(`Entry "${entry.title || entry.id}" trimmed for Firestore sync (too large otherwise): ${trimmedFields.join(', ')} — kept locally, not synced.`);
    return { safe: candidate, trimmedFields };
  }
  console.error(`Entry "${entry.title || entry.id}" is too large to sync to Firestore even after trimming every image field; skipping remote sync for this entry entirely.`);
  return { safe: null, trimmedFields };
}

function pushEntryToFirestore(entry) {
  const col = userEntriesCol();
  if (!col) return;
  const { safe, trimmedFields } = firestoreSafeEntry(entry);
  if (!safe) {
    showToast(`"${entry.title || 'This entry'}" is too large to back up to the cloud — it's saved on this device only.`);
    return;
  }
  if (trimmedFields.length) {
    showToast(`"${entry.title || 'This entry'}": ${trimmedFields.join(', ')} too large to sync — kept on this device only, rest saved to the cloud.`);
  }
  col.doc(entry.id).set(safe).catch((err) => {
    console.error('Firestore save failed:', err);
    showToast(`Couldn't back up "${entry.title || 'this entry'}" to the cloud — saved locally, will retry later.`);
  });
}

function deleteEntryFromFirestore(id) {
  const col = userEntriesCol();
  if (!col) return;
  col.doc(id).delete().catch((err) => console.error('Firestore delete failed:', err));
}

// When a remote copy of an entry was trimmed by firestoreSafeEntry (marked
// with the *TooLargeForSync flags), it's missing images this device may
// already have in full. Without this, accepting that remote copy — which
// happens constantly, including the live listener echoing back this same
// device's OWN just-made write — would silently blank out images that were
// only ever "too big for Firestore," never actually deleted. This was the
// actual cause of images vanishing moments after upload: the write goes out
// trimmed, Firestore echoes it straight back, and the echo used to win and
// overwrite the fuller local copy this very save had just produced.
function restoreLocallyKeptImages(remote, local) {
  if (!local) return remote;
  let patched = remote;
  if (remote.screencapsTooLargeForSync && local.screencaps && local.screencaps.length) {
    patched = { ...patched, screencaps: local.screencaps };
  }
  if (remote.ukePhotoTooLargeForSync && local.uke && local.uke.photo) {
    patched = { ...patched, uke: { ...patched.uke, photo: local.uke.photo } };
  }
  if (remote.semiPhotoTooLargeForSync && local.semi && local.semi.photo) {
    patched = { ...patched, semi: { ...patched.semi, photo: local.semi.photo } };
  }
  if (remote.coverTooLargeForSync && local.coverUrl && local.coverUrl.startsWith('data:')) {
    patched = { ...patched, coverUrl: local.coverUrl };
  }
  return patched;
}

/* ---------------------------------------------------------------------- */
/* Google Drive image storage                                             */
/* Images now live as real files in a dedicated "Yaoi Journal Images"     */
/* folder in the signed-in Google account's own Drive, instead of being   */
/* embedded as base64 inside Firestore documents. Entries/reactions keep  */
/* a small Drive file id instead of the raw image data — Firestore docs   */
/* stay tiny no matter how many photos an entry has, and there's no more  */
/* per-document size ceiling to silently run into.                       */
/*                                                                        */
/* Local IndexedDB still caches the actual image bytes (as data: URLs)    */
/* for instant, offline-friendly display — Drive is purely the transport  */
/* used to get an image from the device that uploaded it to any other     */
/* device signed into the same account (see hydrateDriveImages below).    */
/* ---------------------------------------------------------------------- */

function driveTokenValid() {
  return !!DRIVE_ACCESS_TOKEN && Date.now() < DRIVE_TOKEN_EXPIRES_AT;
}

// Wraps every Drive REST call. On an expired/missing token this flips
// DRIVE_NEEDS_RECONNECT (which shows a one-click "Reconnect Google Drive"
// banner) instead of failing in a way that looks like another lost upload.
async function driveFetch(url, options) {
  if (!driveTokenValid()) {
    DRIVE_NEEDS_RECONNECT = true;
    throw new Error('No valid Google Drive access token — reconnect required.');
  }
  const resp = await fetch(url, {
    ...options,
    headers: { ...((options && options.headers) || {}), Authorization: `Bearer ${DRIVE_ACCESS_TOKEN}` }
  });
  if (resp.status === 401) {
    DRIVE_NEEDS_RECONNECT = true;
    throw new Error('Google Drive access expired — reconnect required.');
  }
  return resp;
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || 'image/jpeg';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Finds (or creates, the very first time) the app's dedicated Drive folder.
// Cached in memory for the session so this is only a network round-trip once.
async function ensureDriveFolder() {
  if (DRIVE_FOLDER_ID) return DRIVE_FOLDER_ID;
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchResp = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
  const searchData = await searchResp.json();
  if (searchData.files && searchData.files.length) {
    DRIVE_FOLDER_ID = searchData.files[0].id;
    return DRIVE_FOLDER_ID;
  }
  const createResp = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  const createData = await createResp.json();
  if (!createData.id) throw new Error('Could not create Drive folder: ' + JSON.stringify(createData));
  DRIVE_FOLDER_ID = createData.id;
  return DRIVE_FOLDER_ID;
}

// Uploads a base64 data: URL image into the app's Drive folder (simple
// multipart upload) and returns the new file's id.
async function uploadToDrive(dataUrl, filename) {
  const folderId = await ensureDriveFolder();
  const blob = dataUrlToBlob(dataUrl);
  const metadata = { name: filename, parents: [folderId] };
  const boundary = 'yaoi_journal_' + Math.random().toString(36).slice(2);
  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${blob.type}\r\n\r\n`
  );
  const closing = encoder.encode(`\r\n--${boundary}--`);
  const arrayBuf = await blob.arrayBuffer();
  const body = new Blob([preamble, arrayBuf, closing]);
  const resp = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const data = await resp.json();
  if (!data.id) throw new Error('Drive upload did not return a file id: ' + JSON.stringify(data));
  return data.id;
}

// Fetches an image's bytes back from Drive as a data: URL — same format
// every existing render function already expects for images.
async function downloadFromDrive(fileId) {
  const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function deleteFromDrive(fileId) {
  if (!fileId) return;
  driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' }).catch((err) => console.error('Drive delete failed:', err));
}

// Best-effort wrapper for upload call sites: the image is already cached
// locally and displaying fine regardless of whether this succeeds, so a
// Drive failure here should never block or fail the save — it just means
// this particular image stays local-only until the next successful upload
// or reconnect, same as the existing "too large to sync" case.
async function tryUploadImageToDrive(dataUrl, filename) {
  try {
    return await uploadToDrive(dataUrl, filename);
  } catch (err) {
    console.error('Drive image upload failed:', err);
    if (DRIVE_NEEDS_RECONNECT) showToast('Google Drive needs reconnecting — this image is saved on this device only for now.');
    return null;
  }
}

// Called whenever a remote-sourced entry is accepted (boot sync or the live
// listener) — if it references Drive files this device doesn't have a local
// copy of yet (e.g. uploaded from her phone, this is the desktop seeing it
// for the first time), fetch them from Drive and patch the LOCAL copy only.
// Every existing render path already expects e.coverUrl/screencaps/photo to
// just be data: URLs, so this is the only place that needs to know Drive
// exists — nothing else has to change.
async function hydrateDriveImages(entry) {
  if (!entry) return;
  const jobs = [];
  if (entry.coverDriveId && !entry.coverUrl) {
    jobs.push(downloadFromDrive(entry.coverDriveId).then((url) => { entry.coverUrl = url; }).catch((err) => console.error('Cover hydrate failed:', err)));
  }
  if (entry.semi && entry.semi.photoDriveId && !entry.semi.photo) {
    jobs.push(downloadFromDrive(entry.semi.photoDriveId).then((url) => { entry.semi.photo = url; }).catch((err) => console.error('Semi photo hydrate failed:', err)));
  }
  if (entry.uke && entry.uke.photoDriveId && !entry.uke.photo) {
    jobs.push(downloadFromDrive(entry.uke.photoDriveId).then((url) => { entry.uke.photo = url; }).catch((err) => console.error('Uke photo hydrate failed:', err)));
  }
  if (entry.screencapDriveIds && entry.screencapDriveIds.length && (!entry.screencaps || entry.screencaps.length < entry.screencapDriveIds.length)) {
    jobs.push((async () => {
      const urls = [];
      for (const id of entry.screencapDriveIds) {
        try { urls.push(await downloadFromDrive(id)); } catch (err) { console.error('Screencap hydrate failed:', err); }
      }
      if (urls.length) entry.screencaps = urls;
    })());
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  await idbPut(STORE_ENTRIES, entry);
  const idx = ALL_ENTRIES.findIndex((e) => e.id === entry.id);
  if (idx > -1) ALL_ENTRIES[idx] = entry;
  if (STATE.view === 'detail' && STATE.entryId === entry.id) render();
}

// Same idea as hydrateDriveImages, for the standalone reactions/meme library.
async function hydrateDriveReaction(reaction) {
  if (!reaction || !reaction.driveId || reaction.dataUrl) return;
  try {
    reaction.dataUrl = await downloadFromDrive(reaction.driveId);
    await idbPut(STORE_REACTIONS, reaction);
    const idx = ALL_REACTIONS.findIndex((r) => r.id === reaction.id);
    if (idx > -1) ALL_REACTIONS[idx] = reaction;
    if (['reactions', 'meme'].includes(STATE.view)) render();
  } catch (err) {
    console.error('Reaction hydrate failed:', err);
  }
}

// Runs once right after sign-in. If this account has never synced before
// (no entries in Firestore yet), push everything currently on this device
// up as the starting point. Otherwise merge: newest updatedAt wins per
// entry, id-by-id, and any local-only or remote-only entries get copied
// over so nothing is ever silently dropped.
async function syncWithFirestore(user) {
  const col = fbStore.collection('users').doc(user.uid).collection('entries');
  // Force a real server read here, not Firestore's own (multi-tab) local
  // cache. This runs once at boot and its result decides which side "wins"
  // per entry — if it silently served a stale cached snapshot instead of
  // what the server actually has, a genuinely newer edit from another
  // device/tab could look older than it is and get skipped, which is
  // exactly the kind of "sometimes it remembers, sometimes it doesn't"
  // behavior that's been reported. Falls back to the default (cache-or-
  // server) read if the device is genuinely offline.
  const snap = await col.get({ source: 'server' }).catch(() => col.get());

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
      if (rt > lt) {
        const patched = restoreLocallyKeptImages(re, le);
        merged.push(patched); toLocal.push(patched);
      }
      else { merged.push(le); if (lt > rt) toRemote.push(le); }
    }
    localById.delete(re.id);
  });
  // Anything left in localById exists only on this device — push it up.
  localById.forEach((le) => { merged.push(le); toRemote.push(le); });

  if (toLocal.length) await idbBulkPut(STORE_ENTRIES, toLocal);
  if (toRemote.length) await firestoreBulkWrite(col, toRemote);
  ALL_ENTRIES = merged;
  // Fire-and-forget: pull actual image bytes down from Drive for anything
  // that arrived from another device with a Drive id but no local copy yet.
  // Not awaited so a big first sync doesn't block the whole app on however
  // many images need fetching — each one patches itself in and re-renders
  // if it's the entry currently on screen.
  toLocal.forEach((e) => { hydrateDriveImages(e).catch(() => {}); });
}

async function firestoreBulkWrite(col, entries) {
  const CHUNK = 400; // stay under Firestore's 500-writes-per-batch limit
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = fbStore.batch();
    entries.slice(i, i + CHUNK).forEach((e) => {
      const { safe } = firestoreSafeEntry(e);
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
        // Patch back in any images this device already has that the
        // incoming doc is only missing because it got trimmed for size —
        // otherwise this listener firing on the echo of this device's OWN
        // upload (rt === lt, since it's the same save) would immediately
        // blank the image right back out of local storage.
        const patched = restoreLocallyKeptImages(data, local);
        if (idx > -1) ALL_ENTRIES[idx] = patched; else ALL_ENTRIES.push(patched);
        idbPut(STORE_ENTRIES, patched).catch(() => {});
        hydrateDriveImages(patched).catch(() => {});
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

// Notes fields on the detail page (semi/uke notes, character notes) act like
// a bullet list: every line starts with a 💦, and hitting Enter starts a
// fresh bulleted line automatically instead of a plain blank line.
const NOTE_BULLET = '💦 ';
function attachBulletTextarea(el) {
  if (!el || el._bulletWired) return;
  el._bulletWired = true;
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const start = el.selectionStart, end = el.selectionEnd;
    const insert = '\n' + NOTE_BULLET;
    el.value = el.value.slice(0, start) + insert + el.value.slice(end);
    const pos = start + insert.length;
    el.selectionStart = el.selectionEnd = pos;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  el.addEventListener('focus', () => {
    if (!el.value) {
      el.value = NOTE_BULLET;
      el.selectionStart = el.selectionEnd = el.value.length;
    }
  });
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
  document.getElementById('overlay').classList.remove('lightbox-mode');
  document.getElementById('modal-sheet').innerHTML = '';
}

// A true centered/fullscreen image viewer (as opposed to the usual bottom
// sheet used for forms/menus) — used for screencap and Images-tab viewing.
// belowHtml is optional extra content rendered under the image, inside the
// overlay's own solid panel (the overlay's background goes transparent in
// lightbox mode so the photo itself is the star).
function openImageLightbox(dataUrl, belowHtml) {
  openModal(`
    <div class="lightbox-wrap">
      <img src="${dataUrl}" class="lightbox-img" alt="Tap and hold to save">
      ${belowHtml || ''}
      <button class="lightbox-close" data-close-modal="1">✕ Close</button>
    </div>`);
  document.getElementById('overlay').classList.add('lightbox-mode');
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
// Also mirrors to the Firestore meta doc so setting this once on desktop
// means mobile has it too, instead of asking for the same Apps Script URL
// on every device separately.
function setProxyUrl(url) {
  const trimmed = url.trim();
  localStorage.setItem('yj_proxy_url', trimmed);
  pushMetaField('proxyUrl', trimmed);
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
  return `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-title">💜 Yaoi Journal</div>
        <div class="auth-sub">Sign in with Google to keep your journal — and your images, stored in your own Google Drive — in sync between your phone and desktop.</div>
        ${AUTH_ERROR ? `<div class="auth-error">${escapeHtml(AUTH_ERROR)}</div>` : ''}
        <button class="btn-primary auth-submit-btn" data-google-signin="1" ${AUTH_BUSY ? 'disabled' : ''}>
          ${AUTH_BUSY ? 'Please wait…' : 'Continue with Google'}
        </button>
        <p style="font-size:11px;color:var(--text-dim);text-align:center;margin-top:12px;line-height:1.5;">
          You'll be asked to grant access to a private app folder in your Drive — this app can only see files it creates itself, nothing else in your Drive.
        </p>
      </div>
    </div>`;
}

function attachAuthHandlers() {
  const root = document.getElementById('view-root');
  const googleBtn = root.querySelector('[data-google-signin]');
  if (googleBtn) googleBtn.onclick = signInWithGoogle;
}

// Installed/home-screen PWAs (especially iOS Safari "Add to Home Screen" and
// most Android WebAPK installs) frequently can't open or return a real
// signInWithPopup() window — there's no separate browser chrome to host it,
// so the popup silently fails to appear. signInWithRedirect() (full-page
// navigate to Google and back) is the standard, reliable fallback for that
// context, so we detect standalone mode and use redirect there.
function isStandalonePWA() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
}

function newGoogleProvider() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  // Always show the consent screen rather than a silent re-auth — this is
  // also how a lapsed/expired Drive token gets refreshed (see
  // reconnectGoogleDrive()), since Firebase doesn't do that on its own.
  provider.setCustomParameters({ prompt: 'consent' });
  return provider;
}

async function signInWithGoogle() {
  AUTH_BUSY = true; AUTH_ERROR = ''; render();
  if (isStandalonePWA()) {
    try {
      await fbAuth.signInWithRedirect(newGoogleProvider());
      // Page navigates away here; result is picked up by getRedirectResult()
      // in boot() on the next load.
      return;
    } catch (err) {
      AUTH_ERROR = authErrorMessage(err);
      AUTH_BUSY = false;
      render();
      return;
    }
  }
  try {
    const result = await fbAuth.signInWithPopup(newGoogleProvider());
    const credential = firebase.auth.GoogleAuthProvider.credentialFromResult(result);
    if (credential && credential.accessToken) {
      DRIVE_ACCESS_TOKEN = credential.accessToken;
      DRIVE_TOKEN_EXPIRES_AT = Date.now() + 55 * 60 * 1000; // Google tokens last ~1hr; refresh a bit early
      DRIVE_NEEDS_RECONNECT = false;
    }
    // onAuthStateChanged (wired in boot()) picks up the signed-in user from here.
  } catch (err) {
    if (err && err.code === 'auth/popup-closed-by-user') {
      AUTH_BUSY = false; render(); return;
    }
    // Popup blocked, failed to open, or some browsers just don't support it —
    // fall back to a full-page redirect rather than leaving the user stuck.
    if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment' || err.code === 'auth/cancelled-popup-request')) {
      try {
        await fbAuth.signInWithRedirect(newGoogleProvider());
        return;
      } catch (err2) {
        AUTH_ERROR = authErrorMessage(err2);
        AUTH_BUSY = false;
        render();
        return;
      }
    }
    AUTH_ERROR = authErrorMessage(err);
    AUTH_BUSY = false;
    render();
  }
}

// Re-runs Google sign-in purely to mint a fresh Drive access token (the
// Firebase session itself never lapsed) — used from the "Reconnect Google
// Drive" banner that shows up once the ~1hr token expires or a Drive call
// comes back 401.
//
// This ALWAYS uses signInWithRedirect (full-page navigate to Google and
// back), never signInWithPopup — confirmed by watching it live: while
// already signed in, the popup flow can complete Google's side (account
// picker, "you're signing back in" confirmation) and close cleanly, but the
// browser blocks the popup from messaging its result back to the opener tab
// (third-party storage/cookie restrictions), so the signInWithPopup()
// promise just hangs forever — no resolve, no reject, no error, nothing.
// That's exactly what looked like "the banner just won't go away" with no
// error message. A redirect doesn't need any cross-window messaging at all,
// so it can't get stuck this way.
// Google Identity Services (GIS) token client — mints Drive access tokens
// directly, independent of Firebase Auth's sign-in session. Loaded via the
// <script src="https://accounts.google.com/gsi/client"> tag in index.html.
const GOOGLE_OAUTH_CLIENT_ID = '831194325870-hi0rg7a86n5tbqrk75hfdq90f5lkucrp.apps.googleusercontent.com';
let GIS_TOKEN_CLIENT = null;

function initGisTokenClient() {
  if (GIS_TOKEN_CLIENT) return GIS_TOKEN_CLIENT;
  if (!(window.google && google.accounts && google.accounts.oauth2)) {
    throw new Error('Google Identity Services script has not loaded yet — check your connection and try again.');
  }
  GIS_TOKEN_CLIENT = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: () => {} // overwritten per-request in requestDriveAccessToken()
  });
  return GIS_TOKEN_CLIENT;
}

// Resolves with { access_token, expires_in } straight from Google — used by
// reconnectGoogleDrive() below. Bypasses Firebase Auth entirely for this.
function requestDriveAccessToken() {
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = initGisTokenClient();
    } catch (err) {
      reject(err);
      return;
    }
    client.callback = (tokenResponse) => {
      if (tokenResponse && tokenResponse.access_token) resolve(tokenResponse);
      else reject(new Error((tokenResponse && tokenResponse.error) || 'No access token returned.'));
    };
    client.error_callback = (err) => reject(new Error((err && err.type) || 'Google sign-in popup failed.'));
    client.requestAccessToken({ prompt: '' });
  });
}

// Re-runs Google Drive auth purely to mint a fresh Drive access token (the
// Firebase session itself never lapsed) — used from the "Reconnect Google
// Drive" banner that shows up once the ~1hr token expires or a Drive call
// comes back 401.
//
// This used to go through fbAuth.signInWithRedirect()/signInWithPopup(),
// both of which route the OAuth result back through a cross-origin relay
// via the Firebase authDomain (yaoi-journal.firebaseapp.com, a different
// origin from this app). Confirmed live that modern Chrome's third-party
// storage partitioning breaks that relay both ways: signInWithPopup() just
// hangs (browser blocks the popup from messaging the opener), and
// signInWithRedirect() comes back via an empty getRedirectResult() (no
// user, no credential) — exactly the "banner won't clear" bug. GIS's token
// client (see requestDriveAccessToken() above) uses its own OAuth popup
// flow that never depends on that relay, so it isn't exposed to this.
async function reconnectGoogleDrive() {
  showToast('Connecting to Google Drive…');
  try {
    const tokenResponse = await requestDriveAccessToken();
    DRIVE_ACCESS_TOKEN = tokenResponse.access_token;
    const expiresInMs = tokenResponse.expires_in ? Number(tokenResponse.expires_in) * 1000 : 55 * 60 * 1000;
    DRIVE_TOKEN_EXPIRES_AT = Date.now() + Math.max(expiresInMs - 5 * 60 * 1000, 60 * 1000);
    DRIVE_NEEDS_RECONNECT = false;
    showToast('Google Drive reconnected.');
    render();
    return true;
  } catch (err) {
    console.error('Drive reconnect (GIS) failed:', err);
    showToast('Reconnect failed: ' + (err && err.message || 'unknown error'));
  }
  return false;
}

function authErrorMessage(err) {
  const code = err && err.code || '';
  if (code === 'auth/popup-blocked') return 'Your browser blocked the sign-in popup — allow popups for this site and try again.';
  if (code === 'auth/cancelled-popup-request' || code === 'auth/popup-closed-by-user') return '';
  if (code === 'auth/too-many-requests') return 'Too many attempts — wait a bit and try again.';
  if (code === 'auth/network-request-failed') return 'Network error — check your connection and try again.';
  return (err && err.message) || 'Something went wrong. Try again.';
}

async function signOutOfAccount() {
  if (FIRESTORE_UNSUB) { FIRESTORE_UNSUB(); FIRESTORE_UNSUB = null; }
  DRIVE_ACCESS_TOKEN = null;
  DRIVE_TOKEN_EXPIRES_AT = 0;
  DRIVE_FOLDER_ID = null;
  await fbAuth.signOut();
}

/* ---------------------------------------------------------------------- */
/* Render: root switch                                                    */
/* ---------------------------------------------------------------------- */

function renderLockScreen() {
  return `
    <div class="lock-screen">
      <div class="lock-screen-inner">
        <span class="lock-screen-icon">🔒</span>
        <h2>Welcome back</h2>
        <p>You stepped away for a bit — tap below to keep going.</p>
        <button class="btn-primary" data-unlock-app="1">Unlock</button>
      </div>
    </div>
  `;
}

function renderGlobalHeader(showAddEntry) {
  const needsReconnect = DRIVE_NEEDS_RECONNECT || (CURRENT_USER && !driveTokenValid());
  return `
    <div class="global-header">
      <span class="global-header-brand" data-header-home="1">
        <span class="global-header-logo">🍆</span><span class="global-header-title">Yaoi Journal</span>
      </span>
      <div class="global-search-bar">
        <span>🔍</span>
        <input type="search" id="search-input" placeholder="Search all reads &amp; anime..." value="${escapeHtml(STATE.search)}">
        ${showAddEntry ? `<button class="header-add-btn" data-add-entry="1" title="Add new entry">+</button>` : ''}
      </div>
    </div>
    ${needsReconnect ? `
      <div class="drive-reconnect-banner">
        <span>🔌 Google Drive needs reconnecting to sync images.</span>
        <button data-reconnect-drive="1">Reconnect</button>
      </div>` : ''}`;
}

async function addScreencapFiles(files) {
  const e = getEntry(STATE.entryId);
  if (!e) return;
  e.screencaps = e.screencaps || [];
  e.screencapDriveIds = e.screencapDriveIds || [];
  const newDataUrls = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const dataUrl = await fileToCompressedDataUrl(file, 900);
    e.screencaps.push(dataUrl);
    newDataUrls.push(dataUrl);
  }
  await saveEntry(e); render();
  newDataUrls.forEach((dataUrl, i) => {
    tryUploadImageToDrive(dataUrl, `${e.id}-screencap-${Date.now()}-${i}.jpg`).then((fileId) => {
      if (!fileId) return;
      const fresh = getEntry(e.id);
      if (!fresh) return;
      fresh.screencapDriveIds = fresh.screencapDriveIds || [];
      fresh.screencapDriveIds.push(fileId);
      saveEntry(fresh);
    });
  });
}

function render() {
  const root = document.getElementById('view-root');
  if (!CURRENT_USER) {
    root.innerHTML = renderAuthScreen();
    attachAuthHandlers();
    return;
  }
  if (APP_LOCKED) {
    root.innerHTML = renderLockScreen();
    const unlockBtn = root.querySelector('[data-unlock-app]');
    if (unlockBtn) unlockBtn.onclick = () => { APP_LOCKED = false; render(); };
    return;
  }
  let body = '';
  if (STATE.view === 'home') body = renderHome();
  else if (STATE.view === 'detail') body = renderDetail(getEntry(STATE.entryId));
  else if (STATE.view === 'tags') body = renderTagManager();
  else if (STATE.view === 'tagEntries') body = renderTagEntries();
  else if (STATE.view === 'hdMatch') body = renderHdMatch();
  else if (STATE.view === 'reactions') body = renderReactionsLibrary();
  else if (STATE.view === 'meme') body = renderMemeLibrary();
  else if (STATE.view === 'database') body = renderDatabase();
  else if (STATE.view === 'review') body = renderReviewQueue();
  else if (STATE.view === 'duplicates') body = renderDuplicates();
  root.innerHTML = renderGlobalHeader(STATE.view === 'home') + body;
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
    } else if (STATE.showHentaiOnly) {
      if (!isHentai(e)) return false;
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
// Whether the Tag Manager's "Show hidden tags" toggle is currently on —
// reveals the list of tags you've deleted before, each with a Restore button.
let SHOW_HIDDEN_TAGS = false;
// Tags soft-hidden via the per-tag toggle in Tag Manager — unlike
// DELETED_TAG_KEYS, the underlying entry data is untouched; the tag just
// stays off the homepage filter dropdown/tag displays until switched back on.
let USER_HIDDEN_TAG_KEYS = new Set();
// Which Tag Manager tab is showing: 'active' or 'hidden'.
let TAG_MGR_TAB = 'active';
// Signatures of hide/merge suggestions the user has dismissed ("not now"),
// so the same suggestion doesn't keep reappearing every time Tag Manager opens.
let IGNORED_TAG_SUGGESTIONS = new Set();
function isHiddenTag(t) {
  const norm = normalizeTagKey(t);
  return HIDDEN_TAG_KEYS.has(norm) || DELETED_TAG_KEYS.has(norm) || USER_HIDDEN_TAG_KEYS.has(norm);
}
async function setTagSoftHidden(name, hidden) {
  const key = normalizeTagKey(name);
  if (hidden) USER_HIDDEN_TAG_KEYS.add(key); else USER_HIDDEN_TAG_KEYS.delete(key);
  const arr = Array.from(USER_HIDDEN_TAG_KEYS);
  await idbPut(STORE_META, { key: 'userHiddenTagKeys', value: arr });
  pushMetaField('userHiddenTagKeys', arr);
}
async function dismissTagSuggestion(sig) {
  IGNORED_TAG_SUGGESTIONS.add(sig);
  const arr = Array.from(IGNORED_TAG_SUGGESTIONS);
  await idbPut(STORE_META, { key: 'ignoredTagSuggestions', value: arr });
  pushMetaField('ignoredTagSuggestions', arr);
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
async function restoreDeletedTag(key) {
  DELETED_TAG_KEYS.delete(key);
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
const HENTAI_TAG_KEY = 'hentai';
function isHentai(e) {
  return [...(e.tags || []), ...(e.customTags || [])].some((t) => normalizeTagKey(t) === HENTAI_TAG_KEY);
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

function renderCoverCard(e, reviewMode) {
  const isSuggested = !e.coverUrl && e.suggestedMatch && e.suggestedMatch.coverUrl;
  const coverSrc = e.coverUrl || (e.suggestedMatch ? e.suggestedMatch.coverUrl : null);
  const cover = coverSrc
    ? `<img src="${escapeHtml(coverSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="${isSuggested ? 'opacity:.55' : ''}" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>🍆</div>'">`
    : `<div class="cover-placeholder">🍆</div>`;
  const flagColor = e.semi && e.semi.flag ? FLAG_HEX[e.semi.flag] : (e.uke && e.uke.flag ? FLAG_HEX[e.uke.flag] : null);
  // Cards in the Suggested Matches row open the quick-review carousel modal
  // instead of the full detail page — that's the whole point of the row.
  // Top-right badge stacks favorite + hentai together (instead of the old
  // reading/watching format icon, which wasn't very useful at a glance);
  // bottom-right now shows on-HD status instead.
  const topBadges = `${e.favorite ? '💜' : ''}${isHentai(e) ? '💦' : ''}`;
  return `
    <div class="cover-card" ${reviewMode ? `data-review-match="${e.id}"` : `data-open-entry="${e.id}"`}>
      <div class="cover-thumb">
        ${cover}
        ${topBadges ? `<div class="cover-fav-badge">${topBadges}</div>` : ''}
        ${isSuggested ? '<div class="cover-fav-badge" style="right:auto;left:5px;" title="Suggested match, unconfirmed">🔎</div>' : ''}
        ${isOnDrive(e) ? '<div class="cover-format-badge" title="On HD">💾</div>' : ''}
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
  if (STATE.shelf === 'ALL' && !STATE.tagFilters.length && !STATE.search && !STATE.showFavoritesOnly && !STATE.showOnDriveOnly && !STATE.showHentaiOnly && !STATE.smutFilter && !STATE.qualityFilter && !STATE.flagFilter) {
    // Suggested-matches row sits above the shelf rows, same section-title +
    // horizontal-scroll treatment, so unconfirmed matches are easy to spot
    // and jump into without leaving the homepage.
    const suggestedGroup = entries.filter((e) => e.suggestedMatch);
    if (suggestedGroup.length > 0) {
      body += `<div class="section-title">🔎 Suggested Matches <span style="opacity:.6">(${suggestedGroup.length})</span></div>`;
      body += scrollRow('row-suggested', suggestedGroup.map((e) => renderCoverCard(e, true)).join(''));
    }
    // grouped by shelf, each group scrolls horizontally so hundreds of entries
    // don't turn into an endless vertical scroll.
    const shelvesToShow = STATE.format === 'reading' ? SHELVES_READING : ['Completed'];
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      const rowId = 'row-' + shelf.replace(/[^a-z0-9]+/gi, '-');
      body += `<div class="section-title">${escapeHtml(shelf)} <span style="opacity:.6">(${group.length})</span></div>`;
      body += scrollRow(rowId, group.map((e) => renderCoverCard(e)).join(''));
    });
    if (!body) body = `<div class="empty-state">Nothing here yet. Tap + to add a ${STATE.format === 'reading' ? 'manhwa/manga' : 'anime'}.</div>`;
  } else {
    body = entries.length
      ? `<div class="cover-grid">${entries.map((e) => renderCoverCard(e)).join('')}</div>`
      : `<div class="empty-state">No matches. Try clearing filters.</div>`;
  }

  const shelfChips = STATE.format === 'reading'
    ? ['ALL', ...SHELVES_READING].map((s) => `<div class="chip ${STATE.shelf === s ? 'active' : ''}" data-shelf="${escapeHtml(s)}">${s === 'ALL' ? 'All' : escapeHtml(s)}</div>`).join('')
    : '';
  const formatIcons = `
    <span class="rating-pick-icon format-icon-pick ${STATE.format === 'reading' ? 'active' : ''}" data-format="reading" title="Reading (Manhwa/Manga)">📖</span>
    <span class="rating-pick-icon format-icon-pick ${STATE.format === 'watching' ? 'active' : ''}" data-format="watching" title="Watching (Anime)">📺</span>
  `;

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
  // Favorites/On HD used to be separate bottom-nav destinations; they're now
  // toggle chips here instead (same nav-filter mechanism the hentai chip
  // already used), so removing them from the bottom nav doesn't lose access.
  const hentaiChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.showHentaiOnly ? 'active' : ''}" data-nav-filter="${STATE.showHentaiOnly ? 'home' : 'hentai'}" title="Hentai only">💦</span>`;
  const favoritesChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.showFavoritesOnly ? 'active' : ''}" data-nav-filter="${STATE.showFavoritesOnly ? 'home' : 'favorites'}" title="Favorites only">💜</span>`;
  const onDriveChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.showOnDriveOnly ? 'active' : ''}" data-nav-filter="${STATE.showOnDriveOnly ? 'home' : 'onDrive'}" title="On HD only">💾</span>`;

  return `
    <div class="app-header">
      <button class="filters-toggle-btn" data-toggle-filters="1">${FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters'}</button>
      <div class="filters-collapsible ${FILTERS_COLLAPSED ? 'collapsed' : ''}" id="filters-collapsible">
        <div class="filter-section-label">Status</div>
        <div class="shelf-row">${shelfChips}</div>
        <div class="filter-section-label">Tags</div>
        ${tagMultiselect}
        <div class="filter-section-label">Ratings &amp; Flags</div>
        <div class="rating-pick-row">${formatIcons}${hentaiChip}${favoritesChip}${onDriveChip}<span class="rating-pick-divider"></span>${smutChips}<span class="rating-pick-divider"></span>${qualityChips}<span class="rating-pick-divider"></span>${flagChips}</div>
      </div>
    </div>
    <main>${body}</main>
    ${renderBottomNav('home')}
  `;
}

function renderBottomNav(active) {
  return `
    <div class="bottom-nav">
      <button data-nav="home" class="${active === 'home' ? 'active' : ''}"><span class="icon">🏠</span>Journal</button>
      <button data-nav="tags" class="${active === 'tags' ? 'active' : ''}"><span class="icon">🏷️</span>Tags</button>
      <button data-nav="reactions" class="${active === 'reactions' ? 'active' : ''}"><span class="icon">🖼️</span>Images</button>
      <button data-nav="meme" class="${active === 'meme' ? 'active' : ''}"><span class="icon">🎭</span>Reactions</button>
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

// "Hide this" suggestions: active tags used on only 1-2 entries — low value
// as a filter, likely clutter. "Merge these" suggestions: pairs of active
// tags that look like the same concept (substring/near-typo match, reusing
// the same similarity check the "type a new tag" flow already uses).
// Both remember dismissals via IGNORED_TAG_SUGGESTIONS so declining one
// doesn't make it pop up again next time Tag Manager opens.
function tagHideSuggestions(activeNames, counts) {
  return activeNames
    .filter((t) => counts[t] <= 1 && !IGNORED_TAG_SUGGESTIONS.has('hide:' + normalizeTagKey(t)))
    .sort((a, b) => counts[a] - counts[b])
    .slice(0, 6)
    .map((t) => ({ type: 'hide', tag: t, count: counts[t], sig: 'hide:' + normalizeTagKey(t) }));
}
function tagMergeSuggestions(activeNames, counts) {
  const seen = new Set();
  const out = [];
  for (const a of activeNames) {
    for (const b of findSimilarTags(a)) {
      if (!activeNames.includes(b)) continue;
      const sigKey = [normalizeTagKey(a), normalizeTagKey(b)].sort().join('|');
      if (seen.has(sigKey)) continue;
      seen.add(sigKey);
      if (IGNORED_TAG_SUGGESTIONS.has('merge:' + sigKey)) continue;
      out.push({ type: 'merge', tagA: a, tagB: b, sig: 'merge:' + sigKey, combinedCount: (counts[a] || 0) + (counts[b] || 0) });
    }
  }
  return out.sort((x, y) => x.combinedCount - y.combinedCount).slice(0, 6);
}

function openTagMergeModal(sourceTag) {
  const counts = allTagCounts();
  const others = Object.keys(counts).filter((name) => name !== sourceTag).sort((a, b) => a.localeCompare(b));
  openModal(`
    <h3>Merge "${escapeHtml(sourceTag)}" into…</h3>
    <p style="font-size:11.5px;color:var(--text-dim);">Pick the tag to keep. Every entry tagged "${escapeHtml(sourceTag)}" will be retagged, and "${escapeHtml(sourceTag)}" will disappear.</p>
    <div style="display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;margin-top:10px;">
      ${others.length ? others.map((name) => `<button class="ref-btn" data-tagmgr-merge-confirm="${escapeHtml(name)}" data-tagmgr-merge-source="${escapeHtml(sourceTag)}">${escapeHtml(name)} (${counts[name]})</button>`).join('') : '<span style="font-size:12px;color:var(--text-dim);">No other tags to merge into yet.</span>'}
    </div>
    <div class="modal-actions" style="margin-top:12px;">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
    </div>
  `);
}

function renderTagManager() {
  const counts = allTagCounts();
  const allNames = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  const activeNames = allNames.filter((t) => !isHiddenTag(t));
  const hiddenActiveNames = allNames.filter((t) => USER_HIDDEN_TAG_KEYS.has(normalizeTagKey(t)) && !DELETED_TAG_KEYS.has(normalizeTagKey(t)));
  const names = TAG_MGR_TAB === 'hidden' ? hiddenActiveNames : activeNames;

  const hideSuggestions = TAG_MGR_TAB === 'active' ? tagHideSuggestions(activeNames, counts) : [];
  const mergeSuggestions = TAG_MGR_TAB === 'active' ? tagMergeSuggestions(activeNames, counts) : [];
  const suggestionsHtml = (hideSuggestions.length || mergeSuggestions.length) ? `
    <div class="panel" style="border-color:var(--yellow-soft);">
      <div class="panel-title" data-tag-suggestions-toggle="1" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;">💡 Suggestions <span style="font-size:11px;">${TAG_SUGGESTIONS_OPEN ? '▲ Hide' : '▼ Show'}</span></div>
      ${TAG_SUGGESTIONS_OPEN ? `
      ${hideSuggestions.map((s) => `
        <div class="tag-suggestion-row">
          <div>Hide <strong>${escapeHtml(s.tag)}</strong> — only ${s.count} use${s.count === 1 ? '' : 's'}</div>
          <div class="tag-suggestion-actions">
            <button class="ref-btn" data-suggest-hide="${escapeHtml(s.tag)}" data-suggest-sig="${escapeHtml(s.sig)}">Hide</button>
            <button class="btn-ghost" data-suggest-dismiss="${escapeHtml(s.sig)}">Not now</button>
          </div>
        </div>`).join('')}
      ${mergeSuggestions.map((s) => `
        <div class="tag-suggestion-row">
          <div>Merge <strong>${escapeHtml(s.tagB)}</strong> into <strong>${escapeHtml(s.tagA)}</strong>?</div>
          <div class="tag-suggestion-actions">
            <button class="ref-btn" data-suggest-merge-a="${escapeHtml(s.tagA)}" data-suggest-merge-b="${escapeHtml(s.tagB)}" data-suggest-sig="${escapeHtml(s.sig)}">Merge</button>
            <button class="btn-ghost" data-suggest-dismiss="${escapeHtml(s.sig)}">Not now</button>
          </div>
        </div>`).join('')}
      ` : ''}
    </div>` : '';

  const rows = TAG_MGR_TAB === 'active'
    ? names.map((t) => `
        <div class="tagmgr-row" data-tag-name="${escapeHtml(t)}">
          <div class="tagmgr-click-area" data-tagmgr-view="${escapeHtml(t)}" title="View entries tagged &quot;${escapeHtml(t)}&quot;">
            <div class="tagmgr-name">${escapeHtml(t)}</div>
            <div class="tagmgr-count">${counts[t]} entr${counts[t] === 1 ? 'y' : 'ies'}</div>
          </div>
          <div class="tagmgr-actions">
            <button class="toggle-switch on" data-tagmgr-hide="${escapeHtml(t)}" title="Hide from filters (keeps the data)" role="switch" aria-checked="true"><span class="toggle-knob"></span></button>
            <button class="icon-btn-inline" data-tagmgr-merge="${escapeHtml(t)}" title="Merge this tag into another">🔀</button>
            <button class="icon-btn-inline" data-tagmgr-rename="${escapeHtml(t)}" title="Rename this tag everywhere">✏️</button>
            <button class="icon-btn-inline" data-tagmgr-delete="${escapeHtml(t)}" title="Delete this tag everywhere">🗑️</button>
          </div>
        </div>`).join('')
    : names.map((t) => `
        <div class="tagmgr-row" data-tag-name="${escapeHtml(t)}">
          <div class="tagmgr-click-area" data-tagmgr-view="${escapeHtml(t)}" title="View entries tagged &quot;${escapeHtml(t)}&quot;">
            <div class="tagmgr-name">${escapeHtml(t)}</div>
            <div class="tagmgr-count">${counts[t]} entr${counts[t] === 1 ? 'y' : 'ies'}</div>
          </div>
          <div class="tagmgr-actions">
            <button class="toggle-switch" data-tagmgr-hide="${escapeHtml(t)}" title="Show in filters again" role="switch" aria-checked="false"><span class="toggle-knob"></span></button>
          </div>
        </div>`).join('');

  const deletedRows = TAG_MGR_TAB === 'hidden' && DELETED_TAG_KEYS.size ? `
    <div class="panel-title" style="margin:16px 0 8px;">Permanently deleted</div>
    <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">These had their data removed from every entry — restoring just allows the name to be used again; old entries won't get it back.</div>
    ${Array.from(DELETED_TAG_KEYS).sort().map((key) => `
      <div class="tagmgr-row">
        <div class="tagmgr-name" style="flex:1;">${escapeHtml(key)}</div>
        <button class="ref-btn" data-restore-tag="${escapeHtml(key)}">Allow again</button>
      </div>`).join('')}
  ` : '';

  const tabsHtml = `
    <div class="tagmgr-tabs">
      <button class="tagmgr-tab ${TAG_MGR_TAB === 'active' ? 'active' : ''}" data-tagmgr-tab="active">Active (${activeNames.length})</button>
      <button class="tagmgr-tab ${TAG_MGR_TAB === 'hidden' ? 'active' : ''}" data-tagmgr-tab="hidden">Hidden (${hiddenActiveNames.length + DELETED_TAG_KEYS.size})</button>
    </div>`;

  return `
    <div class="app-header">
      <div class="brand-row"><h1>🏷️ Manage Tags</h1></div>
      <div class="search-bar"><span>🔍</span><input type="search" id="tagmgr-search" placeholder="Filter tags..."></div>
    </div>
    <main>
      <button class="ref-btn" style="width:100%;margin-bottom:12px;" data-nav="hdMatch">💾 Match Owned Titles from a List</button>
      <div style="color:var(--text-dim);font-size:12px;margin-bottom:10px;">
        ${allNames.length} unique tag${allNames.length === 1 ? '' : 's'} across ${ALL_ENTRIES.length} entries. Tap a tag to see its entries. Renaming applies everywhere the tag is used — rename to an existing tag name to merge two tags together. Deleting removes it from every entry (can't be undone); hiding just keeps it out of filters.
      </div>
      ${suggestionsHtml}
      ${tabsHtml}
      <div id="tagmgr-list">${rows || `<div class="empty-state">${TAG_MGR_TAB === 'hidden' ? 'No hidden tags.' : 'No tags yet.'}</div>`}</div>
      ${deletedRows}
    </main>
    ${renderBottomNav('tags')}
  `;
}

function renderTagEntries() {
  const t = TAG_ENTRIES_FILTER;
  const entries = t ? ALL_ENTRIES.filter((e) => (e.tags || []).concat(e.customTags || []).includes(t)) : [];
  const body = entries.length
    ? `<div class="cover-grid">${entries.map((e) => renderCoverCard(e)).join('')}</div>`
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

// Every image in the app, in one place: the standalone reaction/meme
// library PLUS any image uploaded straight onto an entry's own Images
// panel. Images are keyed by their exact data-URL so the same picture
// only shows once even if it's attached to several entries.
function entryImageUrls(e) {
  return [...(e.screencaps || []), e.semi && e.semi.photo, e.uke && e.uke.photo].filter(Boolean);
}

// Images = only pictures that live on a journal entry (screencaps, semi/uke
// photos) — always attached to a read, by definition. The standalone meme
// library (bottom-nav "Reactions") is a completely separate collection, kept
// out of this aggregation, since reactions are meant to stay unattached to
// any specific entry and organized by mood tag instead (see renderMemeLibrary).
function allAppImages() {
  const map = new Map();
  ALL_ENTRIES.forEach((e) => {
    entryImageUrls(e).forEach((src) => {
      if (!map.has(src)) map.set(src, { dataUrl: src, reactionId: null, createdAt: e.updatedAt || e.createdAt });
    });
  });
  return Array.from(map.values())
    .map((img) => ({ ...img, attachedEntries: ALL_ENTRIES.filter((e) => entryImageUrls(e).includes(img.dataUrl)) }))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

// Perceptual (average) hash — resizes to a tiny 8x8 grayscale grid and
// records which pixels are above/below the average brightness. Two images
// that look the same but were saved/compressed differently (so their raw
// data-URL bytes differ) still end up with the same or a very close hash,
// which is what lets "Possible Duplicates" catch real dupes instead of just
// exact byte-for-byte matches (those are already deduped by data-URL).
const IMAGE_PHASH_CACHE = new Map();
function perceptualHash(dataUrl) {
  if (IMAGE_PHASH_CACHE.has(dataUrl)) return Promise.resolve(IMAGE_PHASH_CACHE.get(dataUrl));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 8;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const gray = [];
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
          gray.push(g);
          total += g;
        }
        const avg = total / gray.length;
        const hash = gray.map((g) => (g >= avg ? '1' : '0')).join('');
        IMAGE_PHASH_CACHE.set(dataUrl, hash);
        resolve(hash);
      } catch (err) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

let IMAGES_TAB = 'attached'; // 'attached' | 'unattached' | 'duplicates'
let IMAGE_DUP_GROUPS = null; // null = not scanned yet this session
let IMAGE_DUP_SCANNING = false;
async function scanForImageDuplicates() {
  IMAGE_DUP_SCANNING = true;
  render();
  const items = allAppImages();
  const withHashes = [];
  for (const img of items) {
    const hash = await perceptualHash(img.dataUrl);
    withHashes.push({ img, hash });
  }
  const groups = [];
  const used = new Set();
  for (let i = 0; i < withHashes.length; i++) {
    if (used.has(i) || !withHashes[i].hash) continue;
    const group = [withHashes[i].img];
    used.add(i);
    for (let j = i + 1; j < withHashes.length; j++) {
      if (used.has(j) || !withHashes[j].hash) continue;
      if (hammingDistance(withHashes[i].hash, withHashes[j].hash) <= 6) {
        group.push(withHashes[j].img);
        used.add(j);
      }
    }
    if (group.length > 1) groups.push(group);
  }
  IMAGE_DUP_GROUPS = groups;
  IMAGE_DUP_SCANNING = false;
  render();
}

function renderReactionsLibrary() {
  const items = allAppImages();
  const attached = items.filter((i) => i.attachedEntries.length > 0);
  const unattached = items.filter((i) => i.attachedEntries.length === 0);

  const masonryItem = (img) => `
    <div class="masonry-item" data-view-image-attachments="${escapeHtml(img.dataUrl)}">
      <img src="${img.dataUrl}" alt="" loading="lazy">
      ${img.attachedEntries.length ? `<span class="reaction-count">${img.attachedEntries.length}</span>` : ''}
      ${img.reactionId ? `<button class="del" data-del-reaction="${img.reactionId}">✕</button>` : ''}
    </div>`;

  let tabBody;
  if (IMAGES_TAB === 'unattached') {
    tabBody = unattached.length ? `<div class="image-masonry">${unattached.map(masonryItem).join('')}</div>` : `<div class="empty-state">Everything's attached to a read. 🎉</div>`;
  } else if (IMAGES_TAB === 'duplicates') {
    if (IMAGE_DUP_SCANNING) {
      tabBody = `<div class="empty-state">Scanning ${items.length} images for duplicates…</div>`;
    } else if (IMAGE_DUP_GROUPS === null) {
      tabBody = `<div style="padding:8px 0;"><button class="btn-primary" style="width:100%;" data-scan-duplicates="1">🔍 Scan for possible duplicates</button></div>`;
    } else if (!IMAGE_DUP_GROUPS.length) {
      tabBody = `<div class="empty-state">No possible duplicates found. 🎉</div><button class="ref-btn" style="width:100%;" data-scan-duplicates="1">Scan again</button>`;
    } else {
      tabBody = `<button class="ref-btn" style="width:100%;margin-bottom:10px;" data-scan-duplicates="1">Scan again</button>` +
        IMAGE_DUP_GROUPS.map((group) => `
          <div class="panel">
            <div class="panel-title">Possible duplicate (${group.length} images)</div>
            <div class="image-masonry">${group.map(masonryItem).join('')}</div>
          </div>`).join('');
    }
  } else {
    tabBody = attached.length ? `<div class="image-masonry">${attached.map(masonryItem).join('')}</div>` : `<div class="empty-state">No attached images yet.</div>`;
  }

  return `
    <div class="app-header">
      <div class="brand-row"><h1>🖼️ Images</h1></div>
      <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">${items.length} image${items.length === 1 ? '' : 's'} across the app. Tap one to see which reads it's attached to.</div>
      <label class="upload-btn">📎 Add image(s)<input type="file" accept="image/*,video/*" multiple id="reaction-upload-input"></label>
      <div class="tagmgr-tabs" style="margin-top:10px;">
        <button class="tagmgr-tab ${IMAGES_TAB === 'attached' ? 'active' : ''}" data-images-tab="attached">Attached (${attached.length})</button>
        <button class="tagmgr-tab ${IMAGES_TAB === 'unattached' ? 'active' : ''}" data-images-tab="unattached">Unattached (${unattached.length})</button>
        <button class="tagmgr-tab ${IMAGES_TAB === 'duplicates' ? 'active' : ''}" data-images-tab="duplicates">Possible Duplicates</button>
      </div>
    </div>
    <main>${tabBody}</main>
    ${renderBottomNav('reactions')}
  `;
}

// A screencap already saved on this entry can also double as a Reactions-
// library item — toggled from within the lightbox itself so you don't have
// to leave the read to go re-upload the same picture over in Reactions.
function renderScreencapLightbox(src) {
  const isReaction = ALL_REACTIONS.some((r) => r.dataUrl === src);
  openImageLightbox(src, `
    <div class="lightbox-actions">
      <button class="reaction-toggle-btn ${isReaction ? 'on' : 'off'}" data-toggle-use-as-reaction="${escapeHtml(src)}">
        Use as reaction? ${isReaction ? '✅' : '❌'}
      </button>
    </div>`);
}

function openImageAttachmentsModal(dataUrl) {
  const entries = ALL_ENTRIES.filter((e) => entryImageUrls(e).includes(dataUrl));
  const candidates = ALL_ENTRIES.filter((e) => !entryImageUrls(e).includes(dataUrl)).slice().sort((a, b) => a.title.localeCompare(b.title));
  const resultsHtml = (list) => list.length
    ? list.slice(0, 30).map((e) => `<button class="ref-btn" style="text-align:left;" data-attach-image-to-entry="${e.id}" data-attach-image-src="${escapeHtml(dataUrl)}">${escapeHtml(e.title)}</button>`).join('')
    : '<div class="empty-state" style="padding:6px 0;">No matches.</div>';
  openImageLightbox(dataUrl, `
    <div class="lightbox-actions">
      <div class="panel-title" style="margin-top:0;">Attached to</div>
      ${entries.length
         ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">${entries.map((e) => `
            <button class="ref-btn" style="text-align:left;" data-goto-entry-from-modal="${e.id}">${escapeHtml(e.title)}</button>`).join('')}</div>`
        : `<div class="empty-state" style="padding:6px 0 14px;">Not attached to any read yet.</div>`}
      <div class="panel-title">Attach to another read</div>
      <input type="text" id="image-attach-search-input" placeholder="Search titles..." style="width:100%;margin-bottom:8px;">
      <div id="image-attach-results" style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;">
        ${resultsHtml(candidates)}
      </div>
    </div>`);
  const searchInput = document.getElementById('image-attach-search-input');
  if (searchInput) searchInput.oninput = () => {
    const q = searchInput.value.trim().toLowerCase();
    const filtered = candidates.filter((e) => e.title.toLowerCase().includes(q));
    const resultsEl = document.getElementById('image-attach-results');
    if (resultsEl) resultsEl.innerHTML = resultsHtml(filtered);
  };
}

/* ---------------------------------------------------------------------- */
/* MEME / REACTION LIBRARY (bottom-nav "Reactions")                       */
/* A personal, standalone collection of memes/reaction images — always     */
/* organized by mood tag rather than attached to any specific journal      */
/* entry (that's what the Images tab is for). Filter by mood, search by    */
/* caption/keywords, Giphy-style.                                         */
/* ---------------------------------------------------------------------- */

const MOOD_OPTIONS = [
  { key: 'angry', emoji: '😡', label: 'Angry' },
  { key: 'funny', emoji: '😂', label: 'Funny' },
  { key: 'horny', emoji: '🍆', label: 'Horny' },
  { key: 'confused', emoji: '😵‍💫', label: 'Confused' },
];
let MEME_STATE = { groupFilter: null, search: '' };
let REACTION_GROUPS = [];

// A reaction can belong to more than one grouping/mood now. Older saved
// reactions only ever had a single r.groupId string, so this falls back to
// that for backward compatibility without needing a data migration.
function reactionGroupIds(r) {
  if (r.groupIds && r.groupIds.length) return r.groupIds;
  return r.groupId ? [r.groupId] : [];
}

function memeFilteredItems() {
  const q = MEME_STATE.search.trim().toLowerCase();
  // Untagged reactions surface first (so they get organized sooner), then
  // everything else follows in upload order (oldest added first).
  let items = ALL_REACTIONS.slice().sort((a, b) => {
    const aUntagged = !reactionGroupIds(a).length;
    const bUntagged = !reactionGroupIds(b).length;
    if (aUntagged !== bUntagged) return aUntagged ? -1 : 1;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
  if (MEME_STATE.groupFilter) items = items.filter((r) => reactionGroupIds(r).includes(MEME_STATE.groupFilter));
  if (q) items = items.filter((r) => (r.note || '').toLowerCase().includes(q));
  return items;
}

function renderMemeGrid() {
  const items = memeFilteredItems();
  return items.length
    ? `<div class="image-masonry">${items.map((r) => `
        <div class="masonry-item" data-open-meme="${r.id}">
          ${r.mediaType === 'video'
            ? `<video src="${r.dataUrl}" autoplay muted loop playsinline></video>`
            : `<img src="${r.dataUrl}" alt="" loading="lazy">`}
          ${!reactionGroupIds(r).length ? `<span class="reaction-count" style="background:rgba(200,60,60,.85);">Untagged</span>` : ''}
        </div>`).join('')}</div>`
    : `<div class="empty-state">No reactions match. ${MEME_STATE.moodFilter || MEME_STATE.search ? 'Try clearing the filter/search.' : 'Tap "Add" to upload your first meme.'}</div>`;
}

function renderMemeLibraryInPlace() {
  const main = document.querySelector('#view-root main');
  if (main) main.innerHTML = renderMemeGrid();
  attachMemeGridHandlers();
}

function renderMemeLibrary() {
  const untaggedCount = ALL_REACTIONS.filter((r) => !reactionGroupIds(r).length).length;
  const groupChips = REACTION_GROUPS.map((g) => `<span class="rating-pick-icon flag-filter-icon ${MEME_STATE.groupFilter === g.id ? 'active' : ''}" style="width:auto;min-width:28px;padding:0 10px;white-space:nowrap;" data-meme-group-filter="${g.id}" title="Filter: ${escapeHtml(g.title)}">${escapeHtml(g.title)}</span>`).join('');
  return `
    <div class="app-header">
      <div class="brand-row"><h1>🎭 Reactions</h1></div>
      <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">${ALL_REACTIONS.length} meme${ALL_REACTIONS.length === 1 ? '' : 's'} saved${untaggedCount ? ` · ${untaggedCount} untagged` : ''}.</div>
      <label class="upload-btn" style="margin-bottom:10px;">📎 Add reaction(s)<input type="file" accept="image/*,video/*" multiple id="meme-upload-input"></label>
      <div class="search-bar" style="margin-bottom:8px;"><span>🔍</span><input type="search" id="meme-search-input" placeholder="Search captions/keywords..." value="${escapeHtml(MEME_STATE.search)}"></div>
      <div class="rating-pick-row">${groupChips}<span class="rating-pick-icon flag-filter-icon" style="width:auto;padding:0 10px;" data-add-reaction-group="1" title="New grouping">➕</span></div>
    </div>
    <main>${renderMemeGrid()}</main>
    ${renderBottomNav('meme')}
  `;
}

function attachMemeGridHandlers() {
  document.querySelectorAll('[data-open-meme]').forEach((el) => {
    el.onclick = () => openMemeEditModal(el.getAttribute('data-open-meme'));
  });
}

function openCreateReactionGroupModal() {
  openModal(`
    <h3>New reaction grouping</h3>
    <div class="field-row"><label>Title (text or emoji)</label><input type="text" id="new-group-title-input" placeholder="e.g. 😭 or Crying" maxlength="24"></div>
    <div class="modal-actions">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
      <button class="btn-primary" data-create-reaction-group="1">Create</button>
    </div>
  `);
  setTimeout(() => {
    const el = document.getElementById('new-group-title-input');
    if (el) el.focus();
  }, 30);
}

function openMemeEditModal(id) {
  const r = ALL_REACTIONS.find((x) => x.id === id);
  if (!r) return;
  openModal(`
    <h3>Edit reaction</h3>
    ${r.mediaType === 'video'
      ? `<video src="${r.dataUrl}" autoplay muted loop playsinline controls style="width:100%;max-height:220px;object-fit:contain;border-radius:10px;margin-bottom:10px;"></video>`
      : `<img src="${r.dataUrl}" alt="" style="width:100%;max-height:220px;object-fit:contain;border-radius:10px;margin-bottom:10px;">`}
    <div class="field-row"><label>Caption/keywords (for search)</label><input type="text" id="meme-note-input" value="${escapeHtml(r.note || '')}" placeholder="e.g. blushing, screaming, oh no"></div>
    <div class="field-row">
      <label>Mood ${reactionGroupIds(r).length ? '' : '<span style="font-weight:400;color:var(--text-dim);">(none yet)</span>'}</label>
      <div style="font-size:11px;color:var(--text-dim);margin:2px 0 4px;">${REACTION_GROUPS.length ? 'Tap any that apply — you can pick more than one.' : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
        ${REACTION_GROUPS.length ? REACTION_GROUPS.map((g) => `<button class="mood-chip ${reactionGroupIds(r).includes(g.id) ? 'active' : ''}" data-meme-toggle-group="${g.id}" data-meme-id="${r.id}">${escapeHtml(g.title)}</button>`).join('') : '<span style="font-size:12px;color:var(--text-dim);">No groupings yet — tap the ➕ in the Reactions header to create one.</span>'}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" data-delete-meme="${r.id}">🗑️ Delete</button>
      <button class="btn-primary" data-close-modal="1">Done</button>
    </div>
  `);
  const noteInput = document.getElementById('meme-note-input');
  if (noteInput) noteInput.onblur = async () => {
    const rr = ALL_REACTIONS.find((x) => x.id === id);
    if (rr) { rr.note = noteInput.value; await saveReaction(rr); }
  };
}

// Uploads into the standalone meme/reaction library (bottom-nav "Reactions").
// These are never attached to a specific journal entry — just organized by
// mood tag and searched by caption/keywords, Giphy-style.
async function addReactionFiles(fileList) {
  const added = [];
  for (const file of fileList) {
    const isVideo = file.type.startsWith('video/');
    const isGif = file.type === 'image/gif';
    const mediaType = isVideo ? 'video' : (isGif ? 'gif' : 'image');
    // Animated GIFs and videos can't go through the canvas-based compressor
    // below — canvas would flatten a GIF to a single static frame, and an
    // <img> can't decode video at all — so store those as-is to keep them
    // animating/playing.
    const dataUrl = mediaType === 'image' ? await fileToCompressedDataUrl(file, 800) : await fileToDataUrl(file);
    const hash = await hashDataUrl(dataUrl);
    const dupe = findReactionByHash(hash);
    if (dupe) {
      if (!confirm('This looks like a duplicate of a reaction/meme you already saved. Add it again anyway?')) continue;
    }
    const reaction = { id: uid('reaction'), dataUrl, hash, mediaType, moodTags: [], note: '', createdAt: new Date().toISOString() };
    await saveReaction(reaction);
    added.push(reaction);
    const ext = mediaType === 'video' ? ((file.name || '').split('.').pop() || 'mp4') : (mediaType === 'gif' ? 'gif' : 'jpg');
    tryUploadImageToDrive(dataUrl, `reaction-${reaction.id}.${ext}`).then((fileId) => {
      if (!fileId) return;
      const fresh = ALL_REACTIONS.find((r) => r.id === reaction.id);
      if (!fresh) return;
      fresh.driveId = fileId;
      saveReaction(fresh);
    });
  }
  return added;
}

function openReactionPickerModal(entryId) {
  const items = ALL_REACTIONS.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  openModal(`
    <h3>🖼️ Add from Images</h3>
    <p style="font-size:12px;color:var(--text-dim);">Tap to select, then Add. Or upload a brand-new one straight into this entry.</p>
    <label class="upload-btn" style="margin-bottom:10px;">📎 Upload new<input type="file" accept="image/*" multiple id="reaction-picker-upload"></label>
    <div class="reaction-picker-grid" id="reaction-picker-grid">
      ${items.length ? items.map((r) => `<div class="reaction-thumb pickable" data-pick-reaction="${r.id}"><img src="${r.dataUrl}" alt=""></div>`).join('') : '<div class="empty-state">No images saved yet — upload one above.</div>'}
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

// Shared by the detail page's own "Use match"/"Dismiss" buttons and the
// quick-review carousel (openMatchReviewCarousel) — takes an entryId
// directly instead of always implicitly acting on STATE.entryId, so the
// carousel can apply/dismiss without navigating to each entry's full page.
async function applySuggestedMatch(entryId) {
  const e = getEntry(entryId);
  const sm = e && e.suggestedMatch;
  if (!sm) return false;
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
  e.suggestedMatchDismissed = false;
  await saveEntry(e);
  return true;
}
// Marks the entry so the nightly/manual auto-match sweep won't just turn
// around and re-suggest the exact same match again (this used to be the
// cause of "why do I keep seeing the same suggested match" on other
// devices — the sweep only checked `!e.suggestedMatch`, which a dismissal
// satisfies, so it re-searched and found the same result next time it ran).
async function dismissSuggestedMatch(entryId) {
  const e = getEntry(entryId);
  if (!e) return;
  e.suggestedMatch = null;
  e.suggestedMatchDismissed = true;
  await saveEntry(e);
}

/* ---------------------------------------------------------------------- */
/* Quick-review carousel — a single modal that steps through a queue of    */
/* entries one at a time (Suggested Matches on the homepage, or "missing   */
/* cover/reference" entries in Database review) so you can confirm/reject  */
/* or cross-reference each one and move straight to the next without       */
/* opening and closing each entry's full detail page.                     */
/* ---------------------------------------------------------------------- */
let MATCH_REVIEW_QUEUE = [];
let MATCH_REVIEW_INDEX = 0;

function openMatchReviewCarousel(startEntryId) {
  MATCH_REVIEW_QUEUE = ALL_ENTRIES.filter((e) => e.suggestedMatch).map((e) => e.id);
  if (!MATCH_REVIEW_QUEUE.length) { showToast('No suggested matches to review'); return; }
  const startIdx = MATCH_REVIEW_QUEUE.indexOf(startEntryId);
  MATCH_REVIEW_INDEX = startIdx > -1 ? startIdx : 0;
  renderMatchReviewModal();
}

function renderMatchReviewModal() {
  if (!MATCH_REVIEW_QUEUE.length) { closeModal(); render(); return; }
  if (MATCH_REVIEW_INDEX >= MATCH_REVIEW_QUEUE.length) MATCH_REVIEW_INDEX = MATCH_REVIEW_QUEUE.length - 1;
  const entryId = MATCH_REVIEW_QUEUE[MATCH_REVIEW_INDEX];
  const e = getEntry(entryId);
  if (!e || !e.suggestedMatch) {
    // Handled elsewhere already (or deleted) since the queue was built — drop it and move on.
    MATCH_REVIEW_QUEUE.splice(MATCH_REVIEW_INDEX, 1);
    renderMatchReviewModal();
    return;
  }
  const sm = e.suggestedMatch;
  openModal(`
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">Suggested Match Review — ${MATCH_REVIEW_INDEX + 1} of ${MATCH_REVIEW_QUEUE.length}</div>
    <h3 style="margin:0 0 8px;">${escapeHtml(e.title)}</h3>
    <div class="match-preview compact">
      ${sm.coverUrl ? `<img src="${escapeHtml(sm.coverUrl)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
      <div class="info">
        <strong>${escapeHtml(sm.title || e.title)}</strong>
        ${sm.altTitle ? escapeHtml(sm.altTitle) + '<br>' : ''}
        ${sm.author ? 'By ' + escapeHtml(sm.author) + '<br>' : ''}
        <p style="margin:6px 0 0;">${escapeHtml((sm.summary || '').slice(0, 200))}${(sm.summary || '').length > 200 ? '…' : ''}</p>
      </div>
    </div>
    ${sm.url ? `<div style="margin:6px 0;"><a href="${escapeHtml(sm.url)}" target="_blank" style="font-size:11px;">View on ${escapeHtml(sm.site || 'Anime-Planet')} ↗</a></div>` : ''}
    <div class="modal-actions">
      <button class="btn-ghost" data-carousel-dismiss="1">✗ Dismiss</button>
      <button class="btn-primary" data-carousel-use="1">✓ Use match</button>
    </div>
    <div style="display:flex;justify-content:space-between;gap:6px;margin-top:10px;">
      <button class="ref-btn" data-carousel-prev="1" ${MATCH_REVIEW_INDEX === 0 ? 'disabled' : ''}>‹ Prev</button>
      <button class="ref-btn" data-carousel-open-full="${e.id}">Open full page</button>
      <button class="ref-btn" data-carousel-next="1" ${MATCH_REVIEW_INDEX >= MATCH_REVIEW_QUEUE.length - 1 ? 'disabled' : ''}>Next ›</button>
    </div>
  `);
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
      <div class="field-row"><label>Title</label><div class="value plain">${escapeHtml(e.title)}</div></div>
      ${e.altTitle ? `<div class="field-row"><label>Alt title</label><div class="value plain">${escapeHtml(e.altTitle)}</div></div>` : ''}
      ${(e.isNovel || e.novelAuthor) ? `<div class="field-row"><label>Novel</label><div class="value plain">${escapeHtml(formatNames(e.novelAuthor)) || '—'}</div></div>` : ''}
      <div class="field-row"><label>Author</label><div class="value plain">${escapeHtml(formatNames(e.author)) || '—'}</div></div>
      <div class="field-row"><label>Artist</label><div class="value plain">${escapeHtml(formatNames(e.artist)) || '—'}</div></div>
      ${e.totalChapters ? `<div class="field-row"><label>Chapters</label><div class="value plain">${e.totalChapters}</div></div>` : ''}
      ${e.totalSeasons ? `<div class="field-row"><label>Seasons</label><div class="value plain">${e.totalSeasons}</div></div>` : ''}
      <div class="field-row"><label>Status</label><div class="value plain">${escapeHtml(e.status) || '—'}</div></div>
    ` : `
      <div class="field-row"><label>Title</label><div class="value plain">${escapeHtml(e.title)}</div></div>
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
      <button class="icon-btn" data-toggle-fav="1" title="Favorite">${e.favorite ? '💜' : '🤍'}</button>
      <button class="icon-btn" data-toggle-hd="1" title="On HD">${isOnDrive(e) ? '💾' : '🗄️'}</button>
      <button class="icon-btn" data-force-save="1" title="Save now">✅</button>
      <button class="icon-btn" data-merge-entry="${e.id}" title="Mark as duplicate / merge into another entry">🔀</button>
      <button class="icon-btn danger" data-delete-entry="${e.id}" title="Delete this entry">✕</button>
    </div>
    <div class="journal">

      <!-- 1. Cover + details -->
      <div class="panel">
        <div class="panel-title-row" style="margin-bottom:8px;">
          <div class="panel-title" style="margin:0;">Details</div>
          ${!DETAIL_EDIT_MODE ? `<button class="icon-btn-inline" data-edit-toggle="1" title="Edit details">✏️</button>` : ''}
        </div>
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
            </div>
            <label class="char-photo-slot" style="cursor:pointer;">
              ${renderCharPhoto(e.semi.photo)}
              <input type="file" accept="image/*" style="display:none" data-char-photo="semi">
            </label>
            <div class="flag-picker">${renderFlagPicker(e.semi.flag, 'semi')}</div>
            <textarea placeholder="Notes on the semi..." data-char-notes="semi">${escapeHtml(e.semi.notes)}</textarea>
          </div>
          <div class="char-col">
            <div class="char-col-head">
              <h4>Uke (Bottom)</h4>
            </div>
            <label class="char-photo-slot" style="cursor:pointer;">
              ${renderCharPhoto(e.uke.photo)}
              <input type="file" accept="image/*" style="display:none" data-char-photo="uke">
            </label>
            <div class="flag-picker">${renderFlagPicker(e.uke.flag, 'uke')}</div>
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

      <!-- 7. Images (screencaps, character photos — always attached to this read) -->
      <div class="panel">
        <div class="panel-title">Images</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
          <label class="upload-btn" style="flex:1;">📎 Add photo(s)<input type="file" accept="image/*" multiple id="screencap-input"></label>
        </div>
        <div class="screencap-grid" data-screencap-dropzone="1">
          ${(e.screencaps || []).length
            ? (e.screencaps || []).map((src, i) => `<div class="screencap-thumb"><img src="${src}" data-view-screencap="${i}"><button class="del" data-del-screencap="${i}">✕</button></div>`).join('')
            : '<div class="screencap-drop-hint">Drag &amp; drop images here, or use Add photo(s) above</div>'}
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
      <div class="brand-row">
        <h1>🗂️ Database Mode</h1>
      </div>
      <div class="search-bar"><span>🔍</span><input type="search" id="db-search" placeholder="Filter table..."></div>
    </div>
    <main>
      <div class="account-panel" style="margin-bottom:14px;">
        <div class="account-info">
          <div class="account-label">Synced account</div>
          <div class="account-email">${escapeHtml(CURRENT_USER ? CURRENT_USER.email : '')}</div>
        </div>
        <button class="icon-btn-inline" data-sign-out="1" title="Sign out">Sign Out</button>
      </div>
      <div class="panel" style="margin-bottom:14px;">
        <div class="panel-title">Data Cleanup Tools</div>
        <div class="export-row">
          <button class="ref-btn" data-nav="review">🔎 Review missing cover/reference (${reviewCount})</button>
          <button class="ref-btn" data-nav="duplicates">🧬 Review duplicates (${dupCount})</button>
        </div>
        ${BULK_SWEEP.running ? `
          <div class="export-row" style="margin-top:8px;">
            <div style="flex:1;font-size:12.5px;color:var(--text-dim);">🔄 Checking ${BULK_SWEEP.checked}/${BULK_SWEEP.total} against Anime-Planet/MangaGo — ${BULK_SWEEP.found} found so far</div>
            <button class="ref-btn" data-stop-bulk-sweep="1">Stop</button>
          </div>
        ` : `
          <div class="export-row" style="margin-top:8px;">
            <button class="ref-btn" data-run-bulk-sweep="1">🚀 Run match sweep now (${bulkSweepCandidates().length} unmatched)</button>
          </div>
          <p style="font-size:11px;color:var(--text-dim);margin:6px 0 0;">Searches Anime-Planet/MangaGo for every unmatched entry in one pass instead of the usual 20-a-day auto-sweep — paced to be gentle on the proxy, so it can take a while for a big backlog. Requires a proxy URL in Settings.</p>
        `}
      </div>
      <div class="panel" style="margin-bottom:14px;">
        <div class="panel-title" data-toggle-db-settings="1" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;">⚙️ Settings <span style="font-size:11px;">${DB_SETTINGS_OPEN ? '▲ Hide' : '▼ Show'}</span></div>
        ${DB_SETTINGS_OPEN ? `
        <div class="field-row">
          <label>Cross-reference proxy URL (your Apps Script web app URL)</label>
          <input type="text" id="proxy-url-input" value="${escapeHtml(getProxyUrl())}" placeholder="https://script.google.com/macros/s/.../exec">
        </div>
        <p style="font-size:11.5px;color:var(--text-dim);">This is only used when you tap "Cross-reference" on an entry — it fetches the Anime-Planet page server-side so the app can read the summary/cover. No reading data is ever sent out.</p>
        <div class="modal-actions">
          <button class="btn-primary" data-save-settings-inline="1">Save</button>
        </div>
        <div style="border-top:1px solid var(--border);margin-top:16px;padding-top:14px;">
          <div class="panel-title" style="margin-bottom:6px;">📋 Get Info button</div>
          <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 10px;">You'll only need this occasionally — mainly when adding a brand-new title, or when cleaning up entries in Database mode. It's a free workaround for when the automatic fetch fails.</p>
          <p style="font-size:12px;font-weight:600;margin:0 0 4px;">Set up once:</p>
          <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 4px;"><strong>On a computer:</strong> drag this button up to your bookmarks bar. <a href="${bookmarkletHref()}" class="ref-btn" style="display:inline-block;text-decoration:none;">💾 Get Info</a></p>
          <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 8px;"><strong>On a phone:</strong> save any page as a bookmark, then open that bookmark's settings and paste the code below over its URL.</p>
          <textarea readonly style="width:100%;height:60px;font-size:10px;font-family:monospace;" onclick="this.select()">${escapeHtml(bookmarkletHref())}</textarea>
          <p style="font-size:12px;font-weight:600;margin:10px 0 4px;">Each time you need it:</p>
          <ol style="font-size:11.5px;color:var(--text-dim);margin:0 0 0 18px;padding:0;">
            <li>Open the title's page on Anime-Planet or MangaGo.</li>
            <li>Tap your "Get Info" bookmark.</li>
            <li>Come back to Yaoi Journal, open that entry, tap Cross-reference → Paste from clipboard.</li>
          </ol>
        </div>
        ` : ''}
      </div>
      <div class="export-row">
        <button class="ref-btn" data-export-csv="1">⬇ Export CSV</button>
        <button class="ref-btn" data-toggle-db-table="1">${DB_TABLE_OPEN ? '▲ Hide Table' : '▼ Show Table'}</button>
        <span style="color:var(--text-dim);font-size:12.5px;align-self:center;">${rows.length} total entries</span>
      </div>
      ${DB_TABLE_OPEN ? `
      <div class="db-table-wrap">
        <table class="db-table" id="db-table">
          <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
      ` : ''}
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
        ` : `<button class="ref-btn" data-review-crossref="${e.id}">🔗 Cross-reference manually</button>`}
      </div>
    </div>`;
}

function renderReviewQueue() {
  const items = ALL_ENTRIES.filter(needsReview).sort((a, b) => {
    const aHas = a.suggestedMatch ? 1 : 0;
    const bHas = b.suggestedMatch ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return a.title.localeCompare(b.title);
  });
  const body = items.length
    ? `<div class="review-grid">${items.map(renderReviewCard).join('')}</div>`
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

function mergeText(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  if (!a) return b;
  if (!b || a === b) return a;
  return a + '\n\n— merged from duplicate —\n' + b;
}

// Fills in anything missing on `target` using data from `source`, before
// `source` gets deleted as a duplicate. Never overwrites data target already
// has — only fills gaps, unions lists, and merges free-text notes.
function mergeEntryData(target, source) {
  const preferTarget = ['title', 'altTitle', 'novelAuthor', 'author', 'artist', 'officialLink', 'status',
    'currentlyReadingRaw', 'downloaded', 'shelf', 'coverUrl', 'referenceUrl', 'referenceSite', 'referenceStatus', 'pdfLink'];
  preferTarget.forEach((k) => { if (!target[k] && source[k]) target[k] = source[k]; });

  if (!target.totalSeasons && source.totalSeasons) target.totalSeasons = source.totalSeasons;
  if (!target.totalChapters && source.totalChapters) target.totalChapters = source.totalChapters;
  if (!target.epilogue && source.epilogue) target.epilogue = source.epilogue;
  if (!target.released && source.released) target.released = source.released;
  if (!target.isNovel && source.isNovel) target.isNovel = source.isNovel;
  if (!target.suggestedMatch && source.suggestedMatch) target.suggestedMatch = source.suggestedMatch;
  if (!target.summaryCache && source.summaryCache) { target.summaryCache = source.summaryCache; target.summaryCachedAt = source.summaryCachedAt; }

  target.favorite = !!(target.favorite || source.favorite);
  target.smutRating = Math.max(target.smutRating || 0, source.smutRating || 0);
  target.qualityRating = Math.max(target.qualityRating || 0, source.qualityRating || 0);
  target.notes = mergeText(target.notes, source.notes);

  ['semi', 'uke'].forEach((k) => {
    target[k] = target[k] || { flag: null, notes: '', photo: null };
    const s = source[k] || {};
    if (!target[k].flag && s.flag) target[k].flag = s.flag;
    if (!target[k].photo && s.photo) target[k].photo = s.photo;
    target[k].notes = mergeText(target[k].notes, s.notes);
  });

  target.tags = Array.from(new Set([...(target.tags || []), ...(source.tags || [])]));
  target.customTags = Array.from(new Set([...(target.customTags || []), ...(source.customTags || [])]));
  target.screencaps = Array.from(new Set([...(target.screencaps || []), ...(source.screencaps || [])]));
  return target;
}

// Manual "mark as duplicate" picker, reachable from any entry's own header
// (the 🔀 icon) — distinct from the automatic duplicate-review queue. Lets
// you pick which OTHER entry is the one to keep; the current entry's data
// gets folded into it via mergeEntryData before being deleted.
let MERGE_SOURCE_ID = null;
function openMergePickerModal(entryId) {
  const entry = getEntry(entryId);
  if (!entry) return;
  MERGE_SOURCE_ID = entryId;
  const candidates = ALL_ENTRIES.filter((x) => x.id !== entryId).sort((a, b) => a.title.localeCompare(b.title));
  const renderList = (list) => list.length
    ? list.slice(0, 40).map((c) => `<button class="ref-btn" style="width:100%;text-align:left;" data-merge-pick-target="${c.id}">${escapeHtml(c.title)}</button>`).join('')
    : '<div class="empty-state">No matches.</div>';
  openModal(`
    <h3>Mark as duplicate of…</h3>
    <p style="font-size:12px;color:var(--text-dim);">Pick the entry to keep. "${escapeHtml(entry.title)}"'s notes, ratings, tags, flags, and images will be merged into it, then this entry is deleted.</p>
    <input type="text" id="merge-pick-search" placeholder="Search titles..." style="width:100%;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--navy-2);color:var(--text);box-sizing:border-box;">
    <div id="merge-pick-list" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;">${renderList(candidates)}</div>
    <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Cancel</button></div>
  `);
  const searchEl = document.getElementById('merge-pick-search');
  const listEl = document.getElementById('merge-pick-list');
  if (searchEl) {
    searchEl.oninput = () => {
      const q = searchEl.value.trim().toLowerCase();
      const filtered = q ? candidates.filter((c) => c.title.toLowerCase().includes(q)) : candidates;
      listEl.innerHTML = renderList(filtered);
    };
    searchEl.focus();
  }
}

async function mergeIntoTarget(sourceId, targetId) {
  const source = getEntry(sourceId);
  const target = getEntry(targetId);
  if (!source || !target) return;
  mergeEntryData(target, source);
  await saveEntry(target);
  await deleteEntry(sourceId);
  showToast('Merged and deleted');
  closeModal();
  render();
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
  const diffFields = [
    ['Shelf', (x) => x.shelf || ''],
    ['Format', (x) => x.format || ''],
    ['Author', (x) => formatNames(x.author) || ''],
    ['Smut', (x) => String(x.smutRating || 0)],
    ['Quality', (x) => String(x.qualityRating || 0)],
    ['Favorite', (x) => (x.favorite ? 'Yes' : 'No')],
  ];
  const differingLabels = diffFields.filter(([, fn]) => {
    const vals = group.map(fn);
    return !vals.every((v) => v === vals[0]);
  }).map(([label]) => label);
  const items = group.map((e) => {
    const coverSrc = e.coverUrl || (e.suggestedMatch ? e.suggestedMatch.coverUrl : null);
    const cover = coverSrc
      ? `<img src="${escapeHtml(coverSrc)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>🍆</div>'">`
      : `<div class="cover-placeholder">🍆</div>`;
    return `
      <div class="dup-item">
        <div class="cover-thumb" style="width:100%;aspect-ratio:1/1;">${cover}</div>
        <div class="review-card-info">
          <strong>${escapeHtml(e.title)}</strong>
          <div style="font-size:11px;color:var(--text-dim);">${escapeHtml(e.shelf)}${e.author ? ' · ' + escapeHtml(formatNames(e.author)) : ''}</div>
          <div style="font-size:11px;color:var(--text-dim);">Updated ${e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : '—'}${e.favorite ? ' · 💜 favorite' : ''}</div>
          ${differingLabels.length ? `<div style="font-size:11px;color:var(--pink);margin-top:2px;">Differs: ${differingLabels.map((label) => { const fn = diffFields.find((f) => f[0] === label)[1]; return `${label} ${escapeHtml(fn(e) || '—')}`; }).join(' · ')}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="ref-btn" data-open-entry="${e.id}">Open</button>
          <button class="btn-primary" style="padding:6px 10px;font-size:12px;" data-dup-merge-into="${e.id}">Merge into this</button>
          <button class="btn-ghost" data-dup-delete="${e.id}">Delete this one</button>
        </div>
      </div>`;
  }).join('');
  return `<div class="panel"><div class="panel-title">Possible duplicate</div><div class="dup-items-row">${items}</div><button class="ref-btn" style="width:100%;margin-top:8px;" data-dup-not-duplicate="${dupGroupSignature(group)}">Not duplicates — keep both, stop asking</button></div>`;
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

// `reviewInfo` (optional) is { index, total } — only set when this modal is
// opened as part of the "review missing cover/reference" carousel, in which
// case a counter + Prev/Skip controls show up and confirming a match moves
// straight to the next entry needing review instead of jumping to the full
// detail page.
function openCrossRefModal(entryId, reviewInfo) {
  if (!reviewInfo) CROSSREF_REVIEW_ACTIVE = false;
  const e = getEntry(entryId);
  const proxy = getProxyUrl();
  const apSearchUrl = 'https://www.anime-planet.com/manga/all?name=' + encodeURIComponent(e.title);
  const mgSearchUrl = 'https://www.mangago.me/r/l_search/?name=' + encodeURIComponent(e.title);
  openModal(`
    ${reviewInfo ? `<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">Reviewing missing cover/reference — ${reviewInfo.index + 1} of ${reviewInfo.total}</div>` : ''}
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
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 8px;">Getting an error above? Open the title on Anime-Planet/MangaGo, tap your "Get Info" bookmark (set up once in Settings ⚙️), then come back and tap Paste below.</p>
      <button class="ref-btn" style="width:100%;" data-paste-ref="${entryId}">📋 Paste from clipboard</button>
    </div>
    <div id="crossref-preview"></div>
    ${reviewInfo ? `
      <div style="display:flex;justify-content:space-between;gap:6px;margin-top:14px;border-top:1px solid var(--border);padding-top:10px;">
        <button class="ref-btn" data-crossref-review-prev="1" ${reviewInfo.index === 0 ? 'disabled' : ''}>‹ Prev</button>
        <button class="ref-btn" data-crossref-review-skip="1">Skip ›</button>
      </div>
    ` : ''}
  `);
}

/* Cross-reference review carousel — same "step through one at a time" idea
   as the suggested-match carousel above, but for entries with no cover or
   reference link at all yet (the Database "Review missing cover/reference"
   queue). */
let CROSSREF_REVIEW_QUEUE = [];
let CROSSREF_REVIEW_INDEX = 0;
let CROSSREF_REVIEW_ACTIVE = false;

function openCrossRefReviewCarousel(startEntryId) {
  CROSSREF_REVIEW_QUEUE = ALL_ENTRIES.filter(needsReview).map((e) => e.id);
  if (!CROSSREF_REVIEW_QUEUE.length) { showToast('Nothing left to review'); return; }
  const idx = CROSSREF_REVIEW_QUEUE.indexOf(startEntryId);
  CROSSREF_REVIEW_INDEX = idx > -1 ? idx : 0;
  CROSSREF_REVIEW_ACTIVE = true;
  openCrossRefModal(CROSSREF_REVIEW_QUEUE[CROSSREF_REVIEW_INDEX], { index: CROSSREF_REVIEW_INDEX, total: CROSSREF_REVIEW_QUEUE.length });
}

function advanceCrossRefReview() {
  CROSSREF_REVIEW_QUEUE.splice(CROSSREF_REVIEW_INDEX, 1);
  if (!CROSSREF_REVIEW_QUEUE.length) {
    CROSSREF_REVIEW_ACTIVE = false;
    showToast('All done reviewing! 🎉');
    render();
    return;
  }
  if (CROSSREF_REVIEW_INDEX >= CROSSREF_REVIEW_QUEUE.length) CROSSREF_REVIEW_INDEX = CROSSREF_REVIEW_QUEUE.length - 1;
  openCrossRefModal(CROSSREF_REVIEW_QUEUE[CROSSREF_REVIEW_INDEX], { index: CROSSREF_REVIEW_INDEX, total: CROSSREF_REVIEW_QUEUE.length });
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
  e.suggestedMatchDismissed = false;
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
  showToast('Linked! Summary & cover pulled in.');
  if (CROSSREF_REVIEW_ACTIVE) {
    advanceCrossRefReview();
  } else {
    closeModal();
    navigate('detail', entryId);
  }
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
      <div class="panel-title" style="margin-bottom:6px;">📋 Get Info button</div>
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 10px;">You'll only need this occasionally — mainly when adding a brand-new title, or when cleaning up entries in Database mode. It's a free workaround for when the automatic fetch fails.</p>

      <p style="font-size:12px;font-weight:600;margin:0 0 4px;">Set up once:</p>
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 4px;"><strong>On a computer:</strong> drag this button up to your bookmarks bar. <a href="${bookmarkletHref()}" class="ref-btn" style="display:inline-block;text-decoration:none;">💾 Get Info</a></p>
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 8px;"><strong>On a phone:</strong> save any page as a bookmark, then open that bookmark's settings and paste the code below over its URL.</p>
      <textarea readonly style="width:100%;height:60px;font-size:10px;font-family:monospace;" onclick="this.select()">${escapeHtml(bookmarkletHref())}</textarea>

      <p style="font-size:12px;font-weight:600;margin:10px 0 4px;">Each time you need it:</p>
      <ol style="font-size:11.5px;color:var(--text-dim);margin:0 0 0 18px;padding:0;">
        <li>Open the title's page on Anime-Planet or MangaGo.</li>
        <li>Tap your "Get Info" bookmark.</li>
        <li>Come back to Yaoi Journal, open that entry, tap Cross-reference → Paste from clipboard.</li>
      </ol>
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

  root.querySelectorAll('[data-header-home]').forEach((el) => {
    el.onclick = () => {
      STATE.showFavoritesOnly = false;
      STATE.showOnDriveOnly = false;
      STATE.showHentaiOnly = false;
      FILTERS_COLLAPSED = false;
      navigate('home');
    };
  });

  const signOutBtn = root.querySelector('[data-sign-out]');
  if (signOutBtn) signOutBtn.onclick = () => {
    if (confirm('Sign out of this account on this device?')) signOutOfAccount();
  };

  const reconnectDriveBtn = root.querySelector('[data-reconnect-drive]');
  if (reconnectDriveBtn) reconnectDriveBtn.onclick = () => reconnectGoogleDrive();

  root.querySelectorAll('[data-open-entry]').forEach((el) => {
    el.onclick = () => navigate('detail', el.getAttribute('data-open-entry'));
  });
  root.querySelectorAll('[data-review-match]').forEach((el) => {
    el.onclick = () => openMatchReviewCarousel(el.getAttribute('data-review-match'));
  });
  root.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      const view = el.getAttribute('data-nav');
      if (view === 'home') { STATE.showFavoritesOnly = false; STATE.showOnDriveOnly = false; STATE.showHentaiOnly = false; FILTERS_COLLAPSED = false; }
      navigate(view);
    };
  });
  root.querySelectorAll('[data-nav-filter]').forEach((el) => {
    el.onclick = () => {
      const which = el.getAttribute('data-nav-filter');
      STATE.showFavoritesOnly = which === 'favorites';
      STATE.showOnDriveOnly = which === 'onDrive';
      STATE.showHentaiOnly = which === 'hentai';
      // Favorites/On HD are meant to be a clean "just show me everything"
      // list — the filter box (which you didn't ask for) starts tucked away.
      if (which === 'favorites' || which === 'onDrive') FILTERS_COLLAPSED = true;
      navigate('home');
    };
  });
  const searchInput = root.querySelector('#search-input');
  if (searchInput) {
    searchInput.oninput = (ev) => {
      STATE.search = ev.target.value;
      if (STATE.view === 'home') {
        renderHomeInPlace();
      } else {
        // Search lives in the global header now, reachable from any screen —
        // typing while elsewhere jumps to Journal to show results, then
        // restores focus/cursor so the jump doesn't interrupt typing.
        STATE.showFavoritesOnly = false; STATE.showOnDriveOnly = false; STATE.showHentaiOnly = false; FILTERS_COLLAPSED = false;
        SEARCH_INPUT_SHOULD_FOCUS = true;
        navigate('home');
      }
    };
    if (SEARCH_INPUT_SHOULD_FOCUS) {
      SEARCH_INPUT_SHOULD_FOCUS = false;
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }
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
  root.querySelectorAll('[data-toggle-db-settings]').forEach((el) => {
    el.onclick = () => { DB_SETTINGS_OPEN = !DB_SETTINGS_OPEN; render(); };
  });
  root.querySelectorAll('[data-toggle-db-table]').forEach((el) => {
    el.onclick = () => { DB_TABLE_OPEN = !DB_TABLE_OPEN; render(); };
  });
  const saveSettingsInlineBtn = root.querySelector('[data-save-settings-inline]');
  if (saveSettingsInlineBtn) saveSettingsInlineBtn.onclick = () => {
    const val = document.getElementById('proxy-url-input').value;
    setProxyUrl(val);
    DB_SETTINGS_OPEN = false;
    showToast('Settings saved');
    render();
  };

  // Detail view handlers
  const forceSaveBtn = root.querySelector('[data-force-save]');
  if (forceSaveBtn) forceSaveBtn.onclick = async () => {
    // Blur whatever field is currently focused first, so its own onblur
    // handler (notes, char notes, etc.) fires and writes its latest value
    // onto the entry object before this does one final explicit save.
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    const e = getEntry(STATE.entryId);
    if (e) await saveEntry(e);
    showToast('✅ Saved');
  };
  const favBtn = root.querySelector('[data-toggle-fav]');
  if (favBtn) favBtn.onclick = async () => {
    const e = getEntry(STATE.entryId); e.favorite = !e.favorite; await saveEntry(e); render();
  };
  const hdBtn = root.querySelector('[data-toggle-hd]');
  if (hdBtn) hdBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    if (isOnDrive(e)) {
      e.tags = (e.tags || []).filter((t) => normalizeTagKey(t) !== ON_DRIVE_TAG_KEY);
      e.customTags = (e.customTags || []).filter((t) => normalizeTagKey(t) !== ON_DRIVE_TAG_KEY);
    } else {
      e.customTags = [...(e.customTags || []), 'On HD'];
    }
    await saveEntry(e); render();
  };
  const deleteBtn = root.querySelector('[data-delete-entry]');
  if (deleteBtn) deleteBtn.onclick = async () => {
    const id = deleteBtn.getAttribute('data-delete-entry');
    const e = getEntry(id);
    if (!e) return;
    if (!confirm(`Delete "${e.title}" for good? This can't be undone.`)) return;
    await deleteEntry(id);
    showToast('Deleted');
    navigate('home');
  };
  const mergeBtn = root.querySelector('[data-merge-entry]');
  if (mergeBtn) mergeBtn.onclick = () => openMergePickerModal(mergeBtn.getAttribute('data-merge-entry'));
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
    attachBulletTextarea(el);
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
      // Local save/display already happened above — the Drive upload runs
      // after, purely so this photo can cross-sync to her other device.
      tryUploadImageToDrive(dataUrl, `${e.id}-${who}-photo.jpg`).then((fileId) => {
        if (!fileId) return;
        const fresh = getEntry(e.id);
        if (!fresh) return;
        fresh[who].photoDriveId = fileId;
        saveEntry(fresh);
      });
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
    tryUploadImageToDrive(dataUrl, `${e.id}-cover.jpg`).then((fileId) => {
      if (!fileId) return;
      const fresh = getEntry(e.id);
      if (!fresh) return;
      fresh.coverDriveId = fileId;
      saveEntry(fresh);
    });
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
    attachBulletTextarea(notesArea);
    const autoGrow = () => { notesArea.style.height = 'auto'; notesArea.style.height = (notesArea.scrollHeight + 2) + 'px'; };
    autoGrow();
    notesArea.oninput = autoGrow;
    notesArea.onblur = async () => {
      const e = getEntry(STATE.entryId); e.notes = notesArea.value; await saveEntry(e);
    };
  }
  const screencapInput = root.querySelector('#screencap-input');
  if (screencapInput) screencapInput.onchange = async () => {
    if (screencapInput.files.length) await addScreencapFiles(screencapInput.files);
  };
  const screencapDropzone = root.querySelector('[data-screencap-dropzone]');
  if (screencapDropzone) {
    screencapDropzone.ondragover = (ev) => { ev.preventDefault(); screencapDropzone.classList.add('drag-over'); };
    screencapDropzone.ondragleave = () => { screencapDropzone.classList.remove('drag-over'); };
    screencapDropzone.ondrop = (ev) => {
      ev.preventDefault();
      screencapDropzone.classList.remove('drag-over');
      const files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files.length) addScreencapFiles(files);
    };
  }
  root.querySelectorAll('[data-del-screencap]').forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const idx = Number(el.getAttribute('data-del-screencap'));
      const e = getEntry(STATE.entryId);
      e.screencaps.splice(idx, 1);
      if (e.screencapDriveIds && e.screencapDriveIds[idx]) {
        deleteFromDrive(e.screencapDriveIds[idx]);
        e.screencapDriveIds.splice(idx, 1);
      }
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
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const id = el.getAttribute('data-del-reaction');
      if (!confirm('Delete this image from your library? Any entries it\'s already attached to keep their own copy.')) return;
      await deleteReaction(id);
      showToast('Deleted');
      render();
    };
  });
  root.querySelectorAll('[data-view-image-attachments]').forEach((el) => {
    el.onclick = () => openImageAttachmentsModal(el.getAttribute('data-view-image-attachments'));
  });
  root.querySelectorAll('[data-images-tab]').forEach((el) => {
    el.onclick = () => { IMAGES_TAB = el.getAttribute('data-images-tab'); render(); };
  });
  const scanDupBtn = root.querySelector('[data-scan-duplicates]');
  if (scanDupBtn) scanDupBtn.onclick = () => scanForImageDuplicates();

  // Meme/reaction library
  attachMemeGridHandlers();
  const memeUploadInput = root.querySelector('#meme-upload-input');
  if (memeUploadInput) memeUploadInput.onchange = async () => {
    if (!memeUploadInput.files.length) return;
    await addReactionFiles(memeUploadInput.files);
    render();
  };
  const memeSearchInput = root.querySelector('#meme-search-input');
  if (memeSearchInput) {
    memeSearchInput.oninput = (ev) => { MEME_STATE.search = ev.target.value; renderMemeLibraryInPlace(); };
    memeSearchInput.focus();
    memeSearchInput.setSelectionRange(memeSearchInput.value.length, memeSearchInput.value.length);
  }
  root.querySelectorAll('[data-meme-group-filter]').forEach((el) => {
    el.onclick = () => {
      const gid = el.getAttribute('data-meme-group-filter');
      MEME_STATE.groupFilter = MEME_STATE.groupFilter === gid ? null : gid;
      render();
    };
  });
  const addGroupBtn = root.querySelector('[data-add-reaction-group]');
  if (addGroupBtn) addGroupBtn.onclick = openCreateReactionGroupModal;
  root.querySelectorAll('[data-view-screencap]').forEach((imgEl) => {
    imgEl.onclick = () => {
      renderScreencapLightbox(imgEl.getAttribute('src'));
    };
  });
  const crossRefBtn = root.querySelector('[data-open-crossref]');
  if (crossRefBtn) crossRefBtn.onclick = () => openCrossRefModal(STATE.entryId);
  const generateMatchBtn = root.querySelector('[data-generate-match]');
  if (generateMatchBtn) generateMatchBtn.onclick = () => generateSuggestedMatch(STATE.entryId);
  const useSuggestedBtn = root.querySelector('[data-use-suggested]');
  if (useSuggestedBtn) useSuggestedBtn.onclick = async () => {
    const applied = await applySuggestedMatch(STATE.entryId);
    if (!applied) return;
    showToast('Applied!');
    render();
  };
  const dismissSuggestedBtn = root.querySelector('[data-dismiss-suggested]');
  if (dismissSuggestedBtn) dismissSuggestedBtn.onclick = async () => {
    await dismissSuggestedMatch(STATE.entryId);
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
  root.querySelectorAll('[data-restore-tag]').forEach((el) => {
    el.onclick = async () => {
      await restoreDeletedTag(el.getAttribute('data-restore-tag'));
      showToast('Restored — this tag can be used again');
      render();
    };
  });
  root.querySelectorAll('[data-tagmgr-tab]').forEach((el) => {
    el.onclick = () => { TAG_MGR_TAB = el.getAttribute('data-tagmgr-tab'); render(); };
  });
  root.querySelectorAll('[data-tagmgr-hide]').forEach((el) => {
    el.onclick = async () => {
      const name = el.getAttribute('data-tagmgr-hide');
      const nowHidden = !USER_HIDDEN_TAG_KEYS.has(normalizeTagKey(name));
      await setTagSoftHidden(name, nowHidden);
      showToast(nowHidden ? 'Hidden from filters' : 'Shown in filters again');
      render();
    };
  });
  root.querySelectorAll('[data-tagmgr-merge]').forEach((el) => {
    el.onclick = () => openTagMergeModal(el.getAttribute('data-tagmgr-merge'));
  });
  root.querySelectorAll('[data-suggest-hide]').forEach((el) => {
    el.onclick = async () => {
      await setTagSoftHidden(el.getAttribute('data-suggest-hide'), true);
      showToast('Hidden');
      render();
    };
  });
  root.querySelectorAll('[data-tag-suggestions-toggle]').forEach((el) => {
    el.onclick = () => {
      TAG_SUGGESTIONS_OPEN = !TAG_SUGGESTIONS_OPEN;
      render();
    };
  });
  root.querySelectorAll('[data-suggest-dismiss]').forEach((el) => {
    el.onclick = async () => {
      await dismissTagSuggestion(el.getAttribute('data-suggest-dismiss'));
      render();
    };
  });
  root.querySelectorAll('[data-suggest-merge-a]').forEach((el) => {
    el.onclick = async () => {
      const keepName = el.getAttribute('data-suggest-merge-a');
      const dropName = el.getAttribute('data-suggest-merge-b');
      for (const e of ALL_ENTRIES) {
        let changed = false;
        if ((e.tags || []).includes(dropName)) {
          e.tags = e.tags.filter((t) => t !== dropName);
          if (!e.tags.includes(keepName) && !(e.customTags || []).includes(keepName)) e.tags.push(keepName);
          changed = true;
        }
        if ((e.customTags || []).includes(dropName)) {
          e.customTags = e.customTags.filter((t) => t !== dropName);
          if (!(e.tags || []).includes(keepName) && !e.customTags.includes(keepName)) e.customTags.push(keepName);
          changed = true;
        }
        if (changed) await saveEntry(e);
      }
      await dismissTagSuggestion(el.getAttribute('data-suggest-sig'));
      showToast(`Merged "${dropName}" into "${keepName}"`);
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
  const bulkSweepBtn = root.querySelector('[data-run-bulk-sweep]');
  if (bulkSweepBtn) bulkSweepBtn.onclick = runBulkMatchSweep;
  const stopSweepBtn = root.querySelector('[data-stop-bulk-sweep]');
  if (stopSweepBtn) stopSweepBtn.onclick = cancelBulkMatchSweep;
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
      e.suggestedMatchDismissed = false;
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
      e.suggestedMatchDismissed = true;
      await saveEntry(e);
      showToast('Dismissed');
      render();
    };
  });
  root.querySelectorAll('[data-review-crossref]').forEach((el) => {
    el.onclick = () => openCrossRefReviewCarousel(el.getAttribute('data-review-crossref'));
  });

  // Duplicate review
  root.querySelectorAll('[data-dup-delete]').forEach((el) => {
    el.onclick = async () => {
      const id = el.getAttribute('data-dup-delete');
      const e = getEntry(id);
      if (!e) return;
      if (!confirm(`Delete "${e.title}"? Its data will be merged into the other duplicate(s) first, then this one is removed for good.`)) return;
      // Find any other entries in this duplicate group and fold this
      // entry's data into them before it's gone.
      const group = findDuplicateGroups().find((g) => g.some((ge) => ge.id === id));
      const survivors = (group || []).filter((ge) => ge.id !== id);
      for (const survivor of survivors) {
        mergeEntryData(survivor, e);
        await saveEntry(survivor);
      }
      await deleteEntry(id);
      showToast(survivors.length ? 'Merged and deleted' : 'Deleted');
      render();
    };
  });
  root.querySelectorAll('[data-dup-merge-into]').forEach((el) => {
    el.onclick = async () => {
      const keepId = el.getAttribute('data-dup-merge-into');
      const keep = getEntry(keepId);
      if (!keep) return;
      const group = findDuplicateGroups().find((g) => g.some((ge) => ge.id === keepId));
      const others = (group || []).filter((ge) => ge.id !== keepId);
      if (!others.length) return;
      if (!confirm(`Merge the other ${others.length} cop${others.length === 1 ? 'y' : 'ies'} into "${keep.title}"? The others will be deleted after their data is copied over.`)) return;
      for (const other of others) {
        await mergeIntoTarget(other.id, keepId);
      }
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
  if (STATE.shelf === 'ALL' && !STATE.tagFilters.length && !STATE.search && !STATE.showFavoritesOnly && !STATE.showOnDriveOnly && !STATE.showHentaiOnly && !STATE.smutFilter && !STATE.qualityFilter && !STATE.flagFilter) {
    const suggestedGroup = entries.filter((e) => e.suggestedMatch);
    if (suggestedGroup.length > 0) {
      body += `<div class="section-title">🔎 Suggested Matches <span style="opacity:.6">(${suggestedGroup.length})</span></div>`;
      body += scrollRow('row-suggested', suggestedGroup.map((e) => renderCoverCard(e, true)).join(''));
    }
    const shelvesToShow = STATE.format === 'reading' ? SHELVES_READING : ['Completed'];
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      const rowId = 'row-' + shelf.replace(/[^a-z0-9]+/gi, '-');
      body += `<div class="section-title">${escapeHtml(shelf)} <span style="opacity:.6">(${group.length})</span></div>`;
      body += scrollRow(rowId, group.map((e) => renderCoverCard(e)).join(''));
    });
    if (!body) body = `<div class="empty-state">Nothing here yet.</div>`;
  } else {
    body = entries.length
      ? `<div class="cover-grid">${entries.map((e) => renderCoverCard(e)).join('')}</div>`
      : `<div class="empty-state">No matches. Try clearing filters.</div>`;
  }
  if (main) {
    main.innerHTML = body;
    main.querySelectorAll('[data-open-entry]').forEach((el) => {
      el.onclick = () => navigate('detail', el.getAttribute('data-open-entry'));
    });
    main.querySelectorAll('[data-review-match]').forEach((el) => {
      el.onclick = () => openMatchReviewCarousel(el.getAttribute('data-review-match'));
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
  if (t.matches('[data-close-modal]')) { CROSSREF_REVIEW_ACTIVE = false; closeModal(); }
  if (t.matches('[data-crossref-review-skip]')) advanceCrossRefReview();
  if (t.matches('[data-crossref-review-prev]')) {
    CROSSREF_REVIEW_INDEX = Math.max(0, CROSSREF_REVIEW_INDEX - 1);
    openCrossRefModal(CROSSREF_REVIEW_QUEUE[CROSSREF_REVIEW_INDEX], { index: CROSSREF_REVIEW_INDEX, total: CROSSREF_REVIEW_QUEUE.length });
  }
  if (t.matches('[data-goto-entry-from-modal]')) {
    closeModal();
    navigate('detail', t.getAttribute('data-goto-entry-from-modal'));
  }
  if (t.matches('[data-merge-pick-target]')) {
    const targetId = t.getAttribute('data-merge-pick-target');
    const source = getEntry(MERGE_SOURCE_ID);
    const target = getEntry(targetId);
    if (source && target && confirm(`Merge "${source.title}" into "${target.title}"? "${source.title}" will be deleted after its data is copied over.`)) {
      mergeIntoTarget(MERGE_SOURCE_ID, targetId);
    }
  }
  if (t.matches('[data-tagmgr-merge-confirm]')) {
    const keepName = t.getAttribute('data-tagmgr-merge-confirm');
    const dropName = t.getAttribute('data-tagmgr-merge-source');
    (async () => {
      for (const en of ALL_ENTRIES) {
        let changed = false;
        if ((en.tags || []).includes(dropName)) {
          en.tags = en.tags.filter((x) => x !== dropName);
          if (!en.tags.includes(keepName) && !(en.customTags || []).includes(keepName)) en.tags.push(keepName);
          changed = true;
        }
        if ((en.customTags || []).includes(dropName)) {
          en.customTags = en.customTags.filter((x) => x !== dropName);
          if (!(en.tags || []).includes(keepName) && !en.customTags.includes(keepName)) en.customTags.push(keepName);
          changed = true;
        }
        if (changed) await saveEntry(en);
      }
      closeModal();
      showToast(`Merged "${dropName}" into "${keepName}"`);
      render();
    })();
  }
  if (t.matches('[data-attach-image-to-entry]')) {
    const entryId = t.getAttribute('data-attach-image-to-entry');
    const src = t.getAttribute('data-attach-image-src');
    (async () => {
      const entry = getEntry(entryId);
      if (!entry) return;
      entry.screencaps = entry.screencaps || [];
      if (!entry.screencaps.includes(src)) entry.screencaps.push(src);
      await saveEntry(entry);
      showToast(`Attached to "${entry.title}"`);
      openImageAttachmentsModal(src);
    })();
  }
  if (t.matches('[data-toggle-use-as-reaction]')) {
    const src = t.getAttribute('data-toggle-use-as-reaction');
    (async () => {
      const existing = ALL_REACTIONS.find((r) => r.dataUrl === src);
      if (existing) {
        await deleteReaction(existing.id);
        showToast('Removed from Reactions');
      } else {
        const reaction = { id: uid('reaction'), dataUrl: src, hash: await hashDataUrl(src), mediaType: 'image', moodTags: [], note: '', createdAt: new Date().toISOString() };
        await saveReaction(reaction);
        showToast('Added to Reactions');
      }
      renderScreencapLightbox(src);
    })();
  }
  if (t.matches('[data-create-reaction-group]')) {
    const input = document.getElementById('new-group-title-input');
    const title = (input ? input.value : '').trim();
    if (title) {
      const group = { id: 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title };
      REACTION_GROUPS.push(group);
      idbPut(STORE_META, { key: 'reactionGroups', value: REACTION_GROUPS });
      pushMetaField('reactionGroups', REACTION_GROUPS);
      MEME_STATE.groupFilter = group.id;
      closeModal();
      render();
    }
  }
  if (t.matches('[data-meme-toggle-group]')) {
    const id = t.getAttribute('data-meme-id');
    const groupId = t.getAttribute('data-meme-toggle-group');
    const r = ALL_REACTIONS.find((x) => x.id === id);
    if (r) {
      const ids = reactionGroupIds(r).slice();
      const idx = ids.indexOf(groupId);
      if (idx === -1) ids.push(groupId); else ids.splice(idx, 1);
      r.groupIds = ids;
      saveReaction(r);
      openMemeEditModal(id);
    }
  }
  if (t.matches('[data-carousel-use]')) {
    const entryId = MATCH_REVIEW_QUEUE[MATCH_REVIEW_INDEX];
    applySuggestedMatch(entryId).then(() => {
      showToast('Applied!');
      MATCH_REVIEW_QUEUE.splice(MATCH_REVIEW_INDEX, 1);
      renderMatchReviewModal();
    });
  }
  if (t.matches('[data-carousel-dismiss]')) {
    const entryId = MATCH_REVIEW_QUEUE[MATCH_REVIEW_INDEX];
    dismissSuggestedMatch(entryId).then(() => {
      showToast('Dismissed');
      MATCH_REVIEW_QUEUE.splice(MATCH_REVIEW_INDEX, 1);
      renderMatchReviewModal();
    });
  }
  if (t.matches('[data-carousel-prev]')) {
    MATCH_REVIEW_INDEX = Math.max(0, MATCH_REVIEW_INDEX - 1);
    renderMatchReviewModal();
  }
  if (t.matches('[data-carousel-next]')) {
    MATCH_REVIEW_INDEX = Math.min(MATCH_REVIEW_QUEUE.length - 1, MATCH_REVIEW_INDEX + 1);
    renderMatchReviewModal();
  }
  if (t.matches('[data-carousel-open-full]')) {
    closeModal();
    navigate('detail', t.getAttribute('data-carousel-open-full'));
  }
  if (t.matches('[data-delete-meme]')) {
    const id = t.getAttribute('data-delete-meme');
    if (confirm('Delete this reaction from your library for good?')) {
      deleteReaction(id);
      closeModal();
      render();
    }
  }
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
      .filter((e) => !e.suggestedMatch && !e.suggestedMatchDismissed && e.referenceStatus !== 'confirmed')
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

// Manual, on-demand version of the sweep above — for pushing through a big
// backlog (500+ unmatched entries) in one sitting instead of waiting for the
// once-a-day/20-at-a-time automatic version. Runs every remaining candidate,
// paced the same 1.2s apart so it doesn't hammer the proxy, and can be
// stopped mid-run since a full pass can take several minutes.
const BULK_SWEEP = { running: false, checked: 0, total: 0, found: 0, cancel: false };
function bulkSweepCandidates() {
  return ALL_ENTRIES.filter((e) => !e.suggestedMatch && !e.suggestedMatchDismissed && e.referenceStatus !== 'confirmed');
}
async function runBulkMatchSweep() {
  if (BULK_SWEEP.running) return;
  const proxy = getProxyUrl();
  if (!proxy) { showToast('Set a proxy URL in Settings first'); return; }
  const candidates = bulkSweepCandidates();
  if (!candidates.length) { showToast('Nothing left to check — everything unmatched has already been searched.'); return; }
  BULK_SWEEP.running = true;
  BULK_SWEEP.checked = 0;
  BULK_SWEEP.total = candidates.length;
  BULK_SWEEP.found = 0;
  BULK_SWEEP.cancel = false;
  if (STATE.view === 'database') render();
  for (const e of candidates) {
    if (BULK_SWEEP.cancel) break;
    try {
      const data = await findSuggestedMatchData(proxy, e);
      if (data) {
        e.suggestedMatch = dataToSuggestedMatch(data);
        e.suggestedMatchDismissed = false;
        await saveEntry(e);
        BULK_SWEEP.found++;
      }
    } catch (err) {
      console.error('Bulk match sweep item failed:', err);
    }
    BULK_SWEEP.checked++;
    if (STATE.view === 'database' && BULK_SWEEP.checked % 3 === 0) render();
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  const wasCancelled = BULK_SWEEP.cancel;
  BULK_SWEEP.running = false;
  if (STATE.view === 'database') render();
  showToast(wasCancelled
    ? `Stopped — found ${BULK_SWEEP.found} of ${BULK_SWEEP.checked} checked`
    : `Done — found ${BULK_SWEEP.found} new suggested match${BULK_SWEEP.found === 1 ? '' : 'es'} out of ${BULK_SWEEP.checked} checked`);
}
function cancelBulkMatchSweep() {
  BULK_SWEEP.cancel = true;
}

// A stale service worker used to be able to get permanently stuck in the
// "waiting" state — new code would deploy and pass CI, but the browser tab
// kept being served by the old cached copy indefinitely (even after a hard
// refresh, since a service worker intercepts requests below the HTTP cache
// layer). This forces any waiting worker to take over immediately and does
// one automatic reload so new deploys are visible without any manual steps
// (closing tabs, clearing site data, etc.) on the user's end.
function setupAutoUpdatingServiceWorker() {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const activateWaiting = () => { if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); };
    activateWaiting();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) activateWaiting();
      });
    });
    // Also proactively check for an update on every load, since GitHub
    // Pages/CDN caching can otherwise delay when the browser even notices
    // sw.js itself changed.
    reg.update().catch(() => {});
  }).catch(() => {});
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
    const savedUserHidden = await idbGet(STORE_META, 'userHiddenTagKeys');
    if (savedUserHidden && Array.isArray(savedUserHidden.value)) USER_HIDDEN_TAG_KEYS = new Set(savedUserHidden.value);
    const savedIgnoredSugg = await idbGet(STORE_META, 'ignoredTagSuggestions');
    if (savedIgnoredSugg && Array.isArray(savedIgnoredSugg.value)) IGNORED_TAG_SUGGESTIONS = new Set(savedIgnoredSugg.value);
    const savedReactionGroups = await idbGet(STORE_META, 'reactionGroups');
    if (savedReactionGroups && Array.isArray(savedReactionGroups.value)) REACTION_GROUPS = savedReactionGroups.value;
    const DEFAULT_MOOD_GROUPS = [
      { id: 'mood-angry', title: '😡 Angry' },
      { id: 'mood-funny', title: '😂 Funny' },
      { id: 'mood-horny', title: '🍆 Horny' },
      { id: 'mood-confused', title: '😵\u200d💫 Confused' },
    ];
    let reactionGroupsChanged = false;
    DEFAULT_MOOD_GROUPS.forEach((dg) => {
      if (!REACTION_GROUPS.some((g) => g.id === dg.id)) { REACTION_GROUPS.push(dg); reactionGroupsChanged = true; }
    });
    const legacyMoodToGroupId = { angry: 'mood-angry', funny: 'mood-funny', horny: 'mood-horny', confused: 'mood-confused' };
    ALL_REACTIONS.forEach((r) => {
      if (!r.groupId && r.moodTags && r.moodTags.length) {
        const gid = legacyMoodToGroupId[r.moodTags[0]];
        if (gid) { r.groupId = gid; idbPut(STORE_REACTIONS, r); }
      }
    });
    if (reactionGroupsChanged) {
      idbPut(STORE_META, { key: 'reactionGroups', value: REACTION_GROUPS });
      pushMetaField('reactionGroups', REACTION_GROUPS);
    }
    if ('serviceWorker' in navigator) {
      setupAutoUpdatingServiceWorker();
    }
    // Completes the signInWithRedirect() round trip used for standalone/PWA
    // sign-in and reconnects (see isStandalonePWA() in signInWithGoogle()/
    // reconnectGoogleDrive()) — onAuthStateChanged alone tells us a user is
    // signed in, but only getRedirectResult() hands back the Google OAuth
    // credential/access token needed for Drive calls.
    // Drive access tokens are now minted directly via Google Identity
    // Services (see requestDriveAccessToken()/reconnectGoogleDrive() below) —
    // the old getRedirectResult()-based flow that used to live here depended
    // on a cross-origin relay through the Firebase authDomain that modern
    // browsers' third-party storage partitioning silently breaks (confirmed
    // live: it always came back with no user/credential). Retired.
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
