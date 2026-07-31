/* ==========================================================================
   Yaoi Journal — standalone PWA
   All data lives in IndexedDB on this device. No account, no server database.
   The only network calls this app makes are (a) hotlinking cover images
   directly from anime-planet's own CDN, and (b) an optional proxy call to
   your own Apps Script endpoint to pull a summary/metadata preview when you
   cross-reference a title. Nothing you type is ever sent anywhere.
   ========================================================================== */

const DB_NAME = 'yaoiJournalDB';
const DB_VERSION = 3;
const STORE_ENTRIES = 'entries';
const STORE_META = 'meta';
const STORE_REACTIONS = 'reactions';
const STORE_H_IMAGES = 'hImages';

const SHELVES_READING = ['Currently Reading', 'Completed', 'Plan to Read', 'Discontinued'];
const FLAG_COLORS = ['green', 'red', 'black'];
const FLAG_HEX = { green: '#4ade80', red: '#f87171', black: '#6b6b7a' };

/* ---------------------------------------------------------------------- */
/* SFW / NSFW account theme                                               */
/* A one-time, per-account choice made at sign-up (or, for accounts that   */
/* predate this feature, via a one-time button in Database). Deliberately  */
/* NOT changeable afterward once saved. Internally the existing "hentai"   */
/* tag/state names (HENTAI_TAG_KEY, isHentai(), showHentaiOnly, etc.) are  */
/* left completely alone on purpose — renaming the actual stored tag       */
/* string risks silently orphaning every already-tagged entry/H image if   */
/* a migration step ever partially fails across devices. SFW mode just     */
/* hides/relabels all of that in the UI; NSFW mode looks exactly like the  */
/* app always has. See THEME_MODE below for the synced value itself.       */
/* ---------------------------------------------------------------------- */
const ADMIN_EMAIL = 'noondaeyoja@gmail.com';
let THEME_MODE = null;           // 'sfw' | 'nsfw' | null (not chosen yet)
let THEME_PICKER_BLOCKING = false; // true only while the auto-forced new-user picker is open
let THEME_PICKER_AUTO_SHOWN = false; // guards against re-popping the auto picker more than once per session
function isSFW() { return THEME_MODE === 'sfw'; }
function isAdmin() { return !!(CURRENT_USER && CURRENT_USER.email === ADMIN_EMAIL); }
// The one shared "mascot" glyph used for decorative placeholders (cover
// fallbacks, the global header, the Smut/Cute rating icon) — swaps for SFW
// accounts so nothing eggplant-shaped shows up for someone who picked the
// clean version.
function themeIcon() { return isSFW() ? '💕' : '🍆'; }

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
let REACTIONS_FIRESTORE_UNSUB = null; // same, for the Reactions library — see startReactionsFirestoreListener()
let H_FIRESTORE_UNSUB = null;    // same, for the standalone H library — see startHImagesFirestoreListener()
let AUTH_ERROR = '';
let AUTH_BUSY = false;
let SYNC_BUSY = false;           // true while the initial pull/push migration is running

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
// Folder layout: one "Yaoi Journal" root with "Images" and "Reactions"
// subfolders underneath it (previously a single flat "Yaoi Journal Images"
// folder — DRIVE_FOLDER_NAME/DRIVE_FOLDER_ID kept below only so any old
// cached references still resolve; new uploads go through the hierarchy).
const DRIVE_ROOT_FOLDER_NAME = 'Yaoi Journal';
const DRIVE_IMAGES_SUBFOLDER_NAME = 'Images';
const DRIVE_REACTIONS_SUBFOLDER_NAME = 'Reactions';
const DRIVE_H_SUBFOLDER_NAME = 'H'; // standalone H-tab uploads, see ensureDriveHFolder()
const DRIVE_FOLDER_NAME = 'Yaoi Journal Images'; // legacy flat-folder name, used only by the one-time consolidation tool
let DRIVE_FOLDER_ID = null; // cached once found/created, see ensureDriveFolder()

// Raw HD-scan lines already fully handled (auto-tagged, manually confirmed,
// or explicitly skipped) — see the HD-match tool. Prevents "re-matching the
// same titles" every time the same drive listing gets pasted back in.
let HD_RESOLVED_RAW = new Set();
// Duplicate-group signatures the user has explicitly said "not a duplicate,
// keep both" for — see Review Duplicates. Prevents that same pair from
// re-surfacing every visit.
let IGNORED_DUP_GROUPS = new Set();
// Same idea as IGNORED_DUP_GROUPS above but for the perceptual-hash-based
// "Possible Duplicates" scanners in the Images and Reactions tabs — those
// scanners used to have zero memory (every scan recomputed from nothing),
// which is why the same ~40 groups kept coming back for review forever.
let IGNORED_IMAGE_DUP_GROUPS = new Set();
let IGNORED_MEME_DUP_GROUPS = new Set();
let IGNORED_H_DUP_GROUPS = new Set();
// Which existing (entry-sourced) images the user has "pulled" into the H
// tab — a Set of imageKey(dataUrl), same lightweight technique as
// IMAGE_TAG_MAP below, so a photo already attached to a journal entry can be
// flagged into H without duplicating the underlying image data anywhere.
// Flagged images are excluded from the normal Images tab aggregation (see
// allAppImages()) so they stop "floating around the rest of the app".
let H_IMAGE_KEYS = new Set();
// User-created custom mood groups for the Reactions library (e.g. "creepy",
// "cute") on top of the 4 built-in moods — synced across devices the same
// way as the sets above (Firestore meta doc + local IDB mirror).
// Images and Reactions used to keep two completely separate group lists
// (IMAGE_GROUPS here, CUSTOM_MOODS in Reactions) — creating "Foodie" in one
// gallery never made it available in the other, so anything worth grouping
// had to be organized twice. Per her request, they now share one
// vocabulary: IMAGE_GROUPS (declared further down, near the Images tab
// code) is set to this SAME Set object rather than a new one, so adding a
// group from either gallery is instantly visible in both — see
// addImageGroup/addCustomMood and their rename/delete counterparts, which
// now persist to both legacy meta keys and clean up tags in both
// IMAGE_TAG_MAP and every reaction's moodTags. NSFW's H_GROUPS stays its
// own separate, private list, unaffected by this merge.
let CUSTOM_MOODS = new Set();

let db = null;
let ALL_ENTRIES = [];              // in-memory cache, synced with IndexedDB
let ALL_REACTIONS = [];            // meme/reaction image library, in-memory cache
let ALL_H_IMAGES = [];             // standalone H-tab uploads (not pulled from an entry), in-memory cache
let DETAIL_EDIT_MODE = false;      // whether the detail page's top fields are in edit mode
let TAG_EDIT_MODE = false;         // whether the Tags panel is showing its editable (toggle/add/save) UI
let TAG_ENTRIES_FILTER = null;     // which tag name the "view entries with this tag" screen is showing
let TAG_FILTER_OPEN = false;       // whether the homepage tag multi-select dropdown panel is open
let FILTERS_COLLAPSED = false;     // whether the homepage search/tabs/format/Status/Tags/Ratings&Flags block is tucked away
let SEARCH_INPUT_SHOULD_FOCUS = false; // one-shot flag: refocus the global search box after it causes a view jump
let MEME_SEARCH_INPUT_SHOULD_FOCUS = false; // stays false on a fresh nav into Reactions so the mobile keyboard doesn't pop uninvited
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
  lolFilter: null,          // null or 1-5, meaning "at least N laughing faces"
  cryFilter: null,          // null or 1-5, meaning "at least N crying faces"
  flagFilter: null,         // null or 'green'|'red'|'black'
  linkFilter: false,        // true = only show entries with a reading link attached
  noLinkFilter: false,      // true = only show entries WITHOUT a reading link attached
  storyStatusFilter: null,  // null or 'WIP'|'Finished' — the story's own completion state
  showArtworkOnly: false,   // "Artwork" filter — entries tagged as artwork
  search: '',
};

// Shared by both paths back to a completely clean homepage — the footer
// Journal button and the "Yaoi Journal" logo/name in the global header.
// Clears every filter and the search box, not just the favorites/on-HD/
// hentai toggles, so either one always lands on the same blank-slate view.
function resetHomeFiltersClean() {
  STATE.shelf = 'ALL';
  STATE.tagFilters = [];
  STATE.search = '';
  STATE.showFavoritesOnly = false;
  STATE.showOnDriveOnly = false;
  STATE.showHentaiOnly = false;
  STATE.showArtworkOnly = false;
  STATE.smutFilter = null;
  STATE.qualityFilter = null;
  STATE.lolFilter = null;
  STATE.cryFilter = null;
  STATE.flagFilter = null;
  STATE.linkFilter = false;
  STATE.noLinkFilter = false;
  STATE.storyStatusFilter = null;
  FILTERS_COLLAPSED = false;
}

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
      if (!_db.objectStoreNames.contains(STORE_H_IMAGES)) {
        _db.createObjectStore(STORE_H_IMAGES, { keyPath: 'id' });
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

// Every IndexedDB write goes through this one queue instead of firing its
// own independent transaction the instant it's called. Right after an edit
// it's normal for several writers to all want the SAME record within
// milliseconds of each other — the save itself, the live Firestore
// listener's echo of that same write coming back down, and that echo's own
// Drive-hydration follow-up. Each used to open its own separate
// db.transaction() and race the others; IndexedDB doesn't promise those
// finish in the order they were called, so whichever one happened to still
// be mid-flight when an earlier one's transaction actually landed could get
// silently clobbered — losing an image moments after attaching it, with
// nothing in any of the individual calls looking wrong. Chaining every
// write onto one promise means each one now genuinely waits for the
// previous to fully commit before it even starts, so the write that
// actually happened last in real call order is the one guaranteed to win.
let IDB_WRITE_QUEUE = Promise.resolve();
function queueIdbWrite(fn) {
  const run = IDB_WRITE_QUEUE.then(fn, fn);
  IDB_WRITE_QUEUE = run.then(() => {}, () => {});
  return run;
}
// Snapshots a value with structuredClone before it goes on the write queue
// above. Queuing means the actual put() doesn't run until every write ahead
// of it has committed, which can be a real (if small) delay — and several
// call sites hand idbPut the SAME live object they keep mutating in place
// afterward (e.g. the Firestore listener immediately hands that exact
// object to hydrateDriveImages next). Without cloning here, a deferred
// write would serialize whatever that shared object happens to look like
// at the moment its turn finally comes up, not what it looked like when it
// was actually queued — silently persisting a stale/wrong snapshot even
// though IndexedDB itself clones synchronously on put(). Cloning up front
// pins down the correct data before anything else gets a chance to touch it.
function idbSnapshot(value) {
  try { return structuredClone(value); } catch (err) { return value; }
}
// Resolves on the TRANSACTION committing (tx.oncomplete), not just the
// individual put request succeeding (req.onsuccess). Those aren't the same
// moment — a request can fire onsuccess and then still have its whole
// transaction silently abort/roll back afterward, and a caller awaiting
// only req.onsuccess would believe a write landed when IndexedDB actually
// discarded it.
function idbPut(storeName, value) {
  const snapshot = idbSnapshot(value);
  return queueIdbWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(snapshot);
    let result;
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  }));
}

function idbBulkPut(storeName, values) {
  const snapshot = values.map(idbSnapshot);
  return queueIdbWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    snapshot.forEach((v) => store.put(v));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(storeName, key) {
  return queueIdbWrite(() => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  }));
}

// Used to bulk-load her original manga/anime library from seed_data.json
// into IndexedDB on every fresh browser/device — a one-time bootstrap from
// before Google sign-in existed, back when this was a single-user app.
// Left running unconditionally, it turned into a real problem the moment
// this app started going to other people: a brand-new beta user's very
// first sign-in on a fresh device would find this seeded data already
// sitting in local storage with nothing yet in their own Firestore account,
// and syncWithFirestore()'s "push up anything local-only" logic would treat
// it as theirs to upload — silently copying her entire library, hentai tags
// included, into a stranger's account. Her own data has lived safely in
// Firestore under her own uid for a long time now and doesn't need this
// bootstrap anymore, so this just marks seeding done without ever writing
// the seed entries, for every device from here on.
async function ensureSeeded() {
  const meta = await idbGet(STORE_META, 'seeded');
  if (meta && meta.value) return;
  await idbPut(STORE_META, { key: 'seeded', value: true });
}

// Every entry is supposed to have a semi/uke object (see addEntry()'s
// default shape), but at least one entry has been found on this account
// with both missing entirely — likely stray test data from early on, before
// that default was consistently applied. The Database table, CSV export,
// and Possible-Duplicates diff view all read e.semi.flag/e.uke.flag
// directly (no guard, since every OTHER call site already checks
// `e.semi &&` first), so a single entry like that threw and broke those
// screens for the WHOLE account, not just that one entry. Called wherever
// entries enter memory so nothing downstream has to guard against this again.
function normalizeEntry(e) {
  if (!e.semi) e.semi = { flag: null, notes: '', photo: null };
  if (!e.uke) e.uke = { flag: null, notes: '', photo: null };
  return e;
}

async function loadAllEntries() {
  ALL_ENTRIES = (await idbGetAll(STORE_ENTRIES)).map(normalizeEntry);
}

async function saveEntry(entry) {
  normalizeEntry(entry);
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

// Scoped per-gallery so uploading to Images never gets flagged as "you
// already have this" just because the same file happens to already exist
// as a Reactions-only upload (or vice versa) — Images and Reactions are
// separate pools now, so their duplicate checks shouldn't cross over.
// Legacy records saved before the source field existed (source == null)
// are still visible in both galleries (see allAppImages()/memeFilteredItems),
// so they still count as a dupe match either way.
function findReactionByHash(hash, source) {
  return ALL_REACTIONS.find((r) => r.hash === hash && (source == null || r.source == null || r.source === source));
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

// Saves the one-time SFW/NSFW choice both locally and to Firestore — same
// dual-write pattern as every other piece of synced meta state. There's
// deliberately no "unsave"/change function: once this is set it's meant to
// stay set (see the big comment above THEME_MODE).
async function saveThemeMode(mode) {
  THEME_MODE = mode;
  await idbPut(STORE_META, { key: 'themeMode', value: mode });
  pushMetaField('themeMode', mode);
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
    // Only fill in the proxy URL from the cloud if this device doesn't
    // already have one set locally — never overwrite a value someone just
    // typed in on this device with an older/blank remote one.
    if (typeof data.proxyUrl === 'string' && data.proxyUrl && !localStorage.getItem('yj_proxy_url')) {
      localStorage.setItem('yj_proxy_url', data.proxyUrl);
    }
    if (typeof data.tagSuggestionsCollapsed === 'boolean') {
      TAG_SUGGESTIONS_COLLAPSED = data.tagSuggestionsCollapsed;
      await idbPut(STORE_META, { key: 'tagSuggestionsCollapsed', value: TAG_SUGGESTIONS_COLLAPSED });
    }
    if (Array.isArray(data.homeCollapsedSections)) {
      HOME_COLLAPSED_SECTIONS = new Set([...HOME_COLLAPSED_SECTIONS, ...data.homeCollapsedSections]);
      await idbPut(STORE_META, { key: 'homeCollapsedSections', value: Array.from(HOME_COLLAPSED_SECTIONS) });
    }
    // Adopt whatever Drive folder id(s) another device already established
    // (see findOrCreateDriveFolder()) so this device never independently
    // searches/creates its own copy of "Yaoi Journal"/"Images"/"Reactions" —
    // that race is what caused the duplicate-folder bug in the first place.
    for (const key of Object.keys(data)) {
      if (key.indexOf('driveFolder:') === 0 && typeof data[key] === 'string' && data[key]) {
        const cached = await idbGet(STORE_META, key);
        if (!cached || !cached.value) await idbPut(STORE_META, { key, value: data[key] });
      }
    }
    // CUSTOM_MOODS and IMAGE_GROUPS are the same shared Set (see its
    // declaration) — merge incoming updates from EITHER legacy meta field
    // into it and reassign both variables together, so they can't drift
    // back apart into two separate objects as sync events come in.
    if ((Array.isArray(data.customMoods) && data.customMoods.length) || (Array.isArray(data.imageGroups) && data.imageGroups.length)) {
      const merged = new Set([...CUSTOM_MOODS, ...(data.customMoods || []), ...(data.imageGroups || [])]);
      CUSTOM_MOODS = merged;
      IMAGE_GROUPS = merged;
      await idbPut(STORE_META, { key: 'customMoods', value: Array.from(merged) });
      await idbPut(STORE_META, { key: 'imageGroups', value: Array.from(merged) });
    }
    if (data.imageTagMap && typeof data.imageTagMap === 'object') {
      IMAGE_TAG_MAP = { ...data.imageTagMap, ...IMAGE_TAG_MAP };
      await idbPut(STORE_META, { key: 'imageTagMap', value: IMAGE_TAG_MAP });
    }
    if (Array.isArray(data.hiddenGroupKeys) && data.hiddenGroupKeys.length) {
      HIDDEN_GROUP_KEYS = new Set([...HIDDEN_GROUP_KEYS, ...data.hiddenGroupKeys]);
      await idbPut(STORE_META, { key: 'hiddenGroupKeys', value: Array.from(HIDDEN_GROUP_KEYS) });
    }
    if (Array.isArray(data.deletedGroupKeys) && data.deletedGroupKeys.length) {
      DELETED_GROUP_KEYS = new Set([...DELETED_GROUP_KEYS, ...data.deletedGroupKeys]);
      await idbPut(STORE_META, { key: 'deletedGroupKeys', value: Array.from(DELETED_GROUP_KEYS) });
    }
    if (Array.isArray(data.ignoredImageDupGroups) && data.ignoredImageDupGroups.length) {
      IGNORED_IMAGE_DUP_GROUPS = new Set([...IGNORED_IMAGE_DUP_GROUPS, ...data.ignoredImageDupGroups]);
      await idbPut(STORE_META, { key: 'ignoredImageDupGroups', value: Array.from(IGNORED_IMAGE_DUP_GROUPS) });
    }
    if (Array.isArray(data.ignoredMemeDupGroups) && data.ignoredMemeDupGroups.length) {
      IGNORED_MEME_DUP_GROUPS = new Set([...IGNORED_MEME_DUP_GROUPS, ...data.ignoredMemeDupGroups]);
      await idbPut(STORE_META, { key: 'ignoredMemeDupGroups', value: Array.from(IGNORED_MEME_DUP_GROUPS) });
    }
    if (Array.isArray(data.ignoredHDupGroups) && data.ignoredHDupGroups.length) {
      IGNORED_H_DUP_GROUPS = new Set([...IGNORED_H_DUP_GROUPS, ...data.ignoredHDupGroups]);
      await idbPut(STORE_META, { key: 'ignoredHDupGroups', value: Array.from(IGNORED_H_DUP_GROUPS) });
    }
    if (Array.isArray(data.hImageKeys) && data.hImageKeys.length) {
      H_IMAGE_KEYS = new Set([...H_IMAGE_KEYS, ...data.hImageKeys]);
      await idbPut(STORE_META, { key: 'hImageKeys', value: Array.from(H_IMAGE_KEYS) });
    }
    if (Array.isArray(data.hGroups) && data.hGroups.length) {
      H_GROUPS = new Set([...H_GROUPS, ...data.hGroups]);
      await idbPut(STORE_META, { key: 'hGroups', value: Array.from(H_GROUPS) });
    }
    if (data.hTagMap && typeof data.hTagMap === 'object') {
      H_TAG_MAP = { ...data.hTagMap, ...H_TAG_MAP };
      await idbPut(STORE_META, { key: 'hTagMap', value: H_TAG_MAP });
    }
    if (Array.isArray(data.hHiddenGroupKeys) && data.hHiddenGroupKeys.length) {
      H_HIDDEN_GROUP_KEYS = new Set([...H_HIDDEN_GROUP_KEYS, ...data.hHiddenGroupKeys]);
      await idbPut(STORE_META, { key: 'hHiddenGroupKeys', value: Array.from(H_HIDDEN_GROUP_KEYS) });
    }
    if (Array.isArray(data.hDeletedGroupKeys) && data.hDeletedGroupKeys.length) {
      H_DELETED_GROUP_KEYS = new Set([...H_DELETED_GROUP_KEYS, ...data.hDeletedGroupKeys]);
      await idbPut(STORE_META, { key: 'hDeletedGroupKeys', value: Array.from(H_DELETED_GROUP_KEYS) });
    }
    if (data.hNoteMap && typeof data.hNoteMap === 'object') {
      H_NOTE_MAP = { ...data.hNoteMap, ...H_NOTE_MAP };
      await idbPut(STORE_META, { key: 'hNoteMap', value: H_NOTE_MAP });
    }
    // Only adopt a remote themeMode if this device doesn't already have one
    // cached — same "never overwrite what's already decided" rule as the
    // proxy URL above. Once set anywhere, it should read the same everywhere.
    if (typeof data.themeMode === 'string' && data.themeMode && !THEME_MODE) {
      THEME_MODE = data.themeMode;
      await idbPut(STORE_META, { key: 'themeMode', value: THEME_MODE });
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
  // Each drop here sets the same *TooLargeForSync flag the size-based
  // trimming below uses (without adding to trimmedFields — this isn't an
  // actual size problem, so no "too large to sync" toast should fire).
  // That flag is what tells restoreLocallyKeptImages() to patch this
  // device's local copy back in when the echo of this exact write comes
  // back down. Without it, an entry that already has some Drive-backed
  // screencaps and then gets ONE brand-new, not-yet-uploaded local image
  // (e.g. via "Attach to a read") would have this write go out with
  // screencaps: [] (correct, since the old ones are Drive-backed and don't
  // need to ride along) — but the live listener's echo of that same write
  // would then win with screencaps: [] and, with no flag telling it
  // otherwise, wipe the brand-new local-only image right back out within
  // seconds of attaching it. This was the actual cause of "attach to a
  // read" never sticking in the Unattached count.
  if (candidate.coverDriveId && candidate.coverUrl && candidate.coverUrl.startsWith('data:')) {
    candidate = { ...candidate, coverUrl: null, coverTooLargeForSync: true };
  }
  if (candidate.screencapDriveIds && candidate.screencapDriveIds.length && candidate.screencaps && candidate.screencaps.length) {
    candidate = { ...candidate, screencaps: [], screencapsTooLargeForSync: true };
  }
  if (candidate.semi && candidate.semi.photoDriveId && candidate.semi.photo) {
    candidate = { ...candidate, semi: { ...candidate.semi, photo: null }, semiPhotoTooLargeForSync: true };
  }
  if (candidate.uke && candidate.uke.photoDriveId && candidate.uke.photo) {
    candidate = { ...candidate, uke: { ...candidate.uke, photo: null }, ukePhotoTooLargeForSync: true };
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

// Finds (or creates, the very first time) a named Drive folder, optionally
// nested under a parent folder id. Two layers of protection against ever
// creating duplicates:
//   1. An in-flight promise cache keyed by (parent, name) — if two uploads
//      fire close together (e.g. cover + semi + uke edited in quick
//      succession, or a multi-image attach), the second call reuses the
//      first call's in-progress search-or-create instead of starting its
//      own, which is what used to spawn a fresh duplicate folder on every
//      near-simultaneous upload (root cause of the ~11 duplicate "Yaoi
//      Journal Images" folders from before this fix).
//   2. Once resolved, the folder id is cached in IndexedDB (so future
//      sessions on this device skip the search entirely) AND mirrored to
//      the Firestore meta doc (so other devices adopt the same canonical
//      folder instead of each independently searching/creating their own).
const DRIVE_FOLDER_LOCKS = new Map();
async function findOrCreateDriveFolder(name, parentId) {
  const cacheKey = 'driveFolder:' + (parentId || 'root') + ':' + name;
  if (DRIVE_FOLDER_LOCKS.has(cacheKey)) return DRIVE_FOLDER_LOCKS.get(cacheKey);
  const p = (async () => {
    const cached = await idbGet(STORE_META, cacheKey);
    if (cached && cached.value) return cached.value;
    const parentClause = parentId ? ` and '${parentId}' in parents` : '';
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`);
    const searchResp = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,createdTime)&orderBy=createdTime`);
    const searchData = await searchResp.json();
    let id;
    if (searchData.files && searchData.files.length) {
      id = searchData.files[0].id;
    } else {
      const metadata = { name, mimeType: 'application/vnd.google-apps.folder' };
      if (parentId) metadata.parents = [parentId];
      const createResp = await driveFetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata)
      });
      const createData = await createResp.json();
      if (!createData.id) throw new Error(`Could not create Drive folder "${name}": ` + JSON.stringify(createData));
      id = createData.id;
    }
    await idbPut(STORE_META, { key: cacheKey, value: id });
    pushMetaField(cacheKey, id);
    return id;
  })();
  DRIVE_FOLDER_LOCKS.set(cacheKey, p);
  try {
    return await p;
  } finally {
    DRIVE_FOLDER_LOCKS.delete(cacheKey);
  }
}
async function ensureDriveRootFolder() {
  return findOrCreateDriveFolder(DRIVE_ROOT_FOLDER_NAME, null);
}
async function ensureDriveImagesFolder() {
  const root = await ensureDriveRootFolder();
  const id = await findOrCreateDriveFolder(DRIVE_IMAGES_SUBFOLDER_NAME, root);
  DRIVE_FOLDER_ID = id; // keep legacy var in sync for any code still reading it directly
  return id;
}
async function ensureDriveReactionsFolder() {
  const root = await ensureDriveRootFolder();
  return findOrCreateDriveFolder(DRIVE_REACTIONS_SUBFOLDER_NAME, root);
}
async function ensureDriveHFolder() {
  const root = await ensureDriveRootFolder();
  return findOrCreateDriveFolder(DRIVE_H_SUBFOLDER_NAME, root);
}
// Legacy name, kept because a few call sites still reference it — resolves
// to the new "Yaoi Journal/Images" subfolder.
async function ensureDriveFolder() {
  return ensureDriveImagesFolder();
}

// Uploads a base64 data: URL image into the app's Drive folder (simple
// multipart upload) and returns the new file's id. `kind` picks which
// subfolder it lands in: 'reaction' -> Yaoi Journal/Reactions, 'h' -> Yaoi
// Journal/H, anything else -> Yaoi Journal/Images.
async function uploadToDrive(dataUrl, filename, kind) {
  const folderId = kind === 'reaction' ? await ensureDriveReactionsFolder()
    : kind === 'h' ? await ensureDriveHFolder()
    : await ensureDriveImagesFolder();
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
  // fetch() only rejects on a network failure, not on a 4xx/5xx response —
  // without this check, a "file not found" (e.g. an orphaned reference from
  // before the account migration) would let the JSON error body through as
  // if it were the actual image, get base64-encoded, and get saved as a
  // permanently "successful" dataUrl full of garbage — exactly what
  // happened to 21 NSFW uploads (see repairCorruptedHDataUrls()). Throwing
  // here instead lets every caller's existing try/catch treat it as the
  // failed download it actually is.
  if (!resp.ok) throw new Error(`Drive download failed (${resp.status}) for file ${fileId}`);
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

/* ---------------------------------------------------------------------- */
/* One-time Drive folder consolidation                                    */
/* Before the folder-race fix above, ensureDriveFolder() could spawn a new */
/* "Yaoi Journal Images" folder every time two uploads landed close        */
/* together, leaving a dozen-plus near-identical folders in her Drive with */
/* the images scattered across them (which is also why different devices   */
/* could see slightly different image counts — they weren't all reading    */
/* from the same folder). This walks every folder with that legacy name,   */
/* moves its files into the new Yaoi Journal/Images or Yaoi Journal/       */
/* Reactions subfolder (routed by filename prefix), then deletes the now-  */
/* empty duplicate. File IDs never change when a file is moved, so nothing */
/* in Firestore/IndexedDB needs to be touched — existing coverDriveId/     */
/* driveId references keep working exactly as before.                     */
/* ---------------------------------------------------------------------- */
let DRIVE_CONSOLIDATE = { running: false, summary: null };

async function findAllFoldersNamed(name, parentId) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`);
  const resp = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=1000`);
  const data = await resp.json();
  return data.files || [];
}

async function listFilesInFolder(folderId) {
  let files = [];
  let pageToken = null;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=nextPageToken,files(id,name,mimeType)&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`;
    const resp = await driveFetch(url);
    const data = await resp.json();
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return files;
}

async function moveDriveFile(fileId, newParentId, oldParentId) {
  return driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${oldParentId}&fields=id,parents`, { method: 'PATCH' });
}

async function deleteDriveFolder(folderId) {
  return driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}`, { method: 'DELETE' });
}

async function consolidateDriveFolders() {
  if (DRIVE_CONSOLIDATE.running) return;
  if (!driveTokenValid()) { showToast('Reconnect Google Drive first, then try this again.'); return; }
  DRIVE_CONSOLIDATE.running = true;
  DRIVE_CONSOLIDATE.summary = null;
  if (STATE.view === 'database') render();
  let movedImages = 0, movedReactions = 0, foldersRemoved = 0, failures = 0;
  try {
    const imagesFolderId = await ensureDriveImagesFolder();
    const reactionsFolderId = await ensureDriveReactionsFolder();
    const root = await ensureDriveRootFolder();

    // Legacy flat "Yaoi Journal Images" folders from before the hierarchy existed.
    const legacyFolders = await findAllFoldersNamed(DRIVE_FOLDER_NAME, null);
    // Any duplicate copies of the new subfolders themselves (e.g. created on
    // another device before this fix reached it).
    const dupImageFolders = (await findAllFoldersNamed(DRIVE_IMAGES_SUBFOLDER_NAME, root)).filter((f) => f.id !== imagesFolderId);
    const dupReactionFolders = (await findAllFoldersNamed(DRIVE_REACTIONS_SUBFOLDER_NAME, root)).filter((f) => f.id !== reactionsFolderId);

    const jobs = [
      ...legacyFolders.map((f) => ({ folder: f, defaultDest: 'auto' })),
      ...dupImageFolders.map((f) => ({ folder: f, defaultDest: 'images' })),
      ...dupReactionFolders.map((f) => ({ folder: f, defaultDest: 'reactions' })),
    ];

    for (const job of jobs) {
      const files = await listFilesInFolder(job.folder.id);
      for (const f of files) {
        if (f.mimeType === 'application/vnd.google-apps.folder') continue;
        const isReaction = job.defaultDest === 'reactions' || (job.defaultDest === 'auto' && /^reaction-/.test(f.name));
        const dest = isReaction ? reactionsFolderId : imagesFolderId;
        try {
          await moveDriveFile(f.id, dest, job.folder.id);
          if (isReaction) movedReactions++; else movedImages++;
        } catch (err) {
          console.error('Failed to move file during Drive consolidation:', f.name, err);
          failures++;
        }
      }
      try {
        await deleteDriveFolder(job.folder.id);
        foldersRemoved++;
      } catch (err) {
        console.error('Failed to delete empty duplicate Drive folder:', job.folder.id, err);
      }
    }
    DRIVE_CONSOLIDATE.summary = { movedImages, movedReactions, foldersRemoved, failures, scanned: jobs.length };
    showToast(jobs.length
      ? `Consolidated ${foldersRemoved} duplicate folder(s) — moved ${movedImages} image${movedImages === 1 ? '' : 's'} and ${movedReactions} reaction${movedReactions === 1 ? '' : 's'} into Yaoi Journal/Images and Yaoi Journal/Reactions.${failures ? ` (${failures} file(s) failed to move — safe to run again.)` : ''}`
      : 'No duplicate folders found — your Drive is already consolidated.');
  } catch (err) {
    console.error('Drive folder consolidation failed:', err);
    showToast('Consolidation failed: ' + (err && err.message || 'unknown error') + ' — safe to try again.');
  } finally {
    DRIVE_CONSOLIDATE.running = false;
    if (STATE.view === 'database') render();
  }
}

// Best-effort wrapper for upload call sites: the image is already cached
// locally and displaying fine regardless of whether this succeeds, so a
// Drive failure here should never block or fail the save — it just means
// this particular image stays local-only until the next successful upload
// or reconnect, same as the existing "too large to sync" case.
async function tryUploadImageToDrive(dataUrl, filename, kind) {
  try {
    return await uploadToDrive(dataUrl, filename, kind);
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

// hydrateDriveImages() above only ever ran for ONE entry at a time — the one
// you happened to open on the detail page, or whichever the live Firestore
// listener just touched. A device that's mostly used for browsing (e.g. a
// phone that never has every single entry individually opened) could go
// indefinitely without ever hydrating most images locally — and since
// allAppImages() used to only count images with a dataUrl already present,
// that showed up as "why does my phone only have 127 images when desktop has
// 190" (root cause: it's not that the images don't exist on the phone's
// account, it's that most were never downloaded to that device yet, and
// nothing was proactively fetching them). This walks every entry still
// missing a cover/semi/uke/screencap image it has a Drive id for and
// hydrates it, same retry-on-tab-open/reconnect pattern as
// hydrateMissingReactions()/hydrateMissingHImages().
let ENTRY_IMAGE_HYDRATE_BUSY = false;
function entryNeedsImageHydration(e) {
  return !!(
    (e.coverDriveId && !e.coverUrl) ||
    (e.semi && e.semi.photoDriveId && !e.semi.photo) ||
    (e.uke && e.uke.photoDriveId && !e.uke.photo) ||
    (e.screencapDriveIds && e.screencapDriveIds.length && (!e.screencaps || e.screencaps.length < e.screencapDriveIds.length))
  );
}
async function hydrateMissingEntryImages() {
  if (ENTRY_IMAGE_HYDRATE_BUSY) return;
  const missing = ALL_ENTRIES.filter(entryNeedsImageHydration);
  if (!missing.length) return;
  // There's real work waiting but no valid token to fetch it with — surface
  // the reconnect banner instead of bailing silently. Previously this guard
  // returned before ever setting DRIVE_NEEDS_RECONNECT, so a placeholder
  // could sit stuck with no visible explanation of why.
  if (!driveTokenValid()) { DRIVE_NEEDS_RECONNECT = true; return; }
  ENTRY_IMAGE_HYDRATE_BUSY = true;
  let lastRender = 0;
  for (const e of missing) {
    if (!driveTokenValid()) break; // token expired mid-run — stop rather than fail through the rest one by one
    try {
      await hydrateDriveImages(e);
    } catch (err) {
      console.error('Entry image hydrate failed:', err);
    }
    if (STATE.view === 'reactions' && Date.now() - lastRender > 400) {
      render();
      lastRender = Date.now();
    }
  }
  if (STATE.view === 'reactions') render();
  ENTRY_IMAGE_HYDRATE_BUSY = false;
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

// hydrateDriveReaction() above only ever used to get called once, during
// syncReactionsWithFirestore()'s boot-time merge, for reactions that were
// brand new to this device that boot. If the Drive token wasn't valid yet at
// that exact moment (e.g. a fresh sign-in on a device that hasn't tapped
// Reconnect yet — very much the normal state right after the mobile
// sign-in fix), every one of those downloads failed silently and, unlike
// entries (which get a retry via the live Firestore listener AND every
// future boot's merge), reactions had no other path that would ever try
// again — once a reaction was in local IndexedDB with dataUrl still null,
// it stayed a permanently-broken "?" thumbnail. This is the actual retry
// path: scans for anything still missing its image and Drive is reachable,
// and is called from navigate() whenever the Reactions tab is opened, and
// right after a successful Reconnect, instead of only once at boot.
let REACTION_HYDRATE_BUSY = false;
async function hydrateMissingReactions() {
  if (REACTION_HYDRATE_BUSY) return;
  const missing = ALL_REACTIONS.filter((r) => r.driveId && !r.dataUrl);
  if (!missing.length) return;
  if (!driveTokenValid()) { DRIVE_NEEDS_RECONNECT = true; return; }
  REACTION_HYDRATE_BUSY = true;
  let lastRender = 0;
  for (const r of missing) {
    if (!driveTokenValid()) break; // token expired mid-run — stop rather than fail through the rest one by one
    try {
      r.dataUrl = await downloadFromDrive(r.driveId);
      await idbPut(STORE_REACTIONS, r);
      const idx = ALL_REACTIONS.findIndex((x) => x.id === r.id);
      if (idx > -1) ALL_REACTIONS[idx] = r;
    } catch (err) {
      console.error('Reaction hydrate failed:', err);
    }
    if (STATE.view === 'meme' && Date.now() - lastRender > 400) {
      renderMemeLibraryInPlace();
      lastRender = Date.now();
    }
  }
  if (STATE.view === 'meme') renderMemeLibraryInPlace();
  REACTION_HYDRATE_BUSY = false;
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

  const remoteEntries = snap.docs.map((d) => normalizeEntry(d.data()));
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
      const data = normalizeEntry(change.doc.data());
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

// Reactions used to only ever sync at boot (syncReactionsWithFirestore()),
// with no live listener at all — unlike entries, which get updates from
// another device without needing a reload. That's exactly why a reaction
// added on the phone never showed up on the already-open desktop tab: there
// was nothing telling desktop anything had changed until its next full
// reload. This mirrors startFirestoreListener() above for the reactions
// collection so new/edited/deleted reactions show up live everywhere.
function startReactionsFirestoreListener(user) {
  if (REACTIONS_FIRESTORE_UNSUB) { REACTIONS_FIRESTORE_UNSUB(); REACTIONS_FIRESTORE_UNSUB = null; }
  const col = fbStore.collection('users').doc(user.uid).collection('reactions');
  let skippedFirst = false;
  REACTIONS_FIRESTORE_UNSUB = col.onSnapshot((snap) => {
    if (!skippedFirst) { skippedFirst = true; return; }
    let changed = false;
    snap.docChanges().forEach((change) => {
      const data = change.doc.data();
      if (change.type === 'removed') {
        if (ALL_REACTIONS.some((r) => r.id === data.id)) {
          ALL_REACTIONS = ALL_REACTIONS.filter((r) => r.id !== data.id);
          idbDelete(STORE_REACTIONS, data.id).catch(() => {});
          changed = true;
        }
        return;
      }
      const idx = ALL_REACTIONS.findIndex((r) => r.id === data.id);
      const local = idx > -1 ? ALL_REACTIONS[idx] : null;
      const rt = new Date(data.updatedAt || data.createdAt || 0).getTime();
      const lt = local ? new Date(local.updatedAt || local.createdAt || 0).getTime() : -1;
      if (rt >= lt) {
        // Same reasoning as restoreLocallyKeptImages() for entries: the
        // incoming doc has dataUrl stripped once a driveId exists (see
        // reactionSafeForFirestore()), so keep this device's own copy of the
        // image bytes instead of blanking it back to "still downloading".
        const patched = { ...data };
        if (!patched.dataUrl && local && local.dataUrl) patched.dataUrl = local.dataUrl;
        if (idx > -1) ALL_REACTIONS[idx] = patched; else ALL_REACTIONS.push(patched);
        idbPut(STORE_REACTIONS, patched).catch(() => {});
        hydrateDriveReaction(patched).catch(() => {});
        changed = true;
      }
    });
    if (changed && ['reactions', 'meme'].includes(STATE.view)) render();
  }, (err) => console.error('Reactions listener error:', err));
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

// Toasts used to auto-vanish after 2.2s with no way to dismiss them early or
// keep them up longer — too quick to actually read, per direct feedback.
// Now: stays up until the user taps OK (or 8s passes, as a safety net in
// case a toast fires while nothing's focused to click it, e.g. a background
// sync completing).
function showToast(msg) {
  const t = document.getElementById('toast');
  const msgEl = document.getElementById('toast-msg');
  if (msgEl) msgEl.textContent = msg; else t.textContent = msg;
  t.style.display = 'flex';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.style.display = 'none'; }, 8000);
}
function hideToast() {
  document.getElementById('toast').style.display = 'none';
  clearTimeout(showToast._t);
}

function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function closeModal() {
  THEME_PICKER_BLOCKING = false;
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('modal-sheet').innerHTML = '';
}

/* ---------------------------------------------------------------------- */
/* SFW/NSFW theme picker modal                                            */
/* Three ways this opens: (1) auto-forced once for a brand-new account —   */
/* no close button, backdrop click does nothing, has to pick one; (2) the  */
/* one-time "Choose your theme" button an existing pre-feature account     */
/* sees under Database > Synced Account — same picker, but closeable       */
/* since the button just stays there to try again; (3) the admin-only      */
/* read-only preview link — same picker again, but confirming never saves */
/* anything, it just closes so noondaeyoja can see exactly what a new      */
/* user sees without touching her own already-set theme.                  */
/* ---------------------------------------------------------------------- */
function themePickerModalHtml(opts) {
  const preview = !!(opts && opts.preview);
  const autoForced = !!(opts && opts.autoForced);
  return `
    <div class="modal-close-corner-wrap">
      ${!autoForced ? `<button class="modal-close-x" data-close-modal="1" title="Close">✕</button>` : ''}
      <h3>Choose your Theme</h3>
      <p style="font-size:12.5px;color:var(--text-dim);margin:0 0 14px;">${preview
        ? "Preview only — this is exactly what a new user sees. It won't change your own theme."
        : "This is a one-time choice for your account — it can't be changed later, so take a look at both before picking."}</p>
      <div class="theme-pick-card" data-theme-pick="sfw" id="theme-pick-sfw" style="border:2px solid transparent;border-radius:10px;padding:12px;cursor:pointer;background:rgba(255,255,255,0.03);margin-bottom:10px;">
        <div style="font-size:26px;">💕</div>
        <div style="font-weight:600;margin:6px 0 2px;">SFW Version</div>
        <div style="font-size:12px;color:var(--text-dim);">The clean version — no explicit content, no 18+ gallery. Just reading/watching tracking, ratings, and reactions.</div>
      </div>
      <div class="theme-pick-card" data-theme-pick="nsfw" id="theme-pick-nsfw" style="border:2px solid transparent;border-radius:10px;padding:12px;cursor:pointer;background:rgba(255,255,255,0.03);">
        <div style="font-size:26px;">💦</div>
        <div style="font-weight:600;margin:6px 0 2px;">NSFW Version</div>
        <div style="font-size:12px;color:var(--text-dim);">Everything unlocked — explicit tagging, the NSFW gallery, and every rating option.</div>
        <label style="display:flex;align-items:flex-start;gap:6px;margin-top:8px;font-size:12px;color:var(--text-dim);cursor:pointer;">
          <input type="checkbox" id="theme-age-confirm" style="margin-top:2px;">
          <span>I confirm I am 18 years of age or older.</span>
        </label>
      </div>
      <p style="font-size:10.5px;color:var(--text-dim);margin:12px 0 0;">This is a personal media-tracking tool — you're responsible for anything you upload to it.</p>
      <div class="modal-actions" style="margin-top:14px;">
        ${preview ? `<button class="btn-ghost" data-close-modal="1">Close preview</button>` : ''}
        <button class="btn-primary" id="theme-confirm-btn" disabled>Confirm</button>
      </div>
    </div>
  `;
}
function openThemePickerModal(opts) {
  opts = opts || {};
  THEME_PICKER_BLOCKING = !!opts.autoForced;
  openModal(themePickerModalHtml(opts), { centered: true });
  wireThemePickerModal(opts);
}
function wireThemePickerModal(opts) {
  opts = opts || {};
  let selected = null;
  const sfwCard = document.getElementById('theme-pick-sfw');
  const nsfwCard = document.getElementById('theme-pick-nsfw');
  const ageBox = document.getElementById('theme-age-confirm');
  const confirmBtn = document.getElementById('theme-confirm-btn');
  function refresh() {
    if (sfwCard) sfwCard.style.borderColor = selected === 'sfw' ? '#ff4fc3' : 'transparent';
    if (nsfwCard) nsfwCard.style.borderColor = selected === 'nsfw' ? '#ff4fc3' : 'transparent';
    const valid = selected === 'sfw' || (selected === 'nsfw' && ageBox && ageBox.checked);
    if (confirmBtn) confirmBtn.disabled = !valid;
  }
  if (sfwCard) sfwCard.onclick = () => { selected = 'sfw'; refresh(); };
  if (nsfwCard) nsfwCard.onclick = (ev) => { if (ev.target === ageBox) return; selected = 'nsfw'; refresh(); };
  if (ageBox) ageBox.onclick = (ev) => { ev.stopPropagation(); selected = 'nsfw'; refresh(); };
  if (confirmBtn) confirmBtn.onclick = async () => {
    if (!selected) return;
    if (opts.preview) { closeModal(); return; }
    await saveThemeMode(selected);
    closeModal();
    showToast(selected === 'sfw' ? '💕 SFW theme set' : '💦 NSFW theme set');
    render();
  };
}

function openModal(html, opts) {
  document.getElementById('modal-sheet').innerHTML = html;
  // Individual Images/Reactions/H file modals always want to open dead
  // center on screen (per her "core app setting" spec) rather than the
  // usual bottom-anchored sheet every other modal in the app uses — that
  // toggle lives on the overlay itself so it never leaks onto whatever
  // opens next.
  document.getElementById('overlay').classList.toggle('overlay-centered', !!(opts && opts.centered));
  document.getElementById('overlay').classList.add('open');
}

// Prev/next arrows for the individual Images/Reactions/H item modals — lets
// her step through the same set of items she was just browsing in the grid
// without closing the modal and tapping back in. `list` is the exact order
// the gallery grid was last rendered in (see IMAGES_NAV_LIST/MEME_NAV_LIST/
// H_NAV_LIST); `current` is this item's own id/dataUrl. Wraps around at
// either end so swiping/tapping never dead-ends. Returns nulls (no arrows)
// when there's nothing to step through — a single item, or a list this item
// isn't even part of (e.g. opened from the Possible Duplicates tab, which
// doesn't populate a nav list at all).
function mediaModalNavNeighbors(list, current) {
  if (!list || list.length < 2) return { prev: null, next: null };
  const idx = list.indexOf(current);
  if (idx === -1) return { prev: null, next: null };
  return {
    prev: list[(idx - 1 + list.length) % list.length],
    next: list[(idx + 1) % list.length],
  };
}
// Builds the actual prev/next chevron buttons, keyed to whichever gallery's
// data-*-nav-prev/next attribute the global click handler listens for.
function mediaModalNavArrowsHtml(attrPrefix, prev, next) {
  return `
    ${prev ? `<button class="modal-nav-arrow modal-nav-prev" data-${attrPrefix}-nav-prev="${escapeHtml(prev)}" title="Previous">‹</button>` : ''}
    ${next ? `<button class="modal-nav-arrow modal-nav-next" data-${attrPrefix}-nav-next="${escapeHtml(next)}" title="Next">›</button>` : ''}
  `;
}
// Swipe-to-navigate on mobile, on top of the tap-target chevrons above —
// wired onto the media wrapper right after the modal's HTML lands in the
// DOM. A horizontal drag that's clearly more horizontal than vertical (so it
// doesn't fight a vertical scroll inside the modal) triggers prev/next.
function wireModalSwipeNav(onPrev, onNext) {
  const wrap = document.getElementById('modal-media-nav');
  if (!wrap) return;
  let startX = null, startY = null;
  wrap.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) { startX = null; return; }
    startX = ev.touches[0].clientX; startY = ev.touches[0].clientY;
  }, { passive: true });
  wrap.addEventListener('touchend', (ev) => {
    if (startX === null) return;
    const t = ev.changedTouches && ev.changedTouches[0];
    const dx = t ? t.clientX - startX : 0;
    const dy = t ? t.clientY - startY : 0;
    startX = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && onNext) onNext(); else if (dx > 0 && onPrev) onPrev();
    }
  });
}

// Images/Reactions/H all accept short video clips now, not just stills — this
// is the one check every thumbnail/modal render site uses to decide between
// an <img> and a <video> tag for a given dataUrl.
function isVideoUrl(dataUrl) {
  return typeof dataUrl === 'string' && dataUrl.startsWith('data:video/');
}

// The Crop button used to hide for every GIF/WebP unconditionally — the
// worry being that flattening an animated file down to a single cropped
// frame via canvas would silently kill the animation. But WebP in
// particular is a completely normal general-purpose *static* image format
// now (most "Save Image" downloads from modern sites come out as WebP,
// animated or not), so that blanket rule was blocking Crop on plain,
// non-animated pictures too — this is what she was hitting. This actually
// peeks at the file bytes to tell real animated files apart from static
// ones saved with a gif/webp extension, so Crop only stays hidden for
// files that would truly lose something.
function isAnimatedImageDataUrl(dataUrl) {
  try {
    const comma = dataUrl.indexOf(',');
    const bin = atob(dataUrl.slice(comma + 1));
    if (dataUrl.startsWith('data:image/gif')) {
      // Animated GIFs carry one Graphic Control Extension block (0x21 0xF9)
      // per frame; a static GIF has at most one.
      let count = 0;
      for (let i = 0; i < bin.length - 1; i++) {
        if (bin.charCodeAt(i) === 0x21 && bin.charCodeAt(i + 1) === 0xF9) {
          count++;
          if (count > 1) return true;
        }
      }
      return false;
    }
    // Animated WebP files are the only ones that contain an 'ANIM'/'ANMF'
    // RIFF chunk — plain VP8/VP8L/VP8X stills never do.
    return bin.includes('ANIM');
  } catch (err) {
    // Anything that fails to parse falls back to the old conservative
    // behavior (treat as animated) rather than risk flattening a real one.
    return true;
  }
}
// Shared gate the Crop button uses everywhere: hide it for videos, and for
// gif/webp files that are actually animated (see isAnimatedImageDataUrl).
function isCroppableDataUrl(dataUrl) {
  return !!dataUrl && !isVideoUrl(dataUrl) && !(/^data:image\/(gif|webp)/.test(dataUrl) && isAnimatedImageDataUrl(dataUrl));
}

// Lets her save an image/video straight from the individual gallery view to
// her phone's library — she wants the Images/Reactions/NSFW galleries to
// work as an actual browsable photo library on mobile, not just something
// she can look at inside the app. A plain <a download> click is the most
// reliable cross-browser way to do this from a data: URL: on Android Chrome
// it saves straight to Downloads; on iOS Safari it hands the file to the
// share sheet / Files app, from which "Save Image" / long-press works same
// as any other downloaded photo.
function downloadDataUrl(dataUrl, filename) {
  if (!dataUrl) return;
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename || 'yaoi-journal-image';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
// "data:image/jpeg;base64,..." -> "jpeg" — used to give downloaded files a
// real extension instead of a bare "yaoi-journal-image" with none.
function dataUrlExt(dataUrl) {
  const m = /^data:(?:image|video)\/([a-z0-9]+)/i.exec(String(dataUrl || ''));
  return m ? m[1].replace('jpeg', 'jpg') : 'jpg';
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

// Same downscale as fileToCompressedDataUrl above, but starting from an
// already-stored data: URL instead of a fresh File — used by the Failed
// Uploads "Compress & Retry" flow to shrink a photo that was too big for
// Drive/Firestore the first time, without asking the user to re-pick the
// file from disk. Static images only; GIF/WebP/video call sites skip this
// entirely (see isVideoUrl/animated checks at each call site) since canvas
// re-encoding would flatten any animation.
function compressDataUrlHarder(dataUrl, maxDim = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
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
    img.src = dataUrl;
  });
}

// Shared by both the tap-to-pick file inputs AND the drag-and-drop zones
// below, so cover/semi/uke photo uploads only have one code path to keep in
// sync (compress → save locally → Drive upload in the background).
async function applyCoverFile(file) {
  if (!file) return;
  const dataUrl = await fileToCompressedDataUrl(file, 700);
  const e = getEntry(STATE.entryId);
  if (!e) return;
  e.coverUrl = dataUrl;
  // Once she's uploaded her own cover, it's hers to keep — a reference-site
  // match/re-match should never silently overwrite it again. This flag is
  // the only thing that gates the cover-overwrite in applySuggestedMatch(),
  // confirmReference(), and the bulk review queue below.
  e.coverIsUserUploaded = true;
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
}
async function applyCharPhotoFile(who, file) {
  if (!file) return;
  const dataUrl = await fileToCompressedDataUrl(file, 500);
  const e = getEntry(STATE.entryId);
  if (!e) return;
  const prevPhoto = e[who].photo;
  const prevPhotoDriveId = e[who].photoDriveId;
  if (prevPhoto && prevPhoto !== dataUrl) {
    // Replacing a semi/uke photo used to just discard the old one outright.
    // Per her spec: (1) it should keep counting under Semi-only/Uke-only —
    // photoHistory tracks every photo ever uploaded to this box, checked
    // alongside the current one in allAppImages() — and (2) it should land
    // in this entry's own Images container instead of vanishing.
    e[who].photoHistory = e[who].photoHistory || [];
    if (!e[who].photoHistory.includes(prevPhoto)) e[who].photoHistory.push(prevPhoto);
    e.screencaps = e.screencaps || [];
    e.screencapDriveIds = e.screencapDriveIds || [];
    if (!e.screencaps.includes(prevPhoto)) {
      e.screencaps.push(prevPhoto);
      e.screencapDriveIds.push(prevPhotoDriveId || null);
    }
  }
  e[who].photo = dataUrl;
  e[who].photoDriveId = null;
  await saveEntry(e);
  render();
  tryUploadImageToDrive(dataUrl, `${e.id}-${who}-photo.jpg`).then((fileId) => {
    if (!fileId) return;
    const fresh = getEntry(e.id);
    if (!fresh) return;
    fresh[who].photoDriveId = fileId;
    saveEntry(fresh);
  });
}
// Adds one or more files to the current entry's Images container —
// shared by both the "Add photo(s)" file input and the whole-container
// drag-and-drop zone (see wireImageDropZone() below), so dropping files
// behaves identically to picking them from the file dialog.
async function applyScreencapFiles(fileList) {
  const e = getEntry(STATE.entryId);
  if (!e || !fileList || !fileList.length) return;
  e.screencaps = e.screencaps || [];
  e.screencapDriveIds = e.screencapDriveIds || [];
  const newDataUrls = [];
  for (const file of fileList) {
    const dataUrl = await fileToCompressedDataUrl(file, 900);
    e.screencaps.push(dataUrl);
    newDataUrls.push(dataUrl);
  }
  await saveEntry(e);
  render();
  // Upload each new screencap to Drive in the background and append its id
  // once it resolves — order isn't guaranteed against further edits in the
  // meantime, so re-fetch the entry fresh before each append.
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
// Makes any element a drag-and-drop target for a single image file, with a
// `.drag-over` class toggled for visual feedback while a file is dragged
// over it. Previously the cover/semi/uke photo slots only accepted a tap
// that opened the native file picker — drag-and-drop is desktop-only by
// nature (there's no equivalent gesture on a touchscreen), so this is purely
// additive on top of the picker, not a replacement for it.
function wireImageDropZone(el, onFile) {
  let depth = 0;
  el.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    depth++;
    el.classList.add('drag-over');
  });
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    depth = 0;
    el.classList.remove('drag-over');
    const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) onFile(file);
  });
}

// Same drag-over/drop plumbing as wireImageDropZone above, but accepts
// multiple files at once and both images and video (that dropzone is
// single-file/image-only, used for cover/char-photo slots where only one
// picture makes sense) — this is what the Images/Reactions/H gallery main
// areas use so a whole batch of dragged files uploads in one drop.
function wireMultiFileDropZone(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    depth++;
    el.classList.add('drag-over');
  });
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    depth = 0;
    el.classList.remove('drag-over');
    const files = Array.from((ev.dataTransfer && ev.dataTransfer.files) || [])
      .filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (files.length) onFiles(files);
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

// A real back-stack, not a hardcoded "Back always goes to X" per screen.
// Every navigate() call (except a back navigation itself) pushes whatever
// screen we're LEAVING onto this stack, so the "← Back" button can pop it
// and return to wherever the user actually came from — previously every
// back button had a fixed target view baked into its markup (e.g. detail's
// was always data-nav="home"), which looked "random" any time an entry was
// opened from somewhere other than the home grid (Tag Entries, Database's
// Review/Duplicates tools, etc.) since it always dumped you at Home instead.
let NAV_HISTORY = [];
// The stack lives in a plain JS variable, which is wiped by ANY full reload —
// including ones the user never asked for: the auto-updating service worker
// below forces window.location.reload() the instant a new deploy takes over
// (so pushes show up without manual steps), and iOS routinely kills/reloads
// a backgrounded PWA's whole JS context on its own. Either one mid-session
// used to dump the user back at Home with an empty stack, which looked like
// "the back button randomly goes to the homepage" even though the button
// itself was working fine — the state it depended on just hadn't survived.
// Persisting to sessionStorage on every navigation and rehydrating at boot
// means a reload resumes on the same screen with history intact.
const NAV_STATE_KEY = 'yj_nav_state_v1';
function persistNavState() {
  try {
    sessionStorage.setItem(NAV_STATE_KEY, JSON.stringify({ view: STATE.view, entryId: STATE.entryId, history: NAV_HISTORY }));
  } catch (err) { /* private-browsing or storage-full — non-fatal, just won't survive that one reload */ }
}
function restoreNavState() {
  try {
    const raw = sessionStorage.getItem(NAV_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved.view === 'string') {
      STATE.view = saved.view;
      STATE.entryId = saved.entryId || null;
    }
    if (saved && Array.isArray(saved.history)) NAV_HISTORY = saved.history;
  } catch (err) { /* corrupt/missing — just boots to Home like before */ }
}
function navigate(view, entryId, opts) {
  const isBack = !!(opts && opts.isBack);
  // A modal (e.g. the Suggested Match Review carousel) is a separate overlay
  // layer that sits on top of #view-root and was never being closed on
  // navigation — so switching views (or just typing in the search box, which
  // routes through here too) while a modal was open left it stuck on screen,
  // invisibly blocking every tap on whatever loaded underneath it. Closing
  // it here guarantees a fresh navigation never has a stale modal in the way.
  closeModal();
  if (!isBack && STATE.view !== view) {
    NAV_HISTORY.push({ view: STATE.view, entryId: STATE.entryId });
    if (NAV_HISTORY.length > 30) NAV_HISTORY.shift();
  }
  STATE.view = view;
  STATE.entryId = entryId || null;
  DETAIL_EDIT_MODE = false;
  TAG_EDIT_MODE = false;
  TAG_FILTER_OPEN = false;
  window.scrollTo(0, 0);
  persistNavState();
  render();
  // Best-effort retries for Drive-backed images that may have missed their
  // only previous hydration attempt (e.g. this device's Drive token wasn't
  // valid yet the first time this entry/reaction synced down) — opening the
  // relevant screen is a natural, low-cost moment to try again.
  if (view === 'detail' && entryId) hydrateDriveImages(getEntry(entryId)).catch(() => {});
  if (view === 'meme') hydrateMissingReactions().catch(() => {});
  if (view === 'h') hydrateMissingHImages().catch(() => {});
  if (view === 'reactions') hydrateMissingEntryImages().catch(() => {});
}
// What every "← Back" button now calls, instead of a hardcoded data-nav
// target — pops the real previous screen off the stack. Falls back to Home
// if the stack is somehow empty (e.g. this screen was reached by a direct
// link/reload rather than by navigating within the app).
function navigateBack() {
  const prev = NAV_HISTORY.pop();
  if (prev) navigate(prev.view, prev.entryId, { isBack: true });
  else navigate('home');
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
        ${AUTH_BUSY ? `<button class="btn-primary auth-submit-btn" disabled>Please wait…</button>` : `
          <div id="gsi-button-container" style="display:flex;justify-content:center;margin-top:6px;min-height:44px;"></div>
          <div style="text-align:center;">
            <span data-google-signin-fallback="1" style="font-size:11.5px;color:var(--text-dim);text-decoration:underline;cursor:pointer;">Button not showing? Tap here</span>
          </div>
        `}
        <p style="font-size:11px;color:var(--text-dim);text-align:center;margin-top:12px;line-height:1.5;">
          You'll be asked to grant access to a private app folder in your Drive — this app can only see files it creates itself, nothing else in your Drive.
        </p>
      </div>
    </div>`;
}

function attachAuthHandlers() {
  const root = document.getElementById('view-root');
  const fallback = root.querySelector('[data-google-signin-fallback]');
  if (fallback) fallback.onclick = signInWithGoogle;
  if (!AUTH_BUSY) mountGisSignInButton();
}

// Renders Google's own "Sign in with Google" widget into #gsi-button-container.
// This is the fix for mobile/standalone-PWA sign-in stalling: it does NOT go
// through Firebase's signInWithPopup/signInWithRedirect at all (see the big
// comment above isStandalonePWA()/GOOGLE_OAUTH_CLIENT_ID for the underlying
// cross-origin-relay bug those depend on). Instead Google's own script talks
// directly to accounts.google.com and hands back an ID token via
// handleGisIdentityCredential(), which we exchange for a Firebase credential
// with signInWithCredential() — no popup window, no redirect navigation, no
// authDomain relay, so it isn't exposed to that failure mode on a standalone
// home-screen PWA the way signInWithRedirect was.
let GIS_IDENTITY_INITIALIZED = false;
function mountGisSignInButton(attempt) {
  attempt = attempt || 0;
  const container = document.getElementById('gsi-button-container');
  if (!container) return; // auth screen isn't mounted (e.g. already signed in)
  if (!window.google || !google.accounts || !google.accounts.id) {
    // GIS's script tag is `async defer`, so on a cold load it may not be
    // ready yet the first time the auth screen renders. Poll briefly rather
    // than giving up — the "Tap here" fallback link covers the case where it
    // never loads at all (e.g. blocked by a content blocker).
    if (attempt < 20) setTimeout(() => mountGisSignInButton(attempt + 1), 250);
    return;
  }
  if (!GIS_IDENTITY_INITIALIZED) {
    google.accounts.id.initialize({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      callback: handleGisIdentityCredential,
      auto_select: false,
    });
    GIS_IDENTITY_INITIALIZED = true;
  }
  container.innerHTML = '';
  google.accounts.id.renderButton(container, {
    type: 'standard', theme: 'filled_blue', size: 'large', shape: 'pill',
    text: 'continue_with', logo_alignment: 'center', width: 280,
  });
}

async function handleGisIdentityCredential(response) {
  AUTH_BUSY = true; AUTH_ERROR = ''; render();
  try {
    const cred = firebase.auth.GoogleAuthProvider.credential(response.credential);
    await fbAuth.signInWithCredential(cred);
    // onAuthStateChanged (boot()) takes it from here and swaps off the auth
    // screen. While we're still close to this click/tap gesture, also try to
    // grab a Drive token — best effort, the Reconnect banner covers failure.
    try {
      const resp = await requestDriveToken(true);
      DRIVE_ACCESS_TOKEN = resp.access_token;
      DRIVE_TOKEN_EXPIRES_AT = Date.now() + (Number(resp.expires_in || 3300) * 1000) - 60000;
      DRIVE_NEEDS_RECONNECT = false;
    } catch (driveErr) {
      console.error('Initial Drive token request failed:', driveErr);
    }
  } catch (err) {
    AUTH_ERROR = authErrorMessage(err);
  } finally {
    AUTH_BUSY = false;
    render();
  }
}

// Installed/home-screen PWAs (especially iOS Safari "Add to Home Screen" and
// most Android WebAPK installs) frequently can't open or return a real
// signInWithPopup() window — there's no separate browser chrome to host it,
// so the popup silently fails to appear.
function isStandalonePWA() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
}

// Drive's OAuth access token is now minted via Google Identity Services
// (accounts.google.com/gsi/client, loaded in index.html) instead of through
// Firebase's signInWithPopup/signInWithRedirect + credentialFromResult().
// Confirmed live (both on desktop and matching the reported mobile stall):
// this app's origin (noondaeyoja.github.io) differs from Firebase's
// authDomain (yaoi-journal.firebaseapp.com), and Firebase's redirect/popup
// result relies on a cross-origin iframe relay between those two origins to
// hand back the credential. Modern browsers' third-party storage
// restrictions can silently break that relay — the sign-in with Google
// itself completes fine, but the promise on our side never resolves or
// rejects, so nothing happens and nothing errors. GIS's token client talks
// directly to Google with no such intermediate relay, so it isn't exposed
// to that failure mode. Firebase Auth itself (CURRENT_USER / Firestore
// identity) is untouched by this — it never depended on reading a
// credential back, only on onAuthStateChanged, which is unaffected.
const GOOGLE_OAUTH_CLIENT_ID = '831194325870-hi0rg7a86n5tbqrk75hfdq90f5lkucrp.apps.googleusercontent.com';
let GIS_TOKEN_CLIENT = null;
function getGisTokenClient() {
  if (!window.google || !google.accounts || !google.accounts.oauth2) return null;
  if (!GIS_TOKEN_CLIENT) {
    GIS_TOKEN_CLIENT = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: () => {} // overridden per-call below
    });
  }
  return GIS_TOKEN_CLIENT;
}
// promptConsent: true forces Google's consent screen (used the first time,
// and for manual reconnects, so we're guaranteed a fresh token back rather
// than a silent no-op). Must be called from directly within a user gesture
// (a click handler) — GIS's popup has the same "needs a real click" rule as
// any other popup, it just doesn't share Firebase's cross-origin relay bug.
function requestDriveToken(promptConsent) {
  return new Promise((resolve, reject) => {
    const client = getGisTokenClient();
    if (!client) { reject(new Error('Google sign-in library not loaded yet — try again in a moment.')); return; }
    client.callback = (resp) => {
      if (resp && resp.access_token) resolve(resp);
      else reject(new Error((resp && resp.error) || 'No access token returned'));
    };
    client.error_callback = (err) => reject(new Error((err && err.type) || 'Google sign-in popup failed'));
    client.requestAccessToken({ prompt: promptConsent ? 'consent' : '' });
  });
}

// Fallback path only — the primary sign-in control is Google's own rendered
// button (mountGisSignInButton()/handleGisIdentityCredential() above), wired
// up because it was confirmed to actually work in a standalone/home-screen
// PWA where signInWithRedirect() previously stalled (same cross-origin
// authDomain relay bug as the old Drive-reconnect failure — see the comment
// above GOOGLE_OAUTH_CLIENT_ID). This function is now only reached via the
// small "Button not showing? Tap here" link, for the rare case GIS's script
// itself fails to load (e.g. blocked by a content/ad blocker).
async function signInWithGoogle() {
  AUTH_BUSY = true; AUTH_ERROR = ''; render();
  const provider = new firebase.auth.GoogleAuthProvider();
  if (isStandalonePWA()) {
    try {
      await fbAuth.signInWithRedirect(provider);
      return;
    } catch (err) {
      AUTH_ERROR = authErrorMessage(err);
      AUTH_BUSY = false;
      render();
      return;
    }
  }
  try {
    await fbAuth.signInWithPopup(provider);
    // onAuthStateChanged (wired in boot()) picks up the signed-in user from
    // here. Immediately follow up with the Drive consent popup — still
    // inside this same click-triggered async function, so it's close
    // enough to the original gesture for the browser to allow it.
    try {
      const resp = await requestDriveToken(true);
      DRIVE_ACCESS_TOKEN = resp.access_token;
      DRIVE_TOKEN_EXPIRES_AT = Date.now() + (Number(resp.expires_in || 3300) * 1000) - 60000;
      DRIVE_NEEDS_RECONNECT = false;
    } catch (driveErr) {
      // Not fatal — she's signed in either way, and the reconnect banner
      // will offer another explicit shot at granting Drive access.
      console.error('Initial Drive token request failed:', driveErr);
    }
  } catch (err) {
    if (err && err.code === 'auth/popup-closed-by-user') {
      AUTH_BUSY = false; render(); return;
    }
    if (err && (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment' || err.code === 'auth/cancelled-popup-request')) {
      try {
        await fbAuth.signInWithRedirect(provider);
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

// Mints a fresh Drive access token — used by the "Reconnect Google Drive"
// banner that shows up once the ~1hr token expires or a Drive call comes
// back 401. Goes straight through GIS (see comment above); no Firebase
// popup/redirect involved at all anymore.
async function reconnectGoogleDrive() {
  // Immediate feedback the instant the click registers, so a totally silent
  // failure (an exception thrown before any network call even starts) is
  // still visibly distinguishable from the button not being wired up at all.
  showToast('Connecting to Google Drive…');
  try {
    const resp = await requestDriveToken(true);
    DRIVE_ACCESS_TOKEN = resp.access_token;
    DRIVE_TOKEN_EXPIRES_AT = Date.now() + (Number(resp.expires_in || 3300) * 1000) - 60000;
    DRIVE_NEEDS_RECONNECT = false;
    showToast('Reconnected to Google Drive.');
    render();
    // The moment the token becomes valid is exactly when anything that
    // previously failed to hydrate (reactions with no retry path of their
    // own, or the entry currently open) should get another shot.
    hydrateMissingReactions().catch(() => {});
    hydrateMissingHImages().catch(() => {});
    hydrateMissingEntryImages().catch(() => {});
    if (STATE.view === 'detail' && STATE.entryId) hydrateDriveImages(getEntry(STATE.entryId)).catch(() => {});
    return true;
  } catch (err) {
    console.error('Drive reconnect failed:', err);
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
  if (REACTIONS_FIRESTORE_UNSUB) { REACTIONS_FIRESTORE_UNSUB(); REACTIONS_FIRESTORE_UNSUB = null; }
  if (H_FIRESTORE_UNSUB) { H_FIRESTORE_UNSUB(); H_FIRESTORE_UNSUB = null; }
  DRIVE_ACCESS_TOKEN = null;
  DRIVE_TOKEN_EXPIRES_AT = 0;
  DRIVE_FOLDER_ID = null;
  NAV_HISTORY = [];
  try { sessionStorage.removeItem(NAV_STATE_KEY); } catch (err) {}
  await fbAuth.signOut();
}

/* ---------------------------------------------------------------------- */
/* Render: root switch                                                    */
/* ---------------------------------------------------------------------- */

function renderGlobalHeader() {
  const needsReconnect = DRIVE_NEEDS_RECONNECT || (CURRENT_USER && !driveTokenValid());
  return `
    <div class="global-header">
      <span class="global-header-brand" data-header-home="1">
        <span class="global-header-logo">${themeIcon()}</span><span class="global-header-title">${isSFW() ? 'BL Journal' : 'Yaoi Journal'}</span>
      </span>
      <div class="global-search-bar">
        <span>🔍</span>
        <input type="search" id="search-input" placeholder="Search all reads &amp; anime..." value="${escapeHtml(STATE.search)}">
      </div>
      <button class="header-add-btn" data-add-entry="1" title="Add new entry">+</button>
    </div>
    ${needsReconnect ? `
      <div class="drive-reconnect-banner">
        <span>🔌 Google Drive needs reconnecting to sync images.</span>
        <button data-reconnect-drive="1">Reconnect</button>
      </div>` : ''}`;
}

function render() {
  const root = document.getElementById('view-root');
  if (!CURRENT_USER) {
    root.innerHTML = renderAuthScreen();
    attachAuthHandlers();
    return;
  }
  // Defensive only — the nav button to get here is already hidden for SFW
  // accounts, but a restored nav-history state from before switching (or any
  // other stray path into STATE.view === 'h') shouldn't be able to reach the
  // NSFW gallery either.
  if (STATE.view === 'h' && isSFW()) STATE.view = 'home';
  let body = '';
  if (STATE.view === 'home') body = renderHome();
  else if (STATE.view === 'detail') body = renderDetail(getEntry(STATE.entryId));
  else if (STATE.view === 'tags') body = renderTagManager();
  else if (STATE.view === 'tagEntries') body = renderTagEntries();
  else if (STATE.view === 'hdMatch') body = renderHdMatch();
  else if (STATE.view === 'reactions') body = renderReactionsLibrary();
  else if (STATE.view === 'meme') body = renderMemeLibrary();
  else if (STATE.view === 'h') body = renderHLibrary();
  else if (STATE.view === 'database') body = renderDatabase();
  else if (STATE.view === 'review') body = renderReviewQueue();
  else if (STATE.view === 'duplicates') body = renderDuplicates();
  root.innerHTML = renderGlobalHeader() + body;
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
    } else if (STATE.showArtworkOnly) {
      if (!isArtwork(e)) return false;
    } else if (STATE.format && e.format !== STATE.format) {
      // STATE.format is null when both the book and TV icons are off — that
      // means no format filter at all, so Reading and Watching entries show
      // mixed together instead of the usual either/or split.
      return false;
    }
    if (STATE.shelf !== 'ALL' && e.shelf !== STATE.shelf) return false;
    if (STATE.storyStatusFilter && e.status !== STATE.storyStatusFilter) return false;
    if (STATE.tagFilters.length) {
      const allTags = [...(e.tags || []), ...(e.customTags || [])];
      if (!STATE.tagFilters.some((t) => allTags.includes(t))) return false;
    }
    if (STATE.smutFilter && (e.smutRating || 0) < STATE.smutFilter) return false;
    if (STATE.qualityFilter && (e.qualityRating || 0) < STATE.qualityFilter) return false;
    if (STATE.lolFilter && (e.lolRating || 0) < STATE.lolFilter) return false;
    if (STATE.cryFilter && (e.cryRating || 0) < STATE.cryFilter) return false;
    if (STATE.flagFilter) {
      const hasFlag = (e.semi && e.semi.flag === STATE.flagFilter) || (e.uke && e.uke.flag === STATE.flagFilter);
      if (!hasFlag) return false;
    }
    if (STATE.linkFilter && !e.readingLink) return false;
    if (STATE.noLinkFilter && e.readingLink) return false;
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
// Whether the "💡 Suggestions" panel in Tag Manager is collapsed. Persisted
// (idb + Firestore meta) so the choice sticks across sessions/devices instead
// of resetting to always-expanded every time Tag Manager is opened.
let TAG_SUGGESTIONS_COLLAPSED = false;
async function setSuggestionsCollapsed(collapsed) {
  TAG_SUGGESTIONS_COLLAPSED = collapsed;
  await idbPut(STORE_META, { key: 'tagSuggestionsCollapsed', value: collapsed });
  pushMetaField('tagSuggestionsCollapsed', collapsed);
}
// Homepage shelf rows (Currently Reading, Completed, etc. — see homeSectionHtml())
// each remember their own collapsed/expanded state here, keyed by row id, so
// a section she's collapsed stays collapsed across visits/devices instead of
// resetting open every time the homepage re-renders.
let HOME_COLLAPSED_SECTIONS = new Set();
async function toggleHomeSectionCollapsed(rowId) {
  if (HOME_COLLAPSED_SECTIONS.has(rowId)) HOME_COLLAPSED_SECTIONS.delete(rowId); else HOME_COLLAPSED_SECTIONS.add(rowId);
  const arr = Array.from(HOME_COLLAPSED_SECTIONS);
  await idbPut(STORE_META, { key: 'homeCollapsedSections', value: arr });
  pushMetaField('homeCollapsedSections', arr);
}
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
const ARTWORK_TAG_KEY = 'artwork';
function isArtwork(e) {
  return [...(e.tags || []), ...(e.customTags || [])].some((t) => normalizeTagKey(t) === ARTWORK_TAG_KEY);
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
    ? `<img src="${escapeHtml(coverSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="${isSuggested ? 'opacity:.55' : ''}" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>${themeIcon()}</div>'">`
    : `<div class="cover-placeholder">${themeIcon()}</div>`;
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

// Homepage shelf/suggested-matches sections — the header is a toggle (tap
// to expand/collapse, state remembered per-row in HOME_COLLAPSED_SECTIONS,
// synced like every other UI toggle in the app), same idea as the "Hide
// Filters" toggle above the filter panel. No more horizontal-scroll carousel
// with side arrows — opening a section shows every item in that category as
// a full grid, same layout the search/filtered results view already uses.
function homeSectionHtml(rowId, title, count, innerHtml) {
  const collapsed = HOME_COLLAPSED_SECTIONS.has(rowId);
  return `
    <div class="section-title home-section-title" data-toggle-home-section="${rowId}">
      <span class="home-section-chevron">${collapsed ? '▸' : '▾'}</span> ${escapeHtml(title)} <span style="opacity:.6">(${count})</span>
    </div>
    <div class="home-section-body ${collapsed ? 'collapsed' : ''}" id="${rowId}">
      <div class="cover-grid">${innerHtml}</div>
    </div>`;
}

function renderHome() {
  const entries = filteredEntries();
  const tags = topTags(ALL_ENTRIES.filter((e) => !STATE.format || e.format === STATE.format));

  let body = '';
  if (STATE.shelf === 'ALL' && !STATE.tagFilters.length && !STATE.search && !STATE.showFavoritesOnly && !STATE.showOnDriveOnly && !STATE.showHentaiOnly && !STATE.showArtworkOnly && !STATE.smutFilter && !STATE.qualityFilter && !STATE.lolFilter && !STATE.cryFilter && !STATE.flagFilter && !STATE.linkFilter && !STATE.noLinkFilter && !STATE.storyStatusFilter) {
    // Suggested-matches row sits above the shelf rows, same section-title +
    // horizontal-scroll treatment, so unconfirmed matches are easy to spot
    // and jump into without leaving the homepage.
    const suggestedGroup = entries.filter((e) => e.suggestedMatch);
    if (suggestedGroup.length > 0) {
      body += homeSectionHtml('row-suggested', '🔎 Suggested Matches', suggestedGroup.length, suggestedGroup.map((e) => renderCoverCard(e, true)).join(''));
    }
    // grouped by shelf, each group scrolls horizontally so hundreds of entries
    // don't turn into an endless vertical scroll.
    // Watching entries used to be locked to always showing under 'Completed'
    // here, back when the detail page had no way to set a Watching entry's
    // shelf to anything else. Now that the Details container has a real
    // "Viewing Status" picker (same shelf options as Reading Status), that
    // restriction would just hide a Watching entry from the homepage the
    // moment she picks anything other than Completed — so it's grouped the
    // same way regardless of format now.
    const shelvesToShow = SHELVES_READING;
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      const rowId = 'row-' + shelf.replace(/[^a-z0-9]+/gi, '-');
      body += homeSectionHtml(rowId, shelf, group.length, group.map((e) => renderCoverCard(e)).join(''));
    });
    if (!body) body = `<div class="empty-state">Nothing here yet. Tap + to add a ${STATE.format === 'reading' ? 'manhwa/manga' : STATE.format === 'watching' ? 'anime' : 'title'}.</div>`;
  } else {
    body = entries.length
      ? `<div class="cover-grid">${entries.map((e) => renderCoverCard(e)).join('')}</div>`
      : `<div class="empty-state">No matches. Try clearing filters.</div>`;
  }

  // Always rendered regardless of format — this used to hide itself while
  // viewing Anime/TV (on the theory that watching entries only ever use the
  // 'Completed' shelf), but per her direct correction that silently dropped
  // the whole Reading Status row out of the filter box, which she hadn't
  // asked for. Restored unconditionally.
  const shelfChips = ['ALL', ...SHELVES_READING].map((s) => `<div class="chip ${STATE.shelf === s ? 'active' : ''}" data-shelf="${escapeHtml(s)}">${s === 'ALL' ? 'All' : escapeHtml(s)}</div>`).join('');
  // Story Status (WIP/Finished) — the story's own completion state, distinct
  // from Reading Status (her shelf: Currently Reading/Completed/etc, which is
  // about her progress through it, not whether the author's finished it).
  const storyStatusChips = ['ALL', 'WIP', 'Finished'].map((s) => `<div class="chip ${(STATE.storyStatusFilter || 'ALL') === s ? 'active' : ''}" data-story-status-filter="${escapeHtml(s)}">${s === 'ALL' ? 'All' : escapeHtml(s)}</div>`).join('');
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

  const smutChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.smutFilter && n <= STATE.smutFilter ? 'active' : ''}" data-smut-filter="${n}" title="${n}+ ${isSFW() ? 'hearts' : 'eggplants'}">${themeIcon()}</span>`).join('');
  const qualityChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.qualityFilter && n <= STATE.qualityFilter ? 'active' : ''}" data-quality-filter="${n}" title="${n}+ hearts">❤️</span>`).join('');
  const lolChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.lolFilter && n <= STATE.lolFilter ? 'active' : ''}" data-lol-filter="${n}" title="${n}+ laughs">😂</span>`).join('');
  const cryChips = [1, 2, 3, 4, 5].map((n) => `<span class="rating-pick-icon ${STATE.cryFilter && n <= STATE.cryFilter ? 'active' : ''}" data-cry-filter="${n}" title="${n}+ cries">😭</span>`).join('');
  // Semi/Uke green/red/black flags are hidden entirely for SFW accounts —
  // her explicit call: this is a general relationship-dynamic marker, not
  // just a hentai-adjacent thing, but it's still part of the SFW cut.
  const flagChips = isSFW() ? '' : FLAG_COLORS.map((c) => `<span class="rating-pick-icon flag-filter-icon ${STATE.flagFilter === c ? 'active' : ''}" data-flag-filter="${c}" style="color:${FLAG_HEX[c]}" title="${c} flag">&#9873;</span>`).join('');
  // Favorites/On HD used to be separate bottom-nav destinations; they're now
  // toggle chips here instead (same nav-filter mechanism the hentai chip
  // already used), so removing them from the bottom nav doesn't lose access.
  // Hidden entirely for SFW accounts, same as the H nav item/gallery.
  const hentaiChip = isSFW() ? '' : `<span class="rating-pick-icon flag-filter-icon ${STATE.showHentaiOnly ? 'active' : ''}" data-nav-filter="${STATE.showHentaiOnly ? 'home' : 'hentai'}" title="NSFW only">💦</span>`;
  const artworkChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.showArtworkOnly ? 'active' : ''}" data-nav-filter="${STATE.showArtworkOnly ? 'home' : 'artwork'}" title="Artwork only">🖌️</span>`;
  const favoritesChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.showFavoritesOnly ? 'active' : ''}" data-nav-filter="${STATE.showFavoritesOnly ? 'home' : 'favorites'}" title="Favorites only">💜</span>`;
  const onDriveChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.showOnDriveOnly ? 'active' : ''}" data-nav-filter="${STATE.showOnDriveOnly ? 'home' : 'onDrive'}" title="On HD only">💾</span>`;
  // Reading-link chip — unlike favorites/on-HD/hentai this doesn't replace
  // the whole shelf, it's an additive AND-filter like smut/quality/flag, so
  // it stacks with whatever else is already filtered.
  const linkChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.linkFilter ? 'active' : ''}" data-link-filter="1" title="Has a reading link attached">🔗</span>`;
  // Inverse of linkChip — same additive AND-filter mechanism, just for
  // entries with NO reading link attached instead of ones that have one.
  const noLinkChip = `<span class="rating-pick-icon flag-filter-icon ${STATE.noLinkFilter ? 'active' : ''}" data-no-link-filter="1" title="No reading link attached">⛓️‍💥</span>`;

  return `
    <div class="app-header">
      <button class="filters-toggle-btn" data-toggle-filters="1">${FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters'}</button>
      <div class="filters-collapsible ${FILTERS_COLLAPSED ? 'collapsed' : ''}" id="filters-collapsible">
        <div class="filter-section-label">Reading Status</div>
        <div class="shelf-row">${shelfChips}</div>
        <div class="filter-section-label">Story Status</div>
        <div class="shelf-row">${storyStatusChips}</div>
        <div class="filter-section-label">Tags</div>
        ${tagMultiselect}
        <div class="filter-section-label">Ratings &amp; Flags</div>
        <div class="rating-pick-row">${formatIcons}${hentaiChip}${artworkChip}${favoritesChip}${onDriveChip}${linkChip}${noLinkChip}<span class="rating-pick-divider"></span>${smutChips}<span class="rating-pick-divider"></span>${qualityChips}<span class="rating-pick-divider"></span>${lolChips}<span class="rating-pick-divider"></span>${cryChips}${flagChips ? `<span class="rating-pick-divider"></span>${flagChips}` : ''}</div>
      </div>
    </div>
    <main>${body}</main>
    ${renderBottomNav('home')}
  `;
}

function renderBottomNav(active) {
  return `
    <div class="bottom-nav">
      <button data-nav="home" class="${active === 'home' ? 'active' : ''}"><span class="icon">📔</span>Journal</button>
      <button data-nav="tags" class="${active === 'tags' ? 'active' : ''}"><span class="icon">🏷️</span>Tags</button>
      <button data-nav="reactions" class="${active === 'reactions' ? 'active' : ''}"><span class="icon">🖼️</span>Images</button>
      <button data-nav="meme" class="${active === 'meme' ? 'active' : ''}"><span class="icon">🎭</span>Reactions</button>
      ${!isSFW() ? `<button data-nav="h" class="${active === 'h' ? 'active' : ''}"><span class="icon">💦</span>NSFW</button>` : ''}
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
    // A hidden tag isn't offered as a "reuse this instead" suggestion — if
    // it's hidden, it shouldn't resurface anywhere as a possible tag to use.
    if (isHiddenTag(name)) continue;
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

function renderTagManager() {
  const counts = allTagCounts();
  const allNames = Object.keys(counts).sort((a, b) => a.localeCompare(b));
  const activeNames = allNames.filter((t) => !isHiddenTag(t));
  const hiddenActiveNames = allNames.filter((t) => USER_HIDDEN_TAG_KEYS.has(normalizeTagKey(t)) && !DELETED_TAG_KEYS.has(normalizeTagKey(t)));
  const names = TAG_MGR_TAB === 'hidden' ? hiddenActiveNames : activeNames;

  const hideSuggestions = TAG_MGR_TAB === 'active' ? tagHideSuggestions(activeNames, counts) : [];
  const mergeSuggestions = TAG_MGR_TAB === 'active' ? tagMergeSuggestions(activeNames, counts) : [];
  const suggestionCount = hideSuggestions.length + mergeSuggestions.length;
  const suggestionsHtml = suggestionCount ? `
    <div class="panel" style="border-color:var(--yellow-soft);">
      <div class="panel-title-row" style="margin-bottom:${TAG_SUGGESTIONS_COLLAPSED ? '0' : '10px'};">
        <div class="panel-title" style="margin:0;">💡 Suggestions (${suggestionCount})</div>
        <button class="toggle-switch ${TAG_SUGGESTIONS_COLLAPSED ? '' : 'on'}" data-toggle-suggestions="1" title="${TAG_SUGGESTIONS_COLLAPSED ? 'Show suggestions' : 'Hide suggestions'}" role="switch" aria-checked="${TAG_SUGGESTIONS_COLLAPSED ? 'false' : 'true'}"><span class="toggle-knob"></span></button>
      </div>
      ${TAG_SUGGESTIONS_COLLAPSED ? '' : `
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
      `}
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
            <button class="icon-btn-inline" data-tagmgr-merge="${escapeHtml(t)}" title="Merge into another tag">🔀</button>
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
        <button class="back-btn" data-nav-back="1">← Back</button>
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
        <button class="back-btn" data-nav-back="1">← Back</button>
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

// Images gallery = the individual-reads images container: pictures that live
// on a journal entry (screencaps, semi/uke photos, always attached to a
// read) PLUS anything uploaded directly through the Images tab's own upload
// button (tagged source: 'images' by addReactionFiles — see below). Here,
// "Unattached" means "no individual read item attached to it".
// The standalone Reactions library (bottom-nav "Reactions") is a separate
// collection, organized by mood tag instead of by read — its uploads are
// tagged source: 'reactions' and deliberately excluded from this
// aggregation, so a picture saved as a mood reaction doesn't also clutter
// the Images gallery. There, "attached"/"unattached" instead means whether
// it's been sorted into a mood group yet (see renderMemeLibrary /
// renderHLibrary) — a different axis entirely from entry-attachment.
function allAppImages() {
  const map = new Map();
  // Images this device knows exist (has a Drive id for) but hasn't
  // downloaded a local copy of yet — see hydrateMissingEntryImages(). These
  // used to be invisible to this whole aggregation (only images with a
  // dataUrl already present got counted), which is why a device that hadn't
  // opened every single entry showed a much lower "Images" count than one
  // that had — the images weren't missing, they just hadn't been fetched to
  // THIS device yet. Counting them as pending placeholders makes the count
  // accurate immediately, and they fill in with the real picture as
  // hydration catches up.
  const pending = [];
  ALL_ENTRIES.forEach((e) => {
    if (e.semi && e.semi.photo) {
      const rec = map.get(e.semi.photo) || { dataUrl: e.semi.photo, reactionId: null, createdAt: e.updatedAt || e.createdAt, kinds: new Set() };
      rec.kinds.add('semi'); map.set(e.semi.photo, rec);
    } else if (e.semi && e.semi.photoDriveId) {
      pending.push({ pending: true, entryId: e.id, entryTitle: e.title, kinds: ['semi'], createdAt: e.updatedAt || e.createdAt });
    }
    if (e.uke && e.uke.photo) {
      const rec = map.get(e.uke.photo) || { dataUrl: e.uke.photo, reactionId: null, createdAt: e.updatedAt || e.createdAt, kinds: new Set() };
      rec.kinds.add('uke'); map.set(e.uke.photo, rec);
    } else if (e.uke && e.uke.photoDriveId) {
      pending.push({ pending: true, entryId: e.id, entryTitle: e.title, kinds: ['uke'], createdAt: e.updatedAt || e.createdAt });
    }
    // Semi/Uke-only should keep showing every photo ever uploaded to that
    // box, not just the current one — a replaced photo moves into this
    // entry's own Images container (screencaps, see applyCharPhotoFile) but
    // stays tagged 'semi'/'uke' here via photoHistory so it still counts
    // under those filters instead of quietly becoming a plain screencap.
    (e.semi && e.semi.photoHistory || []).forEach((src) => {
      const rec = map.get(src) || { dataUrl: src, reactionId: null, createdAt: e.updatedAt || e.createdAt, kinds: new Set() };
      rec.kinds.add('semi'); map.set(src, rec);
    });
    (e.uke && e.uke.photoHistory || []).forEach((src) => {
      const rec = map.get(src) || { dataUrl: src, reactionId: null, createdAt: e.updatedAt || e.createdAt, kinds: new Set() };
      rec.kinds.add('uke'); map.set(src, rec);
    });
    (e.screencaps || []).forEach((src) => {
      const rec = map.get(src) || { dataUrl: src, reactionId: null, createdAt: e.updatedAt || e.createdAt, kinds: new Set() };
      rec.kinds.add('screencap'); map.set(src, rec);
    });
    const missingScreencaps = (e.screencapDriveIds || []).length - (e.screencaps || []).length;
    for (let i = 0; i < missingScreencaps; i++) {
      pending.push({ pending: true, entryId: e.id, entryTitle: e.title, kinds: ['screencap'], createdAt: e.updatedAt || e.createdAt });
    }
  });
  const hydrated = Array.from(map.values())
    // Images pulled into the H tab (see H_IMAGE_KEYS / pullImageIntoH) stay
    // attached to whatever entry they came from, but stop showing up here —
    // "without them floating around the rest of the yaoi journal", per her
    // spec for the H section.
    .filter((img) => !H_IMAGE_KEYS.has(imageKey(img.dataUrl)))
    .map((img) => ({
      ...img,
      dataUrl: img.dataUrl,
      pending: false,
      kinds: Array.from(img.kinds),
      attachedEntries: ALL_ENTRIES.filter((e) => entryImageUrls(e).includes(img.dataUrl)),
    }));
  // Standalone reactions that were uploaded straight into the Images tab (via
  // #reaction-upload-input -> addReactionFiles()) never touch any entry, so
  // they'd never show up in the `map` built above — that's what made direct
  // uploads to Images invisible (no count bump, nothing in "Unattached").
  // Fold in any ALL_REACTIONS record whose dataUrl isn't already accounted
  // for by an entry, skipping anything already pulled into H — but ONLY ones
  // explicitly sourced from the Images tab itself (source: 'images'). This
  // used to also let legacy (source == null, predates the split) records
  // through, on the theory that most historical content predates the split
  // so hiding it from neither gallery was safest — but in practice nearly
  // all 250+ legacy records already live in the Reactions pool (see
  // reactionsPoolItems()), so that let almost the entire Reactions library
  // leak into Images' "Unattached" bucket too. Per her direct correction,
  // the relationship is one-directional: a pure Reactions-side item (which
  // legacy records are, since that's where they already show) should only
  // ever show in Reactions, never in Images, unless it was actually uploaded
  // through the Images tab (source: 'images') or is genuinely attached to an
  // entry (covered separately by `hydrated` above, independent of source).
  const standaloneReactions = ALL_REACTIONS
    .filter((r) => r.dataUrl && !map.has(r.dataUrl) && !H_IMAGE_KEYS.has(imageKey(r.dataUrl)) && r.source === 'images')
    .map((r) => ({
      dataUrl: r.dataUrl,
      reactionId: r.id,
      createdAt: r.createdAt,
      pending: false,
      kinds: [],
      attachedEntries: ALL_ENTRIES.filter((e) => entryImageUrls(e).includes(r.dataUrl)),
    }));
  const pendingItems = pending.map((p) => ({
    ...p,
    dataUrl: null,
    reactionId: null,
    attachedEntries: [{ id: p.entryId, title: p.entryTitle }],
  }));
  return [...hydrated, ...standaloneReactions, ...pendingItems]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

// Deletes a single image wherever it lives in the app — used by the Possible
// Duplicates X button, which needs to remove "this specific copy" regardless
// of whether it's a standalone reaction, a semi/uke photo, or a screencap
// (possibly on more than one entry at once, if the same file was uploaded
// twice). Reaction-backed images should go through deleteReaction directly;
// this covers the rest.
async function deleteImageFromGalleryEverywhere(img) {
  if (img.reactionId) {
    await deleteReaction(img.reactionId);
    return;
  }
  const dataUrl = img.dataUrl;
  if (!dataUrl) return;
  for (const e of ALL_ENTRIES.slice()) {
    let changed = false;
    if (e.semi && e.semi.photo === dataUrl) {
      if (e.semi.photoDriveId) deleteFromDrive(e.semi.photoDriveId);
      e.semi.photo = null; e.semi.photoDriveId = null;
      changed = true;
    }
    if (e.uke && e.uke.photo === dataUrl) {
      if (e.uke.photoDriveId) deleteFromDrive(e.uke.photoDriveId);
      e.uke.photo = null; e.uke.photoDriveId = null;
      changed = true;
    }
    if ((e.screencaps || []).includes(dataUrl)) {
      const idx = e.screencaps.indexOf(dataUrl);
      e.screencaps.splice(idx, 1);
      if (e.screencapDriveIds && e.screencapDriveIds[idx]) {
        deleteFromDrive(e.screencapDriveIds[idx]);
        e.screencapDriveIds.splice(idx, 1);
      }
      changed = true;
    }
    if (changed) await saveEntry(e);
  }
}

/* ---------------------------------------------------------------------- */
/* Image groupings + per-image tags — same idea as Reactions' custom moods */
/* (create a group, filter by it), but for the Images tab. Images here     */
/* are derived from entries rather than being their own persisted record, */
/* so tags are stored in a lookup map keyed by a fast (non-cryptographic)  */
/* hash of the data-URL rather than on the image "object" itself.         */
/* ---------------------------------------------------------------------- */

// Deliberately NOT a security/dedup hash (that's hashDataUrl, SHA-256, used
// for reaction duplicate detection) — this just needs to be fast enough to
// run on hundreds of images synchronously during a render, and stable for
// the same string. Sampling ~256 points instead of every character keeps it
// O(1)-ish regardless of how big a given data URL is.
function imageKey(dataUrl) {
  const s = String(dataUrl || '');
  const len = s.length;
  let h1 = 0, h2 = 0;
  const step = Math.max(1, Math.floor(len / 256));
  for (let i = 0; i < len; i += step) {
    const c = s.charCodeAt(i);
    h1 = (h1 * 31 + c) | 0;
    h2 = (h2 * 131 + c) | 0;
  }
  return len.toString(36) + '-' + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
// Same Set object as CUSTOM_MOODS (see the comment on that declaration) —
// this is what actually makes the two galleries' groups shared rather than
// just coincidentally-named. Kept as its own variable since the rest of
// the Images tab code already refers to it by this name throughout.
let IMAGE_GROUPS = CUSTOM_MOODS;
let IMAGE_TAG_MAP = {}; // { [imageKey]: string[] group names }
function persistImageGroups() {
  idbPut(STORE_META, { key: 'imageGroups', value: Array.from(IMAGE_GROUPS) });
  pushMetaField('imageGroups', Array.from(IMAGE_GROUPS));
}
function persistImageTagMap() {
  idbPut(STORE_META, { key: 'imageTagMap', value: IMAGE_TAG_MAP });
  pushMetaField('imageTagMap', IMAGE_TAG_MAP);
}
// Shared by both galleries' add/rename/delete group functions below —
// persists under both legacy meta keys (a device that's only ever synced
// one of the two fields still ends up with the full merged list) and
// cleans up the group name everywhere it might be tagged: per-image
// (IMAGE_TAG_MAP) and per-reaction (moodTags), regardless of which
// gallery the rename/delete was triggered from.
function persistSharedGroups() {
  persistImageGroups();
  persistCustomMoods();
}
function renameSharedGroupEverywhere(oldKey, finalKey) {
  Object.keys(IMAGE_TAG_MAP).forEach((k) => {
    if (IMAGE_TAG_MAP[k].includes(oldKey)) {
      const tags = new Set(IMAGE_TAG_MAP[k].filter((t) => t !== oldKey));
      tags.add(finalKey);
      IMAGE_TAG_MAP[k] = Array.from(tags);
    }
  });
  persistImageTagMap();
  ALL_REACTIONS.forEach((r) => {
    if ((r.moodTags || []).includes(oldKey)) {
      const tags = new Set(r.moodTags.filter((t) => t !== oldKey));
      tags.add(finalKey);
      r.moodTags = Array.from(tags);
      saveReaction(r);
    }
  });
}
function deleteSharedGroupEverywhere(key) {
  Object.keys(IMAGE_TAG_MAP).forEach((k) => {
    if (IMAGE_TAG_MAP[k].includes(key)) IMAGE_TAG_MAP[k] = IMAGE_TAG_MAP[k].filter((t) => t !== key);
  });
  persistImageTagMap();
  ALL_REACTIONS.forEach((r) => {
    if ((r.moodTags || []).includes(key)) {
      r.moodTags = r.moodTags.filter((t) => t !== key);
      saveReaction(r);
    }
  });
}
// Shared helpers for the hide/delete lifecycle above — used by both
// galleries since it's all backed by the one shared group Set.
function isHiddenGroup(name) {
  return HIDDEN_GROUP_KEYS.has(name) || DELETED_GROUP_KEYS.has(name);
}
async function setGroupSoftHidden(name, hidden) {
  if (hidden) HIDDEN_GROUP_KEYS.add(name); else HIDDEN_GROUP_KEYS.delete(name);
  const arr = Array.from(HIDDEN_GROUP_KEYS);
  await idbPut(STORE_META, { key: 'hiddenGroupKeys', value: arr });
  pushMetaField('hiddenGroupKeys', arr);
}
async function recordDeletedGroup(name) {
  DELETED_GROUP_KEYS.add(name);
  const arr = Array.from(DELETED_GROUP_KEYS);
  await idbPut(STORE_META, { key: 'deletedGroupKeys', value: arr });
  pushMetaField('deletedGroupKeys', arr);
}
async function restoreDeletedGroup(name) {
  DELETED_GROUP_KEYS.delete(name);
  const arr = Array.from(DELETED_GROUP_KEYS);
  await idbPut(STORE_META, { key: 'deletedGroupKeys', value: arr });
  pushMetaField('deletedGroupKeys', arr);
}
// How many distinct images/reactions currently carry this group — counted
// by imageKey so the same picture attached in both places only counts once.
function groupUsageCount(key) {
  const urls = new Set();
  Object.keys(IMAGE_TAG_MAP).forEach((imgKey) => { if ((IMAGE_TAG_MAP[imgKey] || []).includes(key)) urls.add(imgKey); });
  ALL_REACTIONS.forEach((r) => { if ((r.moodTags || []).includes(key)) urls.add(imageKey(r.dataUrl)); });
  return urls.size;
}
// Chip rows (filter bars, tag-toggle lists) only ever show non-hidden
// groups — same rule Tag Manager already applies to hidden tags.
function visibleGroupList() {
  return Array.from(IMAGE_GROUPS).filter((k) => !isHiddenGroup(k)).sort((a, b) => a.localeCompare(b));
}
function addImageGroup(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  const deleted = Array.from(DELETED_GROUP_KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  if (deleted) { showToast(`"${deleted}" was deleted — restore it from Manage > Hidden first`); return null; }
  const existing = Array.from(IMAGE_GROUPS).find((k) => k.toLowerCase() === name.toLowerCase());
  const key = existing || name;
  if (!existing) { IMAGE_GROUPS.add(key); persistSharedGroups(); }
  return key;
}
function renameImageGroup(oldKey, rawNewName) {
  const newName = String(rawNewName || '').trim();
  if (!newName || newName === oldKey) return;
  IMAGE_GROUPS.delete(oldKey);
  const mergedInto = Array.from(IMAGE_GROUPS).find((k) => k.toLowerCase() === newName.toLowerCase());
  const finalKey = mergedInto || newName;
  if (!mergedInto) IMAGE_GROUPS.add(finalKey);
  persistSharedGroups();
  renameSharedGroupEverywhere(oldKey, finalKey);
  if (IMAGE_GROUP_FILTER === oldKey) IMAGE_GROUP_FILTER = finalKey;
  if (MEME_STATE.moodFilter === oldKey) MEME_STATE.moodFilter = finalKey;
}
function deleteImageGroup(key) {
  IMAGE_GROUPS.delete(key);
  persistSharedGroups();
  deleteSharedGroupEverywhere(key);
  recordDeletedGroup(key);
  if (IMAGE_GROUP_FILTER === key) IMAGE_GROUP_FILTER = null;
  if (MEME_STATE.moodFilter === key) MEME_STATE.moodFilter = null;
}
function getImageTags(dataUrl) {
  const own = IMAGE_TAG_MAP[imageKey(dataUrl)] || [];
  // An image that's ALSO been pulled into the Reactions library and sorted
  // into a mood there stores that tag on the reaction record's moodTags,
  // not in IMAGE_TAG_MAP — a completely separate field. Now that the two
  // galleries' groups are merged, that should count as "tagged" here too
  // instead of still showing Untagged until it's tagged a second time from
  // the Images side specifically.
  const reactionTags = ALL_REACTIONS.filter((r) => r.dataUrl === dataUrl).flatMap((r) => r.moodTags || []);
  return reactionTags.length ? Array.from(new Set([...own, ...reactionTags])) : own;
}
// "Untagged" in the Images gallery means not sorted into ANY of: a mood
// group, Semi only, or Uke only — being a semi/uke photo already counts as
// "tagged" in her mental model, even before it's also given a mood group.
function isImageUntagged(img) {
  const kinds = img.kinds || [];
  return !getImageTags(img.dataUrl).length && !kinds.includes('semi') && !kinds.includes('uke');
}
function toggleImageTag(dataUrl, tag) {
  const key = imageKey(dataUrl);
  const tags = new Set(IMAGE_TAG_MAP[key] || []);
  if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
  IMAGE_TAG_MAP[key] = Array.from(tags);
  persistImageTagMap();
}
// Shared manage-groups modal — same row layout as Tag Manager (count,
// hide toggle, merge, rename, delete) since Images/Reactions now share one
// group list. Both galleries' "Manage" buttons open this; only the title
// text they pass in differs.
function renderSharedGroupManagerModal(title) {
  GROUP_MGR_MODAL_TITLE = title;
  const allNames = Array.from(IMAGE_GROUPS).sort((a, b) => a.localeCompare(b));
  const activeNames = allNames.filter((k) => !isHiddenGroup(k));
  const hiddenActiveNames = allNames.filter((k) => HIDDEN_GROUP_KEYS.has(k) && !DELETED_GROUP_KEYS.has(k));
  const names = GROUP_MGR_TAB === 'active' ? activeNames : hiddenActiveNames;
  const rows = GROUP_MGR_TAB === 'active'
    ? names.map((name) => `
        <div class="tagmgr-row">
          <div class="tagmgr-click-area" style="cursor:default;">
            <div class="tagmgr-name">${escapeHtml(name)}</div>
            <div class="tagmgr-count">${groupUsageCount(name)} item${groupUsageCount(name) === 1 ? '' : 's'}</div>
          </div>
          <div class="tagmgr-actions">
            <button class="toggle-switch on" data-groupmgr-hide="${escapeHtml(name)}" title="Hide from filters (keeps the data)" role="switch" aria-checked="true"><span class="toggle-knob"></span></button>
            <button class="icon-btn-inline" data-groupmgr-merge="${escapeHtml(name)}" title="Merge into another group">🔀</button>
            <button class="icon-btn-inline" data-groupmgr-rename="${escapeHtml(name)}" title="Rename this group everywhere">✏️</button>
            <button class="icon-btn-inline" data-groupmgr-delete="${escapeHtml(name)}" title="Delete this group everywhere">🗑️</button>
          </div>
        </div>`).join('')
    : names.map((name) => `
        <div class="tagmgr-row">
          <div class="tagmgr-click-area" style="cursor:default;">
            <div class="tagmgr-name">${escapeHtml(name)}</div>
            <div class="tagmgr-count">${groupUsageCount(name)} item${groupUsageCount(name) === 1 ? '' : 's'}</div>
          </div>
          <div class="tagmgr-actions">
            <button class="toggle-switch" data-groupmgr-hide="${escapeHtml(name)}" title="Show in filters again" role="switch" aria-checked="false"><span class="toggle-knob"></span></button>
          </div>
        </div>`).join('');
  const deletedRows = GROUP_MGR_TAB === 'hidden' && DELETED_GROUP_KEYS.size ? `
    <div class="panel-title" style="margin:16px 0 8px;">Permanently deleted</div>
    <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">These had their tag removed from every image/reaction — restoring just allows the name to be used again; old items won't get it back.</div>
    ${Array.from(DELETED_GROUP_KEYS).sort().map((key) => `
      <div class="tagmgr-row">
        <div class="tagmgr-name" style="flex:1;">${escapeHtml(key)}</div>
        <button class="ref-btn" data-restore-group="${escapeHtml(key)}">Allow again</button>
      </div>`).join('')}
  ` : '';
  const tabsHtml = `
    <div class="tagmgr-tabs" style="margin-bottom:8px;">
      <button class="tagmgr-tab ${GROUP_MGR_TAB === 'active' ? 'active' : ''}" data-groupmgr-tab="active">Active (${activeNames.length})</button>
      <button class="tagmgr-tab ${GROUP_MGR_TAB === 'hidden' ? 'active' : ''}" data-groupmgr-tab="hidden">Hidden (${hiddenActiveNames.length + DELETED_GROUP_KEYS.size})</button>
    </div>`;
  openModal(`
    <h3>${escapeHtml(title)}</h3>
    <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">Shared between Images and Reactions — a group made or renamed in either gallery shows up in both. Hiding keeps a group's tags intact but off the chip rows; deleting removes it everywhere.</div>
    ${tabsHtml}
    <div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;">
      ${rows || `<div class="empty-state">${GROUP_MGR_TAB === 'hidden' ? 'No hidden groups.' : 'No groups yet.'}</div>`}
    </div>
    ${deletedRows}
    <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Done</button></div>
  `);
}
function openManageImageGroupsModal() {
  renderSharedGroupManagerModal('Manage groups');
}

// Selecting several images at once, then attaching them all to one entry —
// previously the only way to attach an image to a read was one at a time
// from inside that entry's own page.
let IMAGE_SELECT_MODE = false;
let IMAGE_SELECTED = new Set();
// The exact dataUrl order the Attached/Unattached masonry grid was last
// rendered in — kept up to date every render so the individual item modal
// can offer prev/next arrows through the same set the user was actually
// browsing, without recomputing (and risking drifting from) the filter
// logic a second time. Stays empty while on the Duplicates tab, since
// stepping through a per-group comparison isn't the same kind of "browse".
let IMAGES_NAV_LIST = [];
// Same hide/show mechanic as the homepage's "Hide Filters" toggle (see
// FILTERS_COLLAPSED/.filters-collapsible) — the Semi/Uke + mood-group chip
// row can be tucked away on demand instead of always taking up header space.
// Session-only, like its homepage counterpart (resets on reload).
let IMAGES_FILTERS_COLLAPSED = false;
let IMAGE_KIND_FILTER = null; // null | 'semi' | 'uke'
// Manual Semi/Uke tags — she can flag ANY image in the Images gallery as
// "Semi only"/"Uke only" from its individual view, same chip-toggle
// mechanism as a mood group, on top of the automatic kind-based tagging
// (an image that's literally the entry's current/former semi or uke photo
// — see allAppImages()/photoHistory). Semi-only/Uke-only match either.
const SEMI_TAG = 'Semi';
const UKE_TAG = 'Uke';
let IMAGE_GROUP_FILTER = null;
let IMAGES_UNTAGGED_ONLY = false;
// Groups/moods get the same hide + delete lifecycle Tag Manager already has
// for tags: a soft "hide from chip rows" toggle that keeps every image's/
// reaction's tag data intact, plus a full delete that strips the tag
// everywhere and blocks the name from being recreated (by hand or by a
// future import) until restored from the Hidden tab. Applies to the shared
// Images/Reactions group set; H keeps its own separate copies below since
// its groups were deliberately NOT merged into that shared set.
let HIDDEN_GROUP_KEYS = new Set();
let DELETED_GROUP_KEYS = new Set();
let GROUP_MGR_TAB = 'active'; // 'active' | 'hidden'
let GROUP_MGR_MODAL_TITLE = 'Manage groups';

function openAttachImagesToEntryModal(dataUrls) {
  // Defensive de-dupe by id — IndexedDB itself can't hold two records under
  // the same id (it's the store's keyPath), so this only ever matters if a
  // rare sync race briefly duplicates an id in the in-memory ALL_ENTRIES
  // array; harmless either way, and it's the cheapest way to guarantee this
  // list never shows the same read twice.
  const seen = new Set();
  const candidates = ALL_ENTRIES
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => a.title.localeCompare(b.title));
  // A manga/manhwa entry and its anime/TV adaptation can legitimately share
  // (near-)identical titles — this format emoji is the only thing telling
  // them apart at a glance in an alphabetical list, same icon scheme as the
  // Database duplicates review screen.
  const renderList = (list) => list.length
    ? list.slice(0, 40).map((c) => `<button class="ref-btn" style="width:100%;text-align:left;" data-attach-images-target="${c.id}">${c.format === 'reading' ? '📖' : '📺'} ${escapeHtml(c.title)}</button>`).join('')
    : '<div class="empty-state">No matches.</div>';
  openModal(`
    <h3>Attach ${dataUrls.length} image${dataUrls.length === 1 ? '' : 's'} to…</h3>
    <p style="font-size:12px;color:var(--text-dim);">Picked images are added to that read's screencaps.</p>
    <input type="text" id="attach-images-search" placeholder="Search titles..." style="width:100%;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--navy-2);color:var(--text);box-sizing:border-box;">
    <div id="attach-images-list" style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;">${renderList(candidates)}</div>
    <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Cancel</button></div>
  `);
  const searchEl = document.getElementById('attach-images-search');
  const listEl = document.getElementById('attach-images-list');
  if (searchEl) {
    searchEl.oninput = () => {
      const q = searchEl.value.trim().toLowerCase();
      const filtered = q ? candidates.filter((c) => c.title.toLowerCase().includes(q)) : candidates;
      listEl.innerHTML = renderList(filtered);
      listEl.querySelectorAll('[data-attach-images-target]').forEach((el) => {
        el.onclick = () => attachImagesToEntry(dataUrls, el.getAttribute('data-attach-images-target'));
      });
    };
    searchEl.focus();
  }
  listEl.querySelectorAll('[data-attach-images-target]').forEach((el) => {
    el.onclick = () => attachImagesToEntry(dataUrls, el.getAttribute('data-attach-images-target'));
  });
}
async function attachImagesToEntry(dataUrls, entryId) {
  const e = getEntry(entryId);
  if (!e) return;
  e.screencaps = e.screencaps || [];
  let added = 0;
  dataUrls.forEach((src) => {
    if (!e.screencaps.includes(src)) { e.screencaps.push(src); added++; }
  });
  await saveEntry(e);
  closeModal();
  IMAGE_SELECT_MODE = false;
  IMAGE_SELECTED = new Set();
  showToast(`Attached ${added} image${added === 1 ? '' : 's'} to "${e.title}"`);
  render();
}
// Bulk mood/group tagging for multi-selected Images-gallery items — before
// this, the only way to sort an image into a mood group was one at a time
// from its individual view, same gap the multi-select Attach/Reactions/H
// actions above already closed for those other actions. Adds the picked tag
// to every selected image (Semi only/Uke only reuse the same manual-tag
// mechanism as a mood group, so they're offered here too) — it always adds,
// never toggles off, since with several images selected at once some may
// already carry the tag and others not.
function tagImagesWithGroup(dataUrls, tag) {
  dataUrls.forEach((dataUrl) => {
    const key = imageKey(dataUrl);
    const tags = new Set(IMAGE_TAG_MAP[key] || []);
    tags.add(tag);
    IMAGE_TAG_MAP[key] = Array.from(tags);
  });
  persistImageTagMap();
}
function openTagSelectedImagesModal(dataUrls) {
  // Built-ins-plus-custom, same list Reactions uses — the 4 built-in moods
  // should be assignable from Images' bulk-tag modal too.
  const moodOptions = allMoodOptions();
  openModal(`
    <h3>Add ${dataUrls.length} image${dataUrls.length === 1 ? '' : 's'} to a mood…</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
      ${[SEMI_TAG, UKE_TAG].map((name) => `<button class="mood-chip" data-tag-selected-images-with="${escapeHtml(name)}">${escapeHtml(name)} only</button>`).join('')}
      ${moodOptions.map((m) => `<button class="mood-chip" data-tag-selected-images-with="${escapeHtml(m.key)}" title="${escapeHtml(m.label)}">${m.emoji ? m.emoji + ' ' : ''}${escapeHtml(m.label)}</button>`).join('')}
      <button class="mood-chip" data-tag-selected-images-new-group="1">➕ New group</button>
    </div>
    <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Cancel</button></div>
  `);
  document.querySelectorAll('[data-tag-selected-images-with]').forEach((el) => {
    el.onclick = () => {
      const tag = el.getAttribute('data-tag-selected-images-with');
      tagImagesWithGroup(dataUrls, tag);
      closeModal();
      IMAGE_SELECT_MODE = false;
      IMAGE_SELECTED = new Set();
      showToast(`Added ${dataUrls.length} image${dataUrls.length === 1 ? '' : 's'} to "${tag}"`);
      render();
    };
  });
  const newGroupBtn = document.querySelector('[data-tag-selected-images-new-group]');
  if (newGroupBtn) newGroupBtn.onclick = () => {
    const key = addImageGroup(prompt('Name this new group:'));
    if (!key) return;
    tagImagesWithGroup(dataUrls, key);
    closeModal();
    IMAGE_SELECT_MODE = false;
    IMAGE_SELECTED = new Set();
    showToast(`Added ${dataUrls.length} image${dataUrls.length === 1 ? '' : 's'} to "${key}"`);
    render();
  };
}
// Cross-link into the standalone Reactions library — an image already on a
// read can also be dropped straight into the mood-tagged meme collection
// instead of having to re-download/re-upload it separately.
async function addImageAsReaction(dataUrl) {
  const hash = await hashDataUrl(dataUrl);
  // Scoped to the reactions pool specifically (not any hash match) — an
  // 'images'-sourced record with the same hash shouldn't count as "already
  // added to Reactions" and silently block this from actually adding it.
  if (findReactionsPoolRecordByHash(hash)) return null;
  // "Add as reactions" (Images gallery -> Reactions library) — the resulting
  // record is meant to live and be organized by mood tag from here on, so it
  // gets source: 'reactions' just like a direct Reactions-tab upload would.
  const reaction = { id: uid('reaction'), dataUrl, hash, moodTags: [], note: '', source: 'reactions', createdAt: new Date().toISOString() };
  await saveReaction(reaction);
  tryUploadImageToDrive(dataUrl, `reaction-${reaction.id}.jpg`, 'reaction').then((fileId) => {
    if (!fileId) return;
    const fresh = ALL_REACTIONS.find((r) => r.id === reaction.id);
    if (!fresh) return;
    fresh.driveId = fileId;
    saveReaction(fresh);
  });
  return reaction;
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

// Groups a list of perceptual hashes into clusters using full transitive
// closure (union-find) rather than the old "one hub per group" pairwise
// comparison. The old approach only ever compared each unclaimed item to a
// single hub, so if item A got claimed as a near-match of unrelated item X
// before A's TRUE duplicate B was ever compared against it, A was already
// "used" and B's real match silently never formed a group — a real
// duplicate could vanish from the scan for no reason visible to her. Union-
// find instead treats "A~B and B~C" as one connected group even when A and
// C aren't within the threshold of each other directly, which is the
// correct behavior for a chain of slightly-different re-compressions of the
// same source image. Returns an array of index-arrays (each length ≥ 2).
function clusterByHammingDistance(hashes, threshold) {
  const n = hashes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; }
  for (let i = 0; i < n; i++) {
    if (!hashes[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!hashes[j]) continue;
      if (hammingDistance(hashes[i], hashes[j]) <= threshold) union(i, j);
    }
  }
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    if (!hashes[i]) continue;
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }
  return Array.from(clusters.values()).filter((c) => c.length > 1);
}

function imageDupSignature(group) {
  return group.map((img) => imageKey(img.dataUrl)).sort().join('|');
}
function persistIgnoredImageDupGroups() {
  idbPut(STORE_META, { key: 'ignoredImageDupGroups', value: Array.from(IGNORED_IMAGE_DUP_GROUPS) });
  pushMetaField('ignoredImageDupGroups', Array.from(IGNORED_IMAGE_DUP_GROUPS));
}
// Marks a group as "not actually duplicates" so it's excluded from every
// future scan, and drops it from the list on screen right now (no rescan
// needed) — this is what stops the same groups from being asked about
// forever.
function dismissImageDupGroup(idx) {
  if (!IMAGE_DUP_GROUPS || !IMAGE_DUP_GROUPS[idx]) return;
  IGNORED_IMAGE_DUP_GROUPS.add(imageDupSignature(IMAGE_DUP_GROUPS[idx]));
  persistIgnoredImageDupGroups();
  IMAGE_DUP_GROUPS = IMAGE_DUP_GROUPS.filter((_, i) => i !== idx);
  render();
}
// Clears every "Not duplicates" dismissal so the next scan re-judges
// everything from scratch — the only way back once a group's been dismissed.
function resetDismissedImageDupGroups() {
  if (!IGNORED_IMAGE_DUP_GROUPS.size) return;
  if (!confirm(`Forget ${IGNORED_IMAGE_DUP_GROUPS.size} dismissed duplicate pair(s)? They'll be re-checked (and may reappear) the next time you scan.`)) return;
  IGNORED_IMAGE_DUP_GROUPS = new Set();
  persistIgnoredImageDupGroups();
  showToast('Dismissed duplicates forgotten — scan again to re-check them.');
  render();
}

let IMAGES_TAB = 'attached'; // 'attached' | 'unattached' | 'duplicates'
let IMAGE_DUP_GROUPS = null; // null = not scanned yet this session
let IMAGE_DUP_SCANNING = false;
async function scanForImageDuplicates() {
  IMAGE_DUP_SCANNING = true;
  render();
  const items = allAppImages();
  // A group of 3+ can be held together by one "hub" image that's close to
  // both of the others without those two being close to each other. Once
  // she deletes the hub, a fresh hash-only comparison of the two survivors
  // can legitimately fall outside the similarity threshold, which used to
  // make the whole group silently vanish on "Scan again" even though she'd
  // already confirmed those two were duplicates. Carry forward whatever's
  // left of any group we already knew about this session (minus whatever's
  // been deleted) and merge it into the fresh results below.
  const validUrls = new Set(items.map((i) => i.dataUrl));
  const carriedGroups = (IMAGE_DUP_GROUPS || [])
    .map((g) => g.filter((img) => img.dataUrl && validUrls.has(img.dataUrl)))
    .filter((g) => g.length > 1);
  const withHashes = [];
  for (const img of items) {
    const hash = await perceptualHash(img.dataUrl);
    withHashes.push({ img, hash });
  }
  const groups = [];
  const clusters = clusterByHammingDistance(withHashes.map((x) => x.hash), 6);
  for (const idxs of clusters) {
    const group = idxs.map((idx) => withHashes[idx].img);
    // Skip groups the user already reviewed and confirmed aren't
    // duplicates — otherwise every "Scan again" just re-surfaces the same
    // ~40 groups forever.
    if (!IGNORED_IMAGE_DUP_GROUPS.has(imageDupSignature(group))) groups.push(group);
  }
  const coveredSets = groups.map((g) => new Set(g.map((img) => img.dataUrl)));
  carriedGroups.forEach((cg) => {
    if (IGNORED_IMAGE_DUP_GROUPS.has(imageDupSignature(cg))) return;
    const urls = cg.map((img) => img.dataUrl);
    if (!coveredSets.some((s) => urls.every((u) => s.has(u)))) groups.push(cg);
  });
  IMAGE_DUP_GROUPS = groups;
  IMAGE_DUP_SCANNING = false;
  render();
}

function renderReactionsLibrary() {
  let items = allAppImages();
  // Matches images that are AUTOMATICALLY semi/uke (kind-derived — current
  // or former semi/uke photo, see allAppImages()) OR manually flagged Semi/
  // Uke via the Groups chips in the individual item view.
  const kindTagName = IMAGE_KIND_FILTER === 'semi' ? SEMI_TAG : IMAGE_KIND_FILTER === 'uke' ? UKE_TAG : null;
  if (IMAGE_KIND_FILTER) items = items.filter((i) => i.kinds.includes(IMAGE_KIND_FILTER) || getImageTags(i.dataUrl).includes(kindTagName));
  if (IMAGE_GROUP_FILTER) items = items.filter((i) => getImageTags(i.dataUrl).includes(IMAGE_GROUP_FILTER));
  // Untagged-first, same rule as the Reactions gallery — images with no
  // group assigned yet (and not already a semi/uke photo — see
  // isImageUntagged) surface first so they're quick to spot and sort.
  items = items.slice().sort((a, b) => {
    const aUntagged = isImageUntagged(a);
    const bUntagged = isImageUntagged(b);
    if (aUntagged !== bUntagged) return aUntagged ? -1 : 1;
    return 0;
  });
  const untaggedCount = items.filter((i) => !i.pending && isImageUntagged(i)).length;
  if (IMAGES_UNTAGGED_ONLY) items = items.filter((i) => isImageUntagged(i));
  const attached = items.filter((i) => i.attachedEntries.length > 0);
  const unattached = items.filter((i) => i.attachedEntries.length === 0);
  IMAGES_NAV_LIST = (IMAGES_TAB === 'unattached' ? unattached : IMAGES_TAB === 'attached' ? attached : IMAGES_TAB === 'gallery' ? items : []).map((i) => i.dataUrl);

  // `forceDel` is only passed true from the Possible Duplicates tab — it
  // makes every image in a duplicate comparison deletable (not just
  // reaction-backed ones), so she can pick which copy to keep without
  // leaving Images. Reaction-backed images keep using their own delete
  // button either way (goes straight to deleteReaction); non-reaction
  // images (screencaps, semi/uke photos) only get one when forceDel is set,
  // since Attached/Unattached don't offer a generic "remove from gallery"
  // action outside of this comparison view.
  const masonryItem = (img, forceDel) => img.pending
    ? `<div class="masonry-item" data-images-pending-entry="${escapeHtml(img.entryId)}" title="Still downloading from Drive — tap to open ${escapeHtml(img.entryTitle || '')}">
        <div class="cover-placeholder" style="height:100%;">⏳</div>
      </div>`
    : `<div class="masonry-item ${IMAGE_SELECT_MODE ? 'selectable' : ''} ${IMAGE_SELECTED.has(img.dataUrl) ? 'selected' : ''}" data-images-item="${escapeHtml(img.dataUrl)}">
      ${isVideoUrl(img.dataUrl) ? `<video src="${img.dataUrl}" autoplay loop muted playsinline></video>` : `<img src="${img.dataUrl}" alt="" loading="lazy">`}
      ${IMAGE_SELECT_MODE ? `<span class="select-check">${IMAGE_SELECTED.has(img.dataUrl) ? '✅' : '⬜'}</span>` : ''}
      ${!IMAGE_SELECT_MODE
        ? (forceDel
            ? `<span class="dup-del-hint" title="Tap to delete">✕</span>`
            : (isImageUntagged(img)
                ? `<span class="untagged-badge">Untagged</span>`
                : (img.attachedEntries.length ? `<span class="reaction-count">${img.attachedEntries.length}</span>` : '')))
        : ''}
    </div>`;

  let tabBody;
  if (IMAGES_TAB === 'gallery') {
    // Unlike Attached/Unattached, this ignores attach-status entirely — the
    // point is being able to click a mood chip and see every image tagged
    // with it in one place, same as Reactions/H already work, instead of
    // having to check Attached and Unattached separately for the same mood.
    tabBody = items.length ? `<div class="image-masonry">${items.map((img) => masonryItem(img)).join('')}</div>` : `<div class="empty-state">No images match. Try clearing the filter/search.</div>`;
  } else if (IMAGES_TAB === 'unattached') {
    tabBody = unattached.length ? `<div class="image-masonry">${unattached.map((img) => masonryItem(img)).join('')}</div>` : `<div class="empty-state">Everything's attached to a read. 🎉</div>`;
  } else if (IMAGES_TAB === 'duplicates') {
    // A pair dismissed via "Not duplicates" is skipped by every future scan
    // forever (see IGNORED_IMAGE_DUP_GROUPS/imageDupSignature) — with no way
    // back, an accidental dismissal (or two images that only later turned
    // out to actually be copies of each other) would just silently never
    // surface again. This link clears that memory so the next scan
    // re-judges everything fresh.
    const resetDismissedLink = IGNORED_IMAGE_DUP_GROUPS.size
      ? `<button class="ref-btn" style="width:100%;margin-bottom:10px;font-size:11.5px;color:var(--text-dim);" data-reset-dismissed-image-dups="1">🔄 Forget ${IGNORED_IMAGE_DUP_GROUPS.size} dismissed pair${IGNORED_IMAGE_DUP_GROUPS.size === 1 ? '' : 's'} (re-check them on next scan)</button>`
      : '';
    if (IMAGE_DUP_SCANNING) {
      tabBody = `<div class="empty-state">Scanning ${items.length} images for duplicates…</div>`;
    } else if (IMAGE_DUP_GROUPS === null) {
      tabBody = `<div style="padding:8px 0;"><button class="btn-primary" style="width:100%;margin-bottom:8px;" data-scan-duplicates="1">🔍 Scan for possible duplicates</button>${resetDismissedLink}</div>`;
    } else if (!IMAGE_DUP_GROUPS.length) {
      tabBody = `<div class="empty-state">No possible duplicates found. 🎉</div><button class="ref-btn" style="width:100%;margin-bottom:8px;" data-scan-duplicates="1">Scan again</button>${resetDismissedLink}`;
    } else {
      tabBody = `<button class="ref-btn" style="width:100%;margin-bottom:10px;" data-scan-duplicates="1">Scan again</button>` + resetDismissedLink +
        IMAGE_DUP_GROUPS.map((group, idx) => `
          <div class="panel">
            <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span>Possible duplicate (${group.length} images)</span>
              <button class="ref-btn" style="flex:0 0 auto;padding:4px 10px;font-size:12px;" data-dismiss-image-dup-group="${idx}">Not duplicates</button>
            </div>
            <div class="image-masonry">${group.map((img) => masonryItem(img, true)).join('')}</div>
          </div>`).join('');
    }
  } else {
    tabBody = attached.length ? `<div class="image-masonry">${attached.map((img) => masonryItem(img)).join('')}</div>` : `<div class="empty-state">No attached images yet.</div>`;
  }

  // Same built-ins-plus-custom list Reactions uses (allMoodOptions()) —
  // she wants the 4 built-in moods selectable/filterable from Images too,
  // not just custom groups, since the two galleries' groups are merged.
  const groupChips = allMoodOptions().map((m) => `<button class="mood-chip ${IMAGE_GROUP_FILTER === m.key ? 'active' : ''}" data-images-group-filter="${escapeHtml(m.key)}" title="${escapeHtml(m.label)}">${m.emoji ? m.emoji + ' ' : ''}${escapeHtml(m.label)}</button>`).join('');

  return `
    <div class="app-header">
      <div class="brand-row"><h1>🖼️ Images</h1></div>
      <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">${items.length} image${items.length === 1 ? '' : 's'} across the app. Tap one to see which reads it's attached to.</div>
      <div class="export-row" style="margin-bottom:10px;">
        <label class="upload-btn" style="flex:1;">📎 Add image(s)<input type="file" accept="image/*,video/*" multiple id="reaction-upload-input"></label>
        <button class="ref-btn" data-images-toggle-select="1">${IMAGE_SELECT_MODE ? '✕ Cancel select' : '☑️ Select'}</button>
      </div>
      ${IMAGE_SELECT_MODE ? `
        <div class="export-row" style="margin-bottom:10px;background:var(--card);border:1px solid var(--purple);border-radius:var(--radius-sm);padding:8px;">
          <div style="flex:1;font-size:12.5px;color:var(--text-dim);align-self:center;">${IMAGE_SELECTED.size} selected</div>
          <button class="ref-btn" data-images-attach-selected="1" ${IMAGE_SELECTED.size ? '' : 'disabled'}>📎 Attach to a read…</button>
          <button class="ref-btn" data-images-tag-selected="1" ${IMAGE_SELECTED.size ? '' : 'disabled'}>🏷️ Add to mood…</button>
          <button class="ref-btn" data-images-add-selected-reactions="1" ${IMAGE_SELECTED.size ? '' : 'disabled'}>🎭 Add as reactions</button>
          ${!isSFW() ? `<button class="ref-btn" data-images-pull-selected-into-h="1" style="${IMAGE_SELECTED.size ? 'color:#f43f5e;' : ''}" ${IMAGE_SELECTED.size ? '' : 'disabled'}>🔴 Pull into NSFW</button>` : ''}
          <button class="btn-ghost" data-images-delete-selected="1" ${IMAGE_SELECTED.size ? '' : 'disabled'}>🗑️ Delete selected</button>
        </div>
      ` : ''}
      <div class="tagmgr-tabs" style="margin-bottom:8px;">
        <button class="tagmgr-tab ${IMAGES_TAB === 'gallery' ? 'active' : ''}" data-images-tab="gallery" title="Everything matching the filters below, attached or not">Gallery (${items.length})</button>
        <button class="tagmgr-tab ${IMAGES_TAB === 'attached' ? 'active' : ''}" data-images-tab="attached">Attached (${attached.length})</button>
        <button class="tagmgr-tab ${IMAGES_TAB === 'unattached' ? 'active' : ''}" data-images-tab="unattached">Unattached (${unattached.length})</button>
        <button class="tagmgr-tab ${IMAGES_TAB === 'duplicates' ? 'active' : ''}" data-images-tab="duplicates">Possible Duplicates${IMAGE_DUP_GROUPS !== null ? ` (${IMAGE_DUP_GROUPS.length})` : ''}</button>
        ${IMAGES_TAB !== 'duplicates' ? `<button class="ref-btn ${IMAGES_UNTAGGED_ONLY ? 'active' : ''}" style="flex:0 0 auto;padding:8px 12px;white-space:nowrap;${IMAGES_UNTAGGED_ONLY ? 'background:var(--purple);color:#fff;' : ''}" data-images-untagged-only="1" title="Show images not yet grouped into a mood">${untaggedCount} untagged</button>` : ''}
        <button class="ref-btn" style="flex:0 0 auto;padding:8px 12px;white-space:nowrap;" data-images-manage-groups="1" title="Manage image groups (rename/delete)">✏️ Manage</button>
      </div>
      ${IMAGES_TAB !== 'duplicates' ? `
        <button class="filters-toggle-btn" data-images-toggle-filters="1">${IMAGES_FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters'}</button>
        <div class="filters-collapsible ${IMAGES_FILTERS_COLLAPSED ? 'collapsed' : ''}" id="images-filters-collapsible">
          <div class="group-chip-row" style="margin-bottom:10px;">
            <button class="mood-chip ${IMAGE_KIND_FILTER === 'semi' ? 'active' : ''}" data-images-kind-filter="semi">Semi only</button>
            <button class="mood-chip ${IMAGE_KIND_FILTER === 'uke' ? 'active' : ''}" data-images-kind-filter="uke">Uke only</button>
            ${groupChips}
            <button class="mood-chip" data-images-add-group="1">➕ New group</button>
          </div>
        </div>
      ` : ''}
    </div>
    <main class="gallery-dropzone">${tabBody}</main>
    ${renderBottomNav('reactions')}
  `;
}

/* ---------------------------------------------------------------------- */
/* Cross-library membership toggles — every media file (an entry-sourced   */
/* image, a standalone reaction, or a standalone H upload) can be marked   */
/* into Reactions and/or H independently, from whichever individual-item   */
/* modal it's currently open in. Toggling something OFF that has no other  */
/* home (a pure reaction with no entry attachment, or a standalone H       */
/* upload) deletes that record outright, same as the dedicated Delete/     */
/* Remove buttons already did — there's nothing left to "un-toggle" to.    */
/* ---------------------------------------------------------------------- */
// "Is this in Reactions" has to mean "is there a copy actually visible in
// the Reactions gallery" (source !== 'images', same pool as
// reactionsPoolItems()) — NOT "does any record with this hash exist
// anywhere". An Images-tab upload or entry photo can share a hash with
// itself without that meaning it's in Reactions; checking ANY hash match
// used to let this wrongly report "in reactions" (or delete the wrong
// record when toggled off) for images that only ever lived in Images.
function findReactionsPoolRecordByHash(hash) {
  return ALL_REACTIONS.find((r) => r.hash === hash && r.source !== 'images');
}
async function isDataUrlInReactions(dataUrl) {
  if (!dataUrl) return false;
  const hash = await hashDataUrl(dataUrl);
  return !!findReactionsPoolRecordByHash(hash);
}
function isDataUrlInH(dataUrl) {
  return !!dataUrl && H_IMAGE_KEYS.has(imageKey(dataUrl));
}
async function toggleReactionMembership(dataUrl) {
  const hash = await hashDataUrl(dataUrl);
  const existing = findReactionsPoolRecordByHash(hash);
  if (existing) {
    await deleteReaction(existing.id);
    return false;
  }
  await addImageAsReaction(dataUrl);
  return true;
}
function toggleHMembership(dataUrl) {
  if (H_IMAGE_KEYS.has(imageKey(dataUrl))) {
    removeFromH(dataUrl);
    return false;
  }
  pullImageIntoH(dataUrl);
  return true;
}
// Like isDataUrlInReactions, but can exclude one specific reaction record by
// id. Needed right before that record is deleted: checking "is this content
// already in the reactions pool" without excluding the doomed record would
// find the record that's ABOUT to be deleted and wrongly conclude "yes,
// already covered" — then a moment later that was the only copy providing
// that coverage, and it's gone. Excluding it up front answers the question
// that actually matters: "will anything still be in Reactions for this
// content after the delete goes through?"
async function reactionsPoolHasOtherRecord(dataUrl, excludeId) {
  const hash = await hashDataUrl(dataUrl);
  return ALL_REACTIONS.some((r) => r.hash === hash && r.source !== 'images' && r.id !== excludeId);
}
// If the deleted duplicate was attached to a read — as its semi/uke photo,
// a screencap, or sitting in semi/uke photoHistory — hand that attachment
// off to the surviving copy instead of letting the read lose its photo
// outright. Picks the first survivor as the new value (a semi/uke photo is
// a single field, so a 3+ group can't attach to "all" survivors at once).
// Mirrors the same swap-and-reupload pattern the crop flow already uses
// (openCropImageModal): the entry's dataUrl reference changes, the stale
// driveId is cleared since it pointed at the file that's about to be
// deleted from Drive, and a fresh upload kicks off in the background so
// the survivor gets its own Drive file for that slot.
async function transferEntryAttachmentOnDuplicateDelete(deletedDataUrl, survivorDataUrls) {
  const survivors = (survivorDataUrls || []).filter(Boolean);
  if (!survivors.length) return;
  const targetUrl = survivors[0];
  if (targetUrl === deletedDataUrl) return;
  for (const e of ALL_ENTRIES) {
    let changed = false;
    if (e.semi && e.semi.photo === deletedDataUrl) {
      e.semi.photo = targetUrl; e.semi.photoDriveId = null; changed = true;
      tryUploadImageToDrive(targetUrl, `${e.id}-semi-photo.jpg`).then((fileId) => {
        if (!fileId) return;
        const fresh = ALL_ENTRIES.find((x) => x.id === e.id);
        if (fresh && fresh.semi && fresh.semi.photo === targetUrl) { fresh.semi.photoDriveId = fileId; saveEntry(fresh); }
      });
    }
    if (e.uke && e.uke.photo === deletedDataUrl) {
      e.uke.photo = targetUrl; e.uke.photoDriveId = null; changed = true;
      tryUploadImageToDrive(targetUrl, `${e.id}-uke-photo.jpg`).then((fileId) => {
        if (!fileId) return;
        const fresh = ALL_ENTRIES.find((x) => x.id === e.id);
        if (fresh && fresh.uke && fresh.uke.photo === targetUrl) { fresh.uke.photoDriveId = fileId; saveEntry(fresh); }
      });
    }
    if (e.screencaps && e.screencaps.includes(deletedDataUrl)) {
      const idx = e.screencaps.indexOf(deletedDataUrl);
      if (!e.screencaps.includes(targetUrl)) {
        e.screencaps[idx] = targetUrl;
        if (e.screencapDriveIds && e.screencapDriveIds[idx]) e.screencapDriveIds[idx] = null;
        changed = true;
        tryUploadImageToDrive(targetUrl, `${e.id}-screencap-${Date.now()}-${idx}.jpg`).then((fileId) => {
          if (!fileId) return;
          const fresh = ALL_ENTRIES.find((x) => x.id === e.id);
          if (fresh && fresh.screencapDriveIds && fresh.screencaps[idx] === targetUrl) { fresh.screencapDriveIds[idx] = fileId; saveEntry(fresh); }
        });
      } else {
        // Survivor's dataUrl is already a screencap on this same entry —
        // drop the now-redundant deleted slot instead of showing the same
        // picture twice in one read's Images container.
        e.screencaps.splice(idx, 1);
        if (e.screencapDriveIds && e.screencapDriveIds.length > idx) e.screencapDriveIds.splice(idx, 1);
        changed = true;
      }
    }
    // photoHistory is a plain trail of past semi/uke photos (no Drive id of
    // its own) — swap it too so "used to be tagged semi/uke" history isn't
    // silently lost, but skip if the survivor's already in there.
    if (e.semi && e.semi.photoHistory && e.semi.photoHistory.includes(deletedDataUrl)) {
      const hidx = e.semi.photoHistory.indexOf(deletedDataUrl);
      if (e.semi.photoHistory.includes(targetUrl)) e.semi.photoHistory.splice(hidx, 1);
      else e.semi.photoHistory[hidx] = targetUrl;
      changed = true;
    }
    if (e.uke && e.uke.photoHistory && e.uke.photoHistory.includes(deletedDataUrl)) {
      const hidx = e.uke.photoHistory.indexOf(deletedDataUrl);
      if (e.uke.photoHistory.includes(targetUrl)) e.uke.photoHistory.splice(hidx, 1);
      else e.uke.photoHistory[hidx] = targetUrl;
      changed = true;
    }
    if (changed) await saveEntry(e);
  }
}
// Before a duplicate copy is permanently deleted from any of the three
// Possible Duplicates tabs (Images/Reactions/H), carry over anything the
// OTHER copies still in that same comparison group are missing — mood/group
// tags, and Reactions/NSFW membership — onto every surviving copy. Without
// this, whichever copy happened to get tapped for deletion could just as
// easily have been the one that had already been sorted into a mood,
// silently erasing that categorization work instead of preserving it on
// whichever copy is left. `survivorDataUrls` is every OTHER item's dataUrl
// from that same duplicate group (there can be more than one in a 3+ group —
// all of them get the merge, not just one "primary" survivor). `deletedId`
// is the deleted item's own reaction id, if it has one — passed through so
// a byte-identical survivor (the single most common "duplicate" case: the
// exact same file uploaded/attached twice) doesn't get mistaken for the
// record that's about to disappear.
//
// IMPORTANT: survivors are intentionally NOT re-filtered by dataUrl here.
// The caller already excludes the specific item being deleted, by identity
// (id, for reactions), before building survivorDataUrls. A second content-
// based filter used to also exist here (dropping any survivor whose dataUrl
// happened to equal deletedDataUrl) — that silently discarded every
// legitimate survivor that was a byte-for-byte identical copy, which is
// exactly what most "possible duplicates" actually are. That bug made this
// whole function a no-op for the most common case, which is why the merge
// looked "broken" even though the logic below it was otherwise correct.
async function transferDuplicateTagsOnDelete(deletedDataUrl, survivorDataUrls, deletedId) {
  const survivors = (survivorDataUrls || []).filter(Boolean);
  if (!survivors.length) return;
  // getImageTags() already unions IMAGE_TAG_MAP with any reaction moodTags
  // for this exact dataUrl, so this alone captures Semi/Uke/every mood group
  // the deleted copy had, from either storage location.
  const deletedTags = getImageTags(deletedDataUrl);
  const deletedHTags = getHTags(deletedDataUrl);
  const deletedInReactions = await isDataUrlInReactions(deletedDataUrl);
  const deletedInH = isDataUrlInH(deletedDataUrl);
  let imageTagMapChanged = false;
  let hTagMapChanged = false;
  for (const survivorUrl of survivors) {
    if (deletedTags.length) {
      const key = imageKey(survivorUrl);
      const existing = IMAGE_TAG_MAP[key] || [];
      const merged = new Set([...existing, ...deletedTags]);
      if (merged.size !== existing.length) { IMAGE_TAG_MAP[key] = Array.from(merged); imageTagMapChanged = true; }
      // Also merge onto every survivor reaction record that shares this
      // dataUrl (there can legitimately be more than one — e.g. the same
      // file uploaded as two separate reactions), excluding the one about
      // to be deleted so writing to it isn't wasted effort. Using filter
      // instead of find so a coincidental extra match elsewhere in the
      // library doesn't leave any real survivor's tags stale.
      const survivorReactions = ALL_REACTIONS.filter((r) => r.dataUrl === survivorUrl && r.id !== deletedId);
      for (const survivorReaction of survivorReactions) {
        const existingR = survivorReaction.moodTags || [];
        const mergedR = new Set([...existingR, ...deletedTags]);
        if (mergedR.size !== existingR.length) {
          survivorReaction.moodTags = Array.from(mergedR);
          await saveReaction(survivorReaction);
        }
      }
    }
    if (deletedHTags.length) {
      const key = imageKey(survivorUrl);
      const existing = H_TAG_MAP[key] || [];
      const merged = new Set([...existing, ...deletedHTags]);
      if (merged.size !== existing.length) { H_TAG_MAP[key] = Array.from(merged); hTagMapChanged = true; }
    }
    if (deletedInReactions && !(await reactionsPoolHasOtherRecord(survivorUrl, deletedId))) await addImageAsReaction(survivorUrl);
    if (deletedInH && !isDataUrlInH(survivorUrl)) pullImageIntoH(survivorUrl);
  }
  if (imageTagMapChanged) persistImageTagMap();
  if (hTagMapChanged) persistHTagMap();
}
// Shared button pair rendered at the bottom of every individual-item modal.
// The "Use as reaction"/"In Reactions" toggle only makes sense from the
// Images gallery's own item view — it answers "does this Images item ALSO
// have a copy in Reactions", one-directional (Images -> Reactions only).
// From inside Reactions' own item view it'd always just read "In Reactions
// ✓" trivially, and from inside H it doesn't apply at all (H items aren't
// meant to shuttle back into Reactions from there) — so both of those pass
// showReactionsToggle = false to hide it, keeping only "Pull into H".
// `reopen` tells the click handler which modal (and which item id) to
// reopen after toggling, so the window stays open in place instead of
// closing — she has to be able to tap this then immediately go tag a mood,
// not get bounced back to the grid and have to re-find the item. Defaults to
// the Images modal since that's the only caller that doesn't need to
// override it (Reactions/H pass their own type + identifier explicitly,
// since Reactions keys off an id rather than the dataUrl itself).
function mediaToggleButtonsHtml(dataUrl, inReactions, inH, showReactionsToggle = true, reopen) {
  reopen = reopen || { type: 'images', id: dataUrl };
  return `
    ${showReactionsToggle ? `<button class="mood-chip ${inReactions ? 'active' : ''}" data-toggle-reaction-membership="${escapeHtml(dataUrl)}">🎭 ${inReactions ? 'In Reactions ✓' : 'Use as reaction'}</button>` : ''}
    ${!isSFW() ? `<button class="mood-chip ${inH ? 'active' : ''}" data-toggle-h-membership="${escapeHtml(dataUrl)}" data-h-toggle-modal-type="${reopen.type}" data-h-toggle-modal-id="${escapeHtml(String(reopen.id))}" style="${inH ? 'background:#f43f5e;border-color:#f43f5e;color:#fff;' : 'color:#f43f5e;'}">🔴 ${inH ? 'In NSFW ✓' : 'Pull into NSFW'}</button>` : ''}
  `;
}

async function openImageAttachmentsModal(dataUrl) {
  const entries = ALL_ENTRIES.filter((e) => entryImageUrls(e).includes(dataUrl));
  // Built-ins-plus-custom, same list Reactions uses — the 4 built-in moods
  // should be toggleable from Images too, not just custom groups.
  const moodOptions = allMoodOptions();
  const currentTags = getImageTags(dataUrl);
  const inReactions = await isDataUrlInReactions(dataUrl);
  const inH = isDataUrlInH(dataUrl);
  const croppable = isCroppableDataUrl(dataUrl);
  // A standalone Images-tab upload has no entry to fall back to — it only
  // exists as its own ALL_REACTIONS record (source: 'images'), so deleting it
  // has to go through deleteReaction directly rather than the entry-cleanup
  // loop in deleteImageFromGalleryEverywhere (which has nothing to find for
  // it if it's not attached anywhere).
  const standaloneReaction = entries.length === 0 ? ALL_REACTIONS.find((r) => r.dataUrl === dataUrl && r.source === 'images') : null;
  const { prev, next } = mediaModalNavNeighbors(IMAGES_NAV_LIST, dataUrl);
  openModal(`
    <div class="modal-close-corner-wrap">
      <button class="modal-close-x" data-close-modal="1" title="Close">✕</button>
      <h3>Attached to</h3>
    <div class="modal-media-nav" id="modal-media-nav" style="margin-bottom:10px;">
      ${mediaModalNavArrowsHtml('images', prev, next)}
      ${isVideoUrl(dataUrl)
        ? `<video src="${dataUrl}" autoplay loop muted controls playsinline style="width:100%;max-height:65vh;object-fit:contain;border-radius:10px;background:#000;"></video>`
        : `<img src="${dataUrl}" alt="" style="width:100%;max-height:65vh;object-fit:contain;border-radius:10px;background:#000;">`}
    </div>
    ${entries.length
      ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;">${entries.map((e) => `
          <button class="ref-btn" style="text-align:left;" data-goto-entry-from-modal="${e.id}">${escapeHtml(e.title)}</button>`).join('')}</div>`
      : `<div class="empty-state">Not attached to any read yet.</div>`}
    <button class="ref-btn" style="width:100%;margin-bottom:10px;" data-attach-this-image="${escapeHtml(dataUrl)}">📎 Attach to a read…</button>
    <div class="field-row">
      <label>Groups</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
        ${[SEMI_TAG, UKE_TAG].map((name) => `<button class="mood-chip ${currentTags.includes(name) ? 'active' : ''}" data-toggle-image-tag="${escapeHtml(name)}" data-image-url="${escapeHtml(dataUrl)}">${escapeHtml(name)} only</button>`).join('')}
        ${moodOptions.map((m) => `<button class="mood-chip ${currentTags.includes(m.key) ? 'active' : ''}" data-toggle-image-tag="${escapeHtml(m.key)}" data-image-url="${escapeHtml(dataUrl)}" title="${escapeHtml(m.label)}">${m.emoji ? m.emoji + ' ' : ''}${escapeHtml(m.label)}</button>`).join('')}
      </div>
    </div>
    <div class="field-row">
      <label>Also in</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
        ${mediaToggleButtonsHtml(dataUrl, inReactions, inH)}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" data-delete-image-attachment="${escapeHtml(dataUrl)}" data-delete-image-reaction-id="${standaloneReaction ? escapeHtml(standaloneReaction.id) : ''}">🗑️ Delete</button>
      ${croppable ? `<button class="btn-ghost" data-crop-image="${escapeHtml(dataUrl)}">✂️ Crop</button>` : ''}
      <button class="btn-ghost" data-save-image="${escapeHtml(dataUrl)}">⬇️ Save</button>
      <button class="btn-primary" data-close-modal="1">Done</button>
    </div>
    </div>
  `, { centered: true });
  wireModalSwipeNav(prev ? () => openImageAttachmentsModal(prev) : null, next ? () => openImageAttachmentsModal(next) : null);
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
// The 4 built-ins above used to be the only moods it was possible to tag —
// there was no way to add a new grouping like "creepy" or "cute" without
// editing this array in code. This layers user-created custom moods (synced
// via CUSTOM_MOODS, see pullMetaState()/boot()) on top, everywhere the fixed
// list used to be used directly.
function allMoodOptions() {
  // No emoji prefix on custom moods — they read cleaner as plain labels,
  // and it avoids every custom mood looking visually identical (all 🏷️).
  return [...MOOD_OPTIONS, ...visibleGroupList().map((name) => ({ key: name, emoji: '', label: name }))];
}
function addCustomMood(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  const deleted = Array.from(DELETED_GROUP_KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  if (deleted) { showToast(`"${deleted}" was deleted — restore it from Manage > Hidden first`); return null; }
  const existing = [...MOOD_OPTIONS.map((m) => m.key), ...CUSTOM_MOODS].find((k) => k.toLowerCase() === name.toLowerCase());
  const key = existing || name;
  if (!existing) { CUSTOM_MOODS.add(key); persistSharedGroups(); }
  return key;
}
function persistCustomMoods() {
  idbPut(STORE_META, { key: 'customMoods', value: Array.from(CUSTOM_MOODS) });
  pushMetaField('customMoods', Array.from(CUSTOM_MOODS));
}
// Renaming/deleting a shared group has to touch every reaction AND every
// image that's actually tagged with it (see renameSharedGroupEverywhere/
// deleteSharedGroupEverywhere near IMAGE_GROUPS) — otherwise it'd disappear
// from the filter row in one gallery but linger as an invisible orphaned
// tag on items in the other.
function renameCustomMood(oldKey, rawNewName) {
  const newName = String(rawNewName || '').trim();
  if (!newName || newName === oldKey) return;
  CUSTOM_MOODS.delete(oldKey);
  const mergedInto = [...MOOD_OPTIONS.map((m) => m.key), ...CUSTOM_MOODS].find((k) => k.toLowerCase() === newName.toLowerCase());
  const finalKey = mergedInto || newName;
  if (!mergedInto) CUSTOM_MOODS.add(finalKey);
  persistSharedGroups();
  renameSharedGroupEverywhere(oldKey, finalKey);
  if (MEME_STATE.moodFilter === oldKey) MEME_STATE.moodFilter = finalKey;
  if (IMAGE_GROUP_FILTER === oldKey) IMAGE_GROUP_FILTER = finalKey;
}
function deleteCustomMood(key) {
  CUSTOM_MOODS.delete(key);
  persistSharedGroups();
  deleteSharedGroupEverywhere(key);
  recordDeletedGroup(key);
  if (MEME_STATE.moodFilter === key) MEME_STATE.moodFilter = null;
  if (IMAGE_GROUP_FILTER === key) IMAGE_GROUP_FILTER = null;
}
function openManageMoodsModal() {
  renderSharedGroupManagerModal('Manage groups');
}
let MEME_STATE = { moodFilter: null, search: '', untaggedOnly: false };
// Same purpose as IMAGES_NAV_LIST above, for the Reactions grid — updated on
// every renderMemeGrid() call.
let MEME_NAV_LIST = [];
// Same purpose as IMAGES_FILTERS_COLLAPSED above, for the Reactions mood
// chip row.
let MEME_FILTERS_COLLAPSED = false;

// Mirror of the Images gallery's own source filter — the Reactions pool
// should only ever hold direct Reactions-tab uploads (source: 'reactions')
// or items explicitly pulled in via Images' "Add as reactions" button
// (which also stamps source: 'reactions'). Direct Images-tab uploads
// (source: 'images') never show up here automatically. Legacy records
// saved before this distinction existed (source == null) still show in
// both galleries rather than disappearing from either one.
function reactionsPoolItems() {
  return ALL_REACTIONS.filter((r) => r.source !== 'images');
}

function memeFilteredItems() {
  const q = MEME_STATE.search.trim().toLowerCase();
  // Untagged reactions surface first (they're the ones that still need
  // sorting into a mood), then newest-first within each bucket.
  let items = reactionsPoolItems()
    // Same "hidden anywhere else while in H" rule as the Images tab —
    // a reaction pulled into H stops showing up here too.
    .filter((r) => !H_IMAGE_KEYS.has(imageKey(r.dataUrl)))
    .sort((a, b) => {
      const aUntagged = !(a.moodTags || []).length;
      const bUntagged = !(b.moodTags || []).length;
      if (aUntagged !== bUntagged) return aUntagged ? -1 : 1;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  if (MEME_STATE.moodFilter) items = items.filter((r) => (r.moodTags || []).includes(MEME_STATE.moodFilter));
  if (MEME_STATE.untaggedOnly) items = items.filter((r) => !(r.moodTags || []).length);
  if (q) items = items.filter((r) => (r.note || '').toLowerCase().includes(q));
  return items;
}

let MEME_SELECT_MODE = false;
let MEME_SELECTED = new Set();

function renderMemeGrid() {
  const items = memeFilteredItems();
  MEME_NAV_LIST = items.map((r) => r.id);
  return items.length
    ? `<div class="image-masonry">${items.map((r) => `
        <div class="masonry-item ${MEME_SELECT_MODE ? 'selectable' : ''} ${MEME_SELECTED.has(r.id) ? 'selected' : ''}" data-open-meme="${r.id}">
          ${r.dataUrl
            ? (isVideoUrl(r.dataUrl) ? `<video src="${r.dataUrl}" autoplay loop muted playsinline></video>` : `<img src="${r.dataUrl}" alt="" loading="lazy">`)
            : `<div class="cover-placeholder" title="Still downloading from Drive…">⏳</div>`}
          ${MEME_SELECT_MODE ? `<span class="select-check">${MEME_SELECTED.has(r.id) ? '✅' : '⬜'}</span>` : ''}
          ${!MEME_SELECT_MODE && !(r.moodTags || []).length ? `<span class="untagged-badge">Untagged</span>` : ''}
        </div>`).join('')}</div>`
    : `<div class="empty-state">No reactions match. ${MEME_STATE.moodFilter || MEME_STATE.search ? 'Try clearing the filter/search.' : 'Tap "Add" to upload your first meme.'}</div>`;
}

// Possible-Duplicates for the Reactions library — same perceptual (average)
// hash approach as the Images tab's duplicate scanner (see perceptualHash()/
// hammingDistance() above), just scoped to ALL_REACTIONS instead of journal
// entry images. Compares by actual image content, not file size, since a
// hash comparison catches the same picture saved/compressed differently in
// a way file size alone can't.
let MEME_DUP_GROUPS = null; // null = not scanned yet this session
let MEME_DUP_SCANNING = false;
let MEME_SHOWING_DUPLICATES = false;
function reactionDupSignature(group) {
  return group.map((r) => r.id).sort().join('|');
}
function persistIgnoredMemeDupGroups() {
  idbPut(STORE_META, { key: 'ignoredMemeDupGroups', value: Array.from(IGNORED_MEME_DUP_GROUPS) });
  pushMetaField('ignoredMemeDupGroups', Array.from(IGNORED_MEME_DUP_GROUPS));
}
function dismissMemeDupGroup(idx) {
  if (!MEME_DUP_GROUPS || !MEME_DUP_GROUPS[idx]) return;
  IGNORED_MEME_DUP_GROUPS.add(reactionDupSignature(MEME_DUP_GROUPS[idx]));
  persistIgnoredMemeDupGroups();
  MEME_DUP_GROUPS = MEME_DUP_GROUPS.filter((_, i) => i !== idx);
  render();
}
function resetDismissedMemeDupGroups() {
  if (!IGNORED_MEME_DUP_GROUPS.size) return;
  if (!confirm(`Forget ${IGNORED_MEME_DUP_GROUPS.size} dismissed duplicate pair(s)? They'll be re-checked (and may reappear) the next time you scan.`)) return;
  IGNORED_MEME_DUP_GROUPS = new Set();
  persistIgnoredMemeDupGroups();
  showToast('Dismissed duplicates forgotten — scan again to re-check them.');
  render();
}
async function scanForMemeDuplicates() {
  MEME_DUP_SCANNING = true;
  render();
  // Anything still waiting on a Drive download (see hydrateMissingReactions())
  // has no dataUrl yet to hash — skip those for now rather than block the
  // whole scan on them; re-running the scan later will pick them up.
  const items = reactionsPoolItems().filter((r) => r.dataUrl);
  // Same carry-forward as Images (see scanForImageDuplicates) — a group of
  // 3+ can be held together by one "hub" reaction that's close to both of
  // the others without those two being close to each other, so deleting the
  // hub used to make a fresh rescan silently drop the still-valid pair.
  const validIds = new Set(items.map((i) => i.id));
  const carriedGroups = (MEME_DUP_GROUPS || [])
    .map((g) => g.filter((r) => r.id && validIds.has(r.id)))
    .filter((g) => g.length > 1);
  const withHashes = [];
  for (const r of items) {
    const hash = await perceptualHash(r.dataUrl);
    withHashes.push({ r, hash });
  }
  const groups = [];
  const clusters = clusterByHammingDistance(withHashes.map((x) => x.hash), 6);
  for (const idxs of clusters) {
    const group = idxs.map((idx) => withHashes[idx].r);
    // Skip anything already reviewed and confirmed as "not duplicates" so
    // scanning again doesn't just re-show the same groups forever.
    if (!IGNORED_MEME_DUP_GROUPS.has(reactionDupSignature(group))) groups.push(group);
  }
  const coveredSets = groups.map((g) => new Set(g.map((r) => r.id)));
  carriedGroups.forEach((cg) => {
    if (IGNORED_MEME_DUP_GROUPS.has(reactionDupSignature(cg))) return;
    const ids = cg.map((r) => r.id);
    if (!coveredSets.some((s) => ids.every((id) => s.has(id)))) groups.push(cg);
  });
  MEME_DUP_GROUPS = groups;
  MEME_DUP_SCANNING = false;
  render();
}

function memeMainBody() {
  if (!MEME_SHOWING_DUPLICATES) return renderMemeGrid();
  if (MEME_DUP_SCANNING) return `<div class="empty-state">Scanning ${reactionsPoolItems().length} reactions for duplicates…</div>`;
  const resetDismissedMemeLink = IGNORED_MEME_DUP_GROUPS.size
    ? `<button class="ref-btn" style="width:100%;margin-bottom:10px;font-size:11.5px;color:var(--text-dim);" data-reset-dismissed-meme-dups="1">🔄 Forget ${IGNORED_MEME_DUP_GROUPS.size} dismissed pair${IGNORED_MEME_DUP_GROUPS.size === 1 ? '' : 's'} (re-check them on next scan)</button>`
    : '';
  if (MEME_DUP_GROUPS === null) return `<div style="padding:8px 0;"><button class="btn-primary" style="width:100%;margin-bottom:8px;" data-scan-meme-duplicates="1">🔍 Scan for possible duplicates</button>${resetDismissedMemeLink}</div>`;
  if (!MEME_DUP_GROUPS.length) return `<div class="empty-state">No possible duplicates found. 🎉</div><button class="ref-btn" style="width:100%;margin-bottom:8px;" data-scan-meme-duplicates="1">Scan again</button>${resetDismissedMemeLink}`;
  return `<button class="ref-btn" style="width:100%;margin-bottom:10px;" data-scan-meme-duplicates="1">Scan again</button>` + resetDismissedMemeLink +
    MEME_DUP_GROUPS.map((group, idx) => `
      <div class="panel">
        <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span>Possible duplicate (${group.length} reactions)</span>
          <button class="ref-btn" style="flex:0 0 auto;padding:4px 10px;font-size:12px;" data-dismiss-meme-dup-group="${idx}">Not duplicates</button>
        </div>
        <div class="image-masonry">${group.map((r) => `
          <div class="masonry-item ${MEME_SELECT_MODE ? 'selectable' : ''} ${MEME_SELECTED.has(r.id) ? 'selected' : ''}" data-open-meme="${r.id}">
            ${isVideoUrl(r.dataUrl) ? `<video src="${r.dataUrl}" autoplay loop muted playsinline></video>` : `<img src="${r.dataUrl}" alt="" loading="lazy">`}
            ${MEME_SELECT_MODE ? `<span class="select-check">${MEME_SELECTED.has(r.id) ? '✅' : '⬜'}</span>` : `<span class="dup-del-hint" title="Tap to delete">✕</span>`}
          </div>`).join('')}</div>
      </div>`).join('');
}

function renderMemeLibraryInPlace() {
  const main = document.querySelector('#view-root main');
  if (main) main.innerHTML = memeMainBody();
  attachMemeGridHandlers();
}

function renderMemeLibrary() {
  const reactionsPool = reactionsPoolItems();
  const untaggedCount = reactionsPool.filter((r) => !(r.moodTags || []).length).length;
  // Built-in and custom moods now render identically — same pill style, same
  // row — since they're all just "mood groups" to the user; there's no
  // meaningful reason for the 4 built-ins to look different from ones she
  // creates herself. The management (rename/delete) controls that used to be
  // a pencil icon sitting in the middle of this row moved out to a plain
  // "Manage moods" button next to the Possible Duplicates tab instead.
  const moodChips = allMoodOptions().map((m) => `<button class="mood-chip ${MEME_STATE.moodFilter === m.key ? 'active' : ''}" data-meme-mood-filter="${escapeHtml(m.key)}" title="${escapeHtml(m.label)}">${m.emoji ? m.emoji + ' ' : ''}${escapeHtml(m.label)}</button>`).join('');
  return `
    <div class="app-header">
      <div class="brand-row"><h1>🎭 Reactions</h1></div>
      <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">${reactionsPool.length} meme${reactionsPool.length === 1 ? '' : 's'} saved${untaggedCount ? ` · ${untaggedCount} untagged` : ''}.</div>
      <div class="export-row" style="margin-bottom:10px;">
        <label class="upload-btn" style="flex:1;">📎 Add reaction(s)<input type="file" accept="image/*,video/*" multiple id="meme-upload-input"></label>
        <button class="ref-btn" data-meme-toggle-select="1">${MEME_SELECT_MODE ? '✕ Cancel select' : '☑️ Select'}</button>
      </div>
      ${MEME_SELECT_MODE ? `
        <div class="export-row" style="margin-bottom:10px;background:var(--card);border:1px solid var(--purple);border-radius:var(--radius-sm);padding:8px;">
          <div style="flex:1;font-size:12.5px;color:var(--text-dim);align-self:center;">${MEME_SELECTED.size} selected</div>
          <button class="ref-btn" data-meme-tag-selected="1" ${MEME_SELECTED.size ? '' : 'disabled'}>🏷️ Add to mood…</button>
          ${!isSFW() ? `<button class="ref-btn" data-meme-pull-selected-into-h="1" style="${MEME_SELECTED.size ? 'color:#f43f5e;' : ''}" ${MEME_SELECTED.size ? '' : 'disabled'}>🔴 Pull into NSFW</button>` : ''}
          <button class="btn-ghost" data-meme-delete-selected="1" ${MEME_SELECTED.size ? '' : 'disabled'}>🗑️ Delete selected</button>
        </div>
      ` : ''}
      <div class="tagmgr-tabs" style="margin-bottom:8px;">
        <button class="tagmgr-tab ${!MEME_SHOWING_DUPLICATES ? 'active' : ''}" data-meme-tab="grid">Gallery</button>
        <button class="tagmgr-tab ${MEME_SHOWING_DUPLICATES ? 'active' : ''}" data-meme-tab="duplicates">Possible Duplicates${MEME_DUP_GROUPS !== null ? ` (${MEME_DUP_GROUPS.length})` : ''}</button>
        <button class="ref-btn ${MEME_STATE.untaggedOnly ? 'active' : ''}" style="flex:0 0 auto;padding:8px 12px;white-space:nowrap;${MEME_STATE.untaggedOnly ? 'background:var(--purple);color:#fff;' : ''}" data-meme-untagged-only="1" title="Show only untagged reactions">${untaggedCount} untagged</button>
        <button class="ref-btn" style="flex:0 0 auto;padding:8px 12px;white-space:nowrap;" data-meme-manage-moods="1" title="Manage mood groups (rename/delete)">✏️ Manage</button>
      </div>
      ${!MEME_SHOWING_DUPLICATES ? `
        <button class="filters-toggle-btn" data-meme-toggle-filters="1">${MEME_FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters'}</button>
        <div class="filters-collapsible ${MEME_FILTERS_COLLAPSED ? 'collapsed' : ''}" id="meme-filters-collapsible">
          <div class="group-chip-row">
            ${moodChips}
            <button class="mood-chip" data-meme-add-mood="1">➕ New mood</button>
          </div>
        </div>
      ` : ''}
    </div>
    <main class="gallery-dropzone">${memeMainBody()}</main>
    ${renderBottomNav('meme')}
  `;
}

function attachMemeGridHandlers() {
  document.querySelectorAll('[data-open-meme]').forEach((el) => {
    el.onclick = async () => {
      const id = el.getAttribute('data-open-meme');
      if (MEME_SELECT_MODE) {
        if (MEME_SELECTED.has(id)) MEME_SELECTED.delete(id); else MEME_SELECTED.add(id);
        render();
      } else if (MEME_SHOWING_DUPLICATES) {
        // Same fast-triage tap-to-delete flow as the Images duplicates tab.
        if (!confirm('Delete this image from your library? Any entries it\'s already attached to keep their own copy.')) return;
        const deletedRec = ALL_REACTIONS.find((r) => r.id === id);
        const memeDupGroup = (MEME_DUP_GROUPS || []).find((g) => g.some((r) => r.id === id));
        if (deletedRec && memeDupGroup) {
          const survivorMemeUrls = memeDupGroup.filter((r) => r.id !== id).map((r) => r.dataUrl);
          await transferDuplicateTagsOnDelete(deletedRec.dataUrl, survivorMemeUrls, id);
          await transferEntryAttachmentOnDuplicateDelete(deletedRec.dataUrl, survivorMemeUrls);
        }
        await deleteReaction(id);
        if (MEME_DUP_GROUPS) {
          MEME_DUP_GROUPS = MEME_DUP_GROUPS
            .map((g) => g.filter((r) => r.id !== id))
            .filter((g) => g.length > 1);
        }
        // A reaction can also show up in the Images tab's own duplicate
        // scan (via img.reactionId) — drop it from there too.
        if (IMAGE_DUP_GROUPS) IMAGE_DUP_GROUPS = IMAGE_DUP_GROUPS.filter((g) => !g.some((img) => img.reactionId === id));
        showToast('Deleted');
        render();
      } else {
        openMemeEditModal(id);
      }
    };
  });
  document.querySelectorAll('[data-meme-tab]').forEach((el) => {
    el.onclick = () => { MEME_SHOWING_DUPLICATES = el.getAttribute('data-meme-tab') === 'duplicates'; render(); };
  });
  const untaggedOnlyBtn = document.querySelector('[data-meme-untagged-only]');
  if (untaggedOnlyBtn) untaggedOnlyBtn.onclick = () => { MEME_STATE.untaggedOnly = !MEME_STATE.untaggedOnly; render(); };
  const scanMemeDupBtn = document.querySelector('[data-scan-meme-duplicates]');
  if (scanMemeDupBtn) scanMemeDupBtn.onclick = () => scanForMemeDuplicates();
  const resetDismissedMemeDupsBtn = document.querySelector('[data-reset-dismissed-meme-dups]');
  if (resetDismissedMemeDupsBtn) resetDismissedMemeDupsBtn.onclick = () => resetDismissedMemeDupGroups();
  document.querySelectorAll('[data-dismiss-meme-dup-group]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); dismissMemeDupGroup(Number(el.getAttribute('data-dismiss-meme-dup-group'))); };
  });
  const toggleMemeSelectBtn = document.querySelector('[data-meme-toggle-select]');
  if (toggleMemeSelectBtn) toggleMemeSelectBtn.onclick = () => { MEME_SELECT_MODE = !MEME_SELECT_MODE; MEME_SELECTED = new Set(); render(); };
  const memeFiltersToggleBtn = document.querySelector('[data-meme-toggle-filters]');
  if (memeFiltersToggleBtn) memeFiltersToggleBtn.onclick = () => {
    MEME_FILTERS_COLLAPSED = !MEME_FILTERS_COLLAPSED;
    const el = document.getElementById('meme-filters-collapsible');
    if (el) el.classList.toggle('collapsed', MEME_FILTERS_COLLAPSED);
    memeFiltersToggleBtn.textContent = MEME_FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters';
  };
  const tagSelectedMemesBtn = document.querySelector('[data-meme-tag-selected]');
  if (tagSelectedMemesBtn) tagSelectedMemesBtn.onclick = () => {
    if (MEME_SELECTED.size) openTagSelectedMemesModal(Array.from(MEME_SELECTED));
  };
  const pullSelectedIntoHBtn = document.querySelector('[data-meme-pull-selected-into-h]');
  if (pullSelectedIntoHBtn) pullSelectedIntoHBtn.onclick = () => {
    if (!MEME_SELECTED.size) return;
    const ids = Array.from(MEME_SELECTED);
    ids.forEach((id) => {
      const r = ALL_REACTIONS.find((x) => x.id === id);
      if (r && r.dataUrl) pullImageIntoH(r.dataUrl);
    });
    MEME_SELECT_MODE = false;
    MEME_SELECTED = new Set();
    showToast(`Pulled ${ids.length} reaction${ids.length === 1 ? '' : 's'} into H`);
    render();
  };
  const deleteSelectedMemeBtn = document.querySelector('[data-meme-delete-selected]');
  if (deleteSelectedMemeBtn) deleteSelectedMemeBtn.onclick = async () => {
    if (!MEME_SELECTED.size) return;
    if (!confirm(`Delete ${MEME_SELECTED.size} reaction(s)? This can't be undone.`)) return;
    const ids = Array.from(MEME_SELECTED);
    for (const id of ids) await deleteReaction(id);
    // Same as the single-item delete — drop the deleted ones from whichever
    // duplicate group is currently showing so it updates immediately instead
    // of leaving ghost thumbnails until the next rescan.
    if (MEME_DUP_GROUPS) {
      MEME_DUP_GROUPS = MEME_DUP_GROUPS
        .map((g) => g.filter((r) => !ids.includes(r.id)))
        .filter((g) => g.length > 1);
    }
    if (IMAGE_DUP_GROUPS) IMAGE_DUP_GROUPS = IMAGE_DUP_GROUPS.filter((g) => !g.some((img) => ids.includes(img.reactionId)));
    MEME_SELECT_MODE = false;
    MEME_SELECTED = new Set();
    showToast('Deleted');
    render();
  };
}

// Bulk mood tagging for multi-selected Reactions — same gap Images already
// had closed (see tagImagesWithGroup/openTagSelectedImagesModal): before
// this, adding several reactions to a mood at once meant opening each one
// individually. Always adds, never toggles off, same reasoning as Images'
// version — with multiple selected some may already carry the mood.
function tagMemesWithMood(ids, mood) {
  ids.forEach((id) => {
    const r = ALL_REACTIONS.find((x) => x.id === id);
    if (!r) return;
    r.moodTags = r.moodTags || [];
    if (!r.moodTags.includes(mood)) r.moodTags.push(mood);
    saveReaction(r);
  });
}
function openTagSelectedMemesModal(ids) {
  openModal(`
    <h3>Add ${ids.length} reaction${ids.length === 1 ? '' : 's'} to a mood…</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
      ${allMoodOptions().map((m) => `<button class="mood-chip" data-tag-selected-memes-with="${escapeHtml(m.key)}">${m.emoji ? m.emoji + ' ' : ''}${escapeHtml(m.label)}</button>`).join('')}
      <button class="mood-chip" data-tag-selected-memes-new-mood="1">➕ New mood</button>
    </div>
    <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Cancel</button></div>
  `);
  document.querySelectorAll('[data-tag-selected-memes-with]').forEach((el) => {
    el.onclick = () => {
      const mood = el.getAttribute('data-tag-selected-memes-with');
      tagMemesWithMood(ids, mood);
      closeModal();
      MEME_SELECT_MODE = false;
      MEME_SELECTED = new Set();
      showToast(`Added ${ids.length} reaction${ids.length === 1 ? '' : 's'} to "${mood}"`);
      render();
    };
  });
  const newMoodBtn = document.querySelector('[data-tag-selected-memes-new-mood]');
  if (newMoodBtn) newMoodBtn.onclick = () => {
    const key = addCustomMood(prompt('Name this new mood group (e.g. "creepy", "cute"):'));
    if (!key) return;
    tagMemesWithMood(ids, key);
    closeModal();
    MEME_SELECT_MODE = false;
    MEME_SELECTED = new Set();
    showToast(`Added ${ids.length} reaction${ids.length === 1 ? '' : 's'} to "${key}"`);
    render();
  };
}

function openMemeEditModal(id) {
  const r = ALL_REACTIONS.find((x) => x.id === id);
  if (!r) return;
  const { prev, next } = mediaModalNavNeighbors(MEME_NAV_LIST, id);
  openModal(`
    <div class="modal-close-corner-wrap">
      <button class="modal-close-x" data-close-modal="1" title="Close">✕</button>
      <h3>Edit reaction</h3>
    <div class="modal-media-nav" id="modal-media-nav" style="margin-bottom:10px;">
      ${mediaModalNavArrowsHtml('meme', prev, next)}
      ${r.dataUrl
        ? (isVideoUrl(r.dataUrl)
            ? `<video src="${r.dataUrl}" autoplay loop muted controls playsinline style="width:100%;max-height:65vh;object-fit:contain;border-radius:10px;background:#000;"></video>`
            : `<img src="${r.dataUrl}" alt="" style="width:100%;max-height:65vh;object-fit:contain;border-radius:10px;background:#000;">`)
        : `<div class="cover-placeholder" style="height:180px;">⏳ Still downloading from Drive…</div>`}
    </div>
    <div class="field-row">
      <label>Mood ${!(r.moodTags || []).length ? '<span style="color:var(--red-flag);">— pick at least one</span>' : ''}</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
        ${allMoodOptions().map((m) => `<button class="mood-chip ${(r.moodTags || []).includes(m.key) ? 'active' : ''}" data-meme-toggle-mood="${escapeHtml(m.key)}" data-meme-id="${r.id}">${m.emoji ? m.emoji + ' ' : ''}${escapeHtml(m.label)}</button>`).join('')}
        <button class="mood-chip" data-meme-add-mood-for="${r.id}">➕ New mood</button>
      </div>
    </div>
    ${r.dataUrl ? `
    <div class="field-row">
      <label>Also in</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
        ${mediaToggleButtonsHtml(r.dataUrl, true, isDataUrlInH(r.dataUrl), false, { type: 'meme', id: r.id })}
      </div>
    </div>
    ` : ''}
      <div class="modal-actions">
        <button class="btn-ghost" data-delete-meme="${r.id}">🗑️ Delete</button>
        ${isCroppableDataUrl(r.dataUrl) ? `<button class="btn-ghost" data-crop-meme="${r.id}">✂️ Crop</button>` : ''}
        ${r.dataUrl ? `<button class="btn-ghost" data-save-image="${escapeHtml(r.dataUrl)}">⬇️ Save</button>` : ''}
        <button class="btn-primary" data-close-modal="1">Done</button>
      </div>
    </div>
  `, { centered: true });
  wireModalSwipeNav(prev ? () => openMemeEditModal(prev) : null, next ? () => openMemeEditModal(next) : null);
}

// Simple drag-to-move, drag-corner-to-resize crop box over the reaction
// image — no external cropping library, just Pointer Events + canvas.
// Static images only (see the Crop button's animated-file check above):
// cropping via canvas would flatten a GIF/WebP to its first frame, which
// would silently kill the animation, so the button never appears for those.
// Generic crop stage, shared by Images/Reactions/H — used to only live here
// keyed to a single reaction id. `onSave(newDataUrl)` gets called once the
// user hits Save; each gallery supplies its own logic for where the cropped
// result needs to land (a reaction record, an entry's photo field, a
// standalone H upload, or all of the above at once for a shared image).
function openCropModal(dataUrl, onSave, title) {
  if (!dataUrl) return;
  openModal(`
    <div class="modal-close-corner-wrap">
      <button class="modal-close-x" data-close-modal="1" title="Close">✕</button>
      <h3>${escapeHtml(title || 'Crop image')}</h3>
      <div class="crop-stage" id="crop-stage">
        <img src="${dataUrl}" id="crop-img" alt="" draggable="false">
        <div class="crop-box" id="crop-box">
          <div class="crop-handle" id="crop-handle-br"></div>
        </div>
      </div>
      <p style="font-size:11px;color:var(--text-dim);margin-top:8px;">Drag the box to move it, drag the corner dot to resize, then Save.</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-close-modal="1">Cancel</button>
        <button class="btn-primary" id="crop-save-btn">✂️ Save Crop</button>
      </div>
    </div>
  `, { centered: true });
  wireCropStage();
  const saveBtn = document.getElementById('crop-save-btn');
  if (saveBtn) saveBtn.onclick = async () => {
    const newDataUrl = computeCroppedDataUrl();
    if (!newDataUrl) return;
    saveBtn.disabled = true;
    await onSave(newDataUrl);
  };
}

function computeCroppedDataUrl() {
  const img = document.getElementById('crop-img');
  const box = document.getElementById('crop-box');
  if (!img || !box || !box._imgOffset) return null;
  const off = box._imgOffset;
  const scaleX = img.naturalWidth / off.w;
  const scaleY = img.naturalHeight / off.h;
  const boxLeft = parseFloat(box.style.left) - off.left;
  const boxTop = parseFloat(box.style.top) - off.top;
  const boxW = parseFloat(box.style.width);
  const boxH = parseFloat(box.style.height);
  const sx = boxLeft * scaleX, sy = boxTop * scaleY, sw = boxW * scaleX, sh = boxH * scaleY;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

// Cropping changes the image's bytes, which changes its imageKey() hash —
// every per-image tag/note/H-membership map is keyed by that hash, so
// without this they'd silently orphan onto the old (now-gone) key the
// moment a crop saves. Carries them over to the new key instead.
function migrateImageKeyMetadata(oldDataUrl, newDataUrl) {
  const oldKey = imageKey(oldDataUrl);
  const newKey = imageKey(newDataUrl);
  if (oldKey === newKey) return;
  if (IMAGE_TAG_MAP[oldKey]) { IMAGE_TAG_MAP[newKey] = IMAGE_TAG_MAP[oldKey]; delete IMAGE_TAG_MAP[oldKey]; persistImageTagMap(); }
  if (H_TAG_MAP[oldKey]) { H_TAG_MAP[newKey] = H_TAG_MAP[oldKey]; delete H_TAG_MAP[oldKey]; persistHTagMap(); }
  if (H_NOTE_MAP[oldKey]) { H_NOTE_MAP[newKey] = H_NOTE_MAP[oldKey]; delete H_NOTE_MAP[oldKey]; persistHNoteMap(); }
  if (H_IMAGE_KEYS.has(oldKey)) { H_IMAGE_KEYS.delete(oldKey); H_IMAGE_KEYS.add(newKey); persistHImageKeys(); }
}

// A photo can live as a copy in up to three places at once — an entry's
// semi/uke photo or a screencap, a Reactions record, and a standalone NSFW
// upload. Cropping used to only ever update wherever the crop was actually
// opened from (and Reactions-side crops didn't even try to reach entries at
// all), so the other copies silently kept showing the pre-crop image.
// Called after every crop save to bring every sibling copy in line.
//
// Matching is exact-dataUrl first (fast, zero false-positive risk), since
// that's still true immediately after "use elsewhere in this gallery" links
// two copies. If that finds nothing, we fall back to a tight perceptual-hash
// match (Hamming distance ≤2 — well under the ≤6 threshold Possible
// Duplicates uses) because two copies of "the same" picture often aren't
// byte-identical: each gallery uploads/re-encodes its own copy to Drive
// independently, so raw bytes can drift apart over time even though it's
// visually the same photo. The tight threshold keeps this fallback from
// ever touching an unrelated, merely-similar-looking image.
async function propagateCropEverywhere(oldDataUrl, newDataUrl, opts) {
  const skipReactionId = (opts && opts.skipReactionId) || null;
  const skipHId = (opts && opts.skipHId) || null;

  async function reuploadEntryField(entryId, field, idx) {
    const label = field === 'screencap' ? `${entryId}-screencap-${Date.now()}-${idx}` : `${entryId}-${field}-photo`;
    tryUploadImageToDrive(newDataUrl, `${label}.jpg`).then((fileId) => {
      if (!fileId) return;
      const fresh = ALL_ENTRIES.find((x) => x.id === entryId);
      if (!fresh) return;
      if (field === 'semi' && fresh.semi && fresh.semi.photo === newDataUrl) { fresh.semi.photoDriveId = fileId; saveEntry(fresh); }
      else if (field === 'uke' && fresh.uke && fresh.uke.photo === newDataUrl) { fresh.uke.photoDriveId = fileId; saveEntry(fresh); }
      else if (field === 'screencap' && fresh.screencapDriveIds && fresh.screencaps && fresh.screencaps[idx] === newDataUrl) { fresh.screencapDriveIds[idx] = fileId; saveEntry(fresh); }
    });
  }

  let entryChanged = false;
  for (const e of ALL_ENTRIES) {
    let changed = false;
    if (e.semi && e.semi.photo === oldDataUrl) {
      e.semi.photo = newDataUrl; e.semi.photoDriveId = null; changed = true;
      reuploadEntryField(e.id, 'semi', null);
    }
    if (e.uke && e.uke.photo === oldDataUrl) {
      e.uke.photo = newDataUrl; e.uke.photoDriveId = null; changed = true;
      reuploadEntryField(e.id, 'uke', null);
    }
    if (e.screencaps && e.screencaps.includes(oldDataUrl)) {
      const idx = e.screencaps.indexOf(oldDataUrl);
      e.screencaps[idx] = newDataUrl;
      if (e.screencapDriveIds && e.screencapDriveIds[idx]) e.screencapDriveIds[idx] = null;
      changed = true;
      reuploadEntryField(e.id, 'screencap', idx);
    }
    if (changed) { entryChanged = true; await saveEntry(e); }
  }

  let reactionChanged = false;
  for (const r of ALL_REACTIONS) {
    if (r.id === skipReactionId || r.dataUrl !== oldDataUrl) continue;
    r.dataUrl = newDataUrl;
    r.hash = await hashDataUrl(newDataUrl);
    r.driveId = null;
    await saveReaction(r);
    tryUploadImageToDrive(newDataUrl, `reaction-${r.id}.jpg`, 'reaction').then((fileId) => {
      if (!fileId) return;
      const fresh = ALL_REACTIONS.find((x) => x.id === r.id);
      if (fresh && fresh.dataUrl === newDataUrl) { fresh.driveId = fileId; saveReaction(fresh); }
    });
    reactionChanged = true;
  }

  let hChanged = false;
  for (const hi of ALL_H_IMAGES) {
    if (hi.id === skipHId || hi.dataUrl !== oldDataUrl) continue;
    const fresh0 = ALL_H_IMAGES.find((x) => x.id === hi.id);
    if (!fresh0) continue;
    fresh0.dataUrl = newDataUrl;
    fresh0.hash = await hashDataUrl(newDataUrl);
    fresh0.driveId = null;
    await saveHImage(fresh0);
    tryUploadImageToDrive(newDataUrl, `h-${fresh0.id}.jpg`, 'h').then((fileId) => {
      if (!fileId) return;
      const f2 = ALL_H_IMAGES.find((x) => x.id === fresh0.id);
      if (f2 && f2.dataUrl === newDataUrl) { f2.driveId = fileId; saveHImage(f2); }
    });
    hChanged = true;
  }

  // Exact match found nothing anywhere else — fall back to visual similarity
  // in case a sibling copy exists but has already drifted to different bytes.
  if (!entryChanged && !reactionChanged && !hChanged) {
    const targetHash = await perceptualHash(oldDataUrl);
    if (targetHash) {
      for (const e of ALL_ENTRIES) {
        let changed = false;
        if (e.semi && e.semi.photo && e.semi.photo !== newDataUrl) {
          const h = await perceptualHash(e.semi.photo);
          if (hammingDistance(targetHash, h) <= 2) { e.semi.photo = newDataUrl; e.semi.photoDriveId = null; changed = true; reuploadEntryField(e.id, 'semi', null); }
        }
        if (e.uke && e.uke.photo && e.uke.photo !== newDataUrl) {
          const h = await perceptualHash(e.uke.photo);
          if (hammingDistance(targetHash, h) <= 2) { e.uke.photo = newDataUrl; e.uke.photoDriveId = null; changed = true; reuploadEntryField(e.id, 'uke', null); }
        }
        if (e.screencaps) {
          for (let i = 0; i < e.screencaps.length; i++) {
            if (e.screencaps[i] === newDataUrl) continue;
            const h = await perceptualHash(e.screencaps[i]);
            if (hammingDistance(targetHash, h) <= 2) {
              e.screencaps[i] = newDataUrl;
              if (e.screencapDriveIds && e.screencapDriveIds[i]) e.screencapDriveIds[i] = null;
              changed = true;
              reuploadEntryField(e.id, 'screencap', i);
            }
          }
        }
        if (changed) await saveEntry(e);
      }
      for (const r of ALL_REACTIONS) {
        if (r.id === skipReactionId || !r.dataUrl || r.dataUrl === newDataUrl) continue;
        const h = await perceptualHash(r.dataUrl);
        if (hammingDistance(targetHash, h) <= 2) {
          r.dataUrl = newDataUrl; r.hash = await hashDataUrl(newDataUrl); r.driveId = null;
          await saveReaction(r);
          tryUploadImageToDrive(newDataUrl, `reaction-${r.id}.jpg`, 'reaction').then((fileId) => {
            if (!fileId) return;
            const fresh = ALL_REACTIONS.find((x) => x.id === r.id);
            if (fresh && fresh.dataUrl === newDataUrl) { fresh.driveId = fileId; saveReaction(fresh); }
          });
        }
      }
      for (const hi of ALL_H_IMAGES) {
        if (hi.id === skipHId || !hi.dataUrl || hi.dataUrl === newDataUrl) continue;
        const h = await perceptualHash(hi.dataUrl);
        if (hammingDistance(targetHash, h) <= 2) {
          const fresh = ALL_H_IMAGES.find((x) => x.id === hi.id);
          if (fresh) {
            fresh.dataUrl = newDataUrl; fresh.hash = await hashDataUrl(newDataUrl); fresh.driveId = null;
            await saveHImage(fresh);
            tryUploadImageToDrive(newDataUrl, `h-${fresh.id}.jpg`, 'h').then((fileId) => {
              if (!fileId) return;
              const f2 = ALL_H_IMAGES.find((x) => x.id === fresh.id);
              if (f2 && f2.dataUrl === newDataUrl) { f2.driveId = fileId; saveHImage(f2); }
            });
          }
        }
      }
    }
  }

  migrateImageKeyMetadata(oldDataUrl, newDataUrl);
}

function openCropReactionModal(id) {
  const r = ALL_REACTIONS.find((x) => x.id === id);
  if (!r || !r.dataUrl) return;
  openCropModal(r.dataUrl, async (newDataUrl) => {
    const fresh = ALL_REACTIONS.find((x) => x.id === id);
    if (!fresh) return;
    const oldDataUrl = fresh.dataUrl;
    fresh.dataUrl = newDataUrl;
    fresh.hash = await hashDataUrl(newDataUrl);
    fresh.driveId = null;
    await saveReaction(fresh);
    await propagateCropEverywhere(oldDataUrl, newDataUrl, { skipReactionId: id });
    showToast('Cropped!');
    // The masonry grid behind this modal was rendered with the OLD dataUrl
    // baked into its <img src>— closing/reopening the modal alone doesn't
    // touch it, so the gallery kept showing the pre-crop image until
    // something else forced a full re-render. Re-render before reopening.
    render();
    closeModal();
    openMemeEditModal(id);
    tryUploadImageToDrive(newDataUrl, `reaction-${fresh.id}.jpg`, 'reaction').then((fileId) => {
      if (!fileId) return;
      const f2 = ALL_REACTIONS.find((x) => x.id === id);
      if (!f2) return;
      f2.driveId = fileId;
      saveReaction(f2);
    });
  }, 'Crop reaction');
}

// Images-tab crop: the same dataUrl can live on an entry's semi/uke photo
// and/or its screencaps, and (since the direct-upload fix) may ALSO be a
// standalone reaction or NSFW upload — propagateCropEverywhere() updates
// every place it's found so nothing goes out of sync with a stale,
// uncropped copy.
async function openCropImageModal(dataUrl) {
  openCropModal(dataUrl, async (newDataUrl) => {
    await propagateCropEverywhere(dataUrl, newDataUrl, {});
    showToast('Cropped!');
    render();
    closeModal();
    openImageAttachmentsModal(newDataUrl);
  }, 'Crop image');
}

// H-tab crop: a standalone H upload has its own record to update; an
// entry-sourced H image (just flagged via H_IMAGE_KEYS, no copy of its own)
// gets updated the same way an Images-tab crop would. Either way,
// propagateCropEverywhere() also reaches any sibling Reactions/Images copy.
async function openCropHModal(dataUrl) {
  const upload = ALL_H_IMAGES.find((h) => h.dataUrl === dataUrl);
  openCropModal(dataUrl, async (newDataUrl) => {
    if (upload) {
      const fresh = ALL_H_IMAGES.find((h) => h.id === upload.id);
      if (fresh) {
        fresh.dataUrl = newDataUrl;
        fresh.hash = await hashDataUrl(newDataUrl);
        fresh.driveId = null;
        await saveHImage(fresh);
        tryUploadImageToDrive(newDataUrl, `h-${fresh.id}.jpg`, 'h').then((fileId) => {
          if (!fileId) return;
          const f2 = ALL_H_IMAGES.find((h) => h.id === fresh.id);
          if (f2) { f2.driveId = fileId; saveHImage(f2); }
        });
      }
      await propagateCropEverywhere(dataUrl, newDataUrl, { skipHId: upload.id });
    } else {
      await propagateCropEverywhere(dataUrl, newDataUrl, {});
    }
    showToast('Cropped!');
    render();
    closeModal();
    openHImageModal(newDataUrl);
  }, 'Crop H image');
}

function wireCropStage() {
  const stage = document.getElementById('crop-stage');
  const img = document.getElementById('crop-img');
  const box = document.getElementById('crop-box');
  const handle = document.getElementById('crop-handle-br');
  if (!stage || !img || !box || !handle) return;

  function initBox() {
    const stageRect = stage.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const left = imgRect.left - stageRect.left;
    const top = imgRect.top - stageRect.top;
    const iw = imgRect.width, ih = imgRect.height;
    box._imgOffset = { left, top, w: iw, h: ih };
    box.style.left = (left + iw * 0.1) + 'px';
    box.style.top = (top + ih * 0.1) + 'px';
    box.style.width = (iw * 0.8) + 'px';
    box.style.height = (ih * 0.8) + 'px';
  }
  if (img.complete && img.naturalWidth) initBox(); else img.onload = initBox;

  function clampBox() {
    const off = box._imgOffset;
    if (!off) return;
    let left = parseFloat(box.style.left), top = parseFloat(box.style.top);
    let w = parseFloat(box.style.width), h = parseFloat(box.style.height);
    w = Math.max(24, Math.min(w, off.w));
    h = Math.max(24, Math.min(h, off.h));
    left = Math.max(off.left, Math.min(left, off.left + off.w - w));
    top = Math.max(off.top, Math.min(top, off.top + off.h - h));
    box.style.left = left + 'px'; box.style.top = top + 'px';
    box.style.width = w + 'px'; box.style.height = h + 'px';
  }

  let dragMode = null;
  let start = null;
  box.onpointerdown = (ev) => {
    if (ev.target === handle) return;
    dragMode = 'move';
    start = { x: ev.clientX, y: ev.clientY, left: parseFloat(box.style.left), top: parseFloat(box.style.top) };
    box.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  };
  handle.onpointerdown = (ev) => {
    dragMode = 'resize';
    start = { x: ev.clientX, y: ev.clientY, w: parseFloat(box.style.width), h: parseFloat(box.style.height) };
    handle.setPointerCapture(ev.pointerId);
    ev.stopPropagation();
    ev.preventDefault();
  };
  function onMove(ev) {
    if (!dragMode) return;
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
    if (dragMode === 'move') {
      box.style.left = (start.left + dx) + 'px';
      box.style.top = (start.top + dy) + 'px';
    } else if (dragMode === 'resize') {
      box.style.width = (start.w + dx) + 'px';
      box.style.height = (start.h + dy) + 'px';
    }
    clampBox();
  }
  box.onpointermove = onMove;
  handle.onpointermove = onMove;
  function endDrag() { dragMode = null; }
  box.onpointerup = endDrag;
  handle.onpointerup = endDrag;
  box.onpointercancel = endDrag;
  handle.onpointercancel = endDrag;
}

// Uploads into the standalone meme/reaction library (bottom-nav "Reactions").
// These are never attached to a specific journal entry — just organized by
// mood tag and searched by caption/keywords, Giphy-style.
// Flags an outlier upload before we even try to process it — mainly aimed
// at large animated GIFs, since those skip the usual canvas compression
// (see isAnimated below) and could otherwise silently bloat IndexedDB/Drive
// or blow past Firestore's 1MiB doc cap with no explanation to the user.
const MAX_REACTION_FILE_BYTES = 20 * 1024 * 1024; // 20MB
function showOversizedFilesModal(oversizedFiles) {
  const items = oversizedFiles.map((file) => {
    const url = URL.createObjectURL(file);
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    const preview = file.type.startsWith('video/')
      ? `<video src="${url}" autoplay loop muted controls style="width:100%;max-height:220px;object-fit:contain;border-radius:10px;background:#000;margin-bottom:6px;"></video>`
      : `<img src="${url}" alt="" style="width:100%;max-height:220px;object-fit:contain;border-radius:10px;background:#000;margin-bottom:6px;">`;
    return `<div style="margin-bottom:12px;">${preview}<div style="font-size:13px;">${escapeHtml(file.name)} — ${mb}MB</div></div>`;
  }).join('');
  openModal(`
    <div class="modal-close-corner-wrap">
      <button class="modal-close-x" data-close-modal="1" title="Close">✕</button>
      <h3>File${oversizedFiles.length === 1 ? '' : 's'} too large</h3>
      <p style="color:var(--text-dim);font-size:13px;">${oversizedFiles.length === 1 ? "This file wasn't" : "These weren't"} uploaded — anything over 20MB is too large to save reliably. Try a smaller or compressed version.</p>
      ${items}
      <div class="modal-actions"><button class="btn-primary" data-close-modal="1">OK</button></div>
    </div>
  `);
}
// `source` records which gallery an upload came in through — 'images' (the
// Images tab's own upload, or an entry's reaction picker) vs 'reactions' (the
// standalone Reactions/mood library). This is what lets allAppImages() tell
// the two apart: only 'images'-sourced standalone reactions belong in the
// Images gallery's Unattached pool, while true Reactions-tab uploads (meant
// to live purely by mood tag) stay out of it. Records saved before this
// distinction existed have no `source` at all — those default to 'images' in
// allAppImages() so nothing already visible there disappears retroactively.
async function addReactionFiles(fileList, source = 'images') {
  const added = [];
  const oversized = [];
  for (const file of fileList) {
    if (file.size > MAX_REACTION_FILE_BYTES) { oversized.push(file); continue; }
    // GIFs (and animated WebP) lose their animation the moment they get
    // redrawn onto a <canvas> and re-encoded — fileToCompressedDataUrl()
    // does exactly that, which is why every reaction used to end up a
    // static single frame. Keep the original bytes untouched for anything
    // animated so the <img> tag can autoplay it natively, both in the
    // gallery grid and in the single-reaction edit view; only flatten/
    // downscale the normal static-image case.
    const isAnimated = file.type === 'image/gif' || file.type === 'image/webp';
    // Video clips get the same "leave the original bytes alone" treatment as
    // animated GIF/WebP — canvas re-encoding only makes sense for a static
    // image, and would silently mangle a video into a single frame.
    const isVideo = file.type.startsWith('video/');
    const dataUrl = (isAnimated || isVideo) ? await fileToDataUrl(file) : await fileToCompressedDataUrl(file, 800);
    // Used to block here with a confirm() popup on a possible-duplicate
    // hash match — per her request, uploads always go through now instead;
    // the Possible Duplicates scan (scanForMemeDuplicates/etc.) is the
    // dedicated place to find and clean up real dupes after the fact.
    const hash = await hashDataUrl(dataUrl);
    const reaction = { id: uid('reaction'), dataUrl, hash, moodTags: [], note: '', source, createdAt: new Date().toISOString() };
    await saveReaction(reaction);
    added.push(reaction);
    const ext = isVideo ? (file.type.split('/')[1] || 'mp4') : (isAnimated ? (file.type === 'image/gif' ? 'gif' : 'webp') : 'jpg');
    tryUploadImageToDrive(dataUrl, `reaction-${reaction.id}.${ext}`, 'reaction').then((fileId) => {
      if (!fileId) return;
      const fresh = ALL_REACTIONS.find((r) => r.id === reaction.id);
      if (!fresh) return;
      fresh.driveId = fileId;
      saveReaction(fresh);
    });
  }
  if (oversized.length) showOversizedFilesModal(oversized);
  return added;
}

function openReactionPickerModal(entryId) {
  const items = ALL_REACTIONS.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  openModal(`
    <h3>🖼️ Add from Images</h3>
    <p style="font-size:12px;color:var(--text-dim);">Tap to select, then Add. Or upload a brand-new one straight into this entry.</p>
    <label class="upload-btn" style="margin-bottom:10px;">📎 Upload new<input type="file" accept="image/*,video/*" multiple id="reaction-picker-upload"></label>
    <div class="reaction-picker-grid" id="reaction-picker-grid">
      ${items.length ? items.map((r) => `<div class="reaction-thumb pickable" data-pick-reaction="${r.id}">${isVideoUrl(r.dataUrl) ? `<video src="${r.dataUrl}" autoplay loop muted playsinline></video>` : `<img src="${r.dataUrl}" alt="">`}</div>`).join('') : '<div class="empty-state">No images saved yet — upload one above.</div>'}
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
    // Bug fix: this used to fall through to addReactionFiles' default
    // source ('images'), which is wrong here — this upload happens inside
    // the Reactions picker, not the Images tab. An 'images'-sourced record
    // stays permanently miscategorized into Images > Unattached unless she
    // happens to click "Add Selected" for it (which attaches it to the
    // entry and only then removes it from that bucket). Tagging it
    // 'reactions' up front, same as every other path into this pool, keeps
    // it out of Images entirely unless/until it's actually attached.
    const added = await addReactionFiles(uploadInput.files, 'reactions');
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
/* H / HENTAI LIBRARY (bottom-nav "H")                                    */
/* A separate, standalone gallery for NSFW/hentai images, kept out of the  */
/* normal Images tab entirely. Populated two ways, per her spec: (1)       */
/* "pulling" an existing entry-sourced image in (flags it via H_IMAGE_KEYS */
/* — same imageKey() lookup technique as the Images tab's own group tags — */
/* without duplicating the underlying image data), or (2) uploading        */
/* straight into this tab (a genuinely standalone image, stored in its own */
/* ALL_H_IMAGES collection, mirroring ALL_REACTIONS/STORE_REACTIONS end to */
/* end: its own IndexedDB store, Drive subfolder, and Firestore            */
/* subcollection + live listener). Set up like the Images tab throughout — */
/* masonry gallery, groups, select mode, an edit/attachments modal.        */
/* ---------------------------------------------------------------------- */

async function loadAllHImages() {
  ALL_H_IMAGES = await idbGetAll(STORE_H_IMAGES);
}
function findHImageByHash(hash) {
  return ALL_H_IMAGES.find((h) => h.hash === hash);
}
async function saveHImage(hImage) {
  hImage.updatedAt = new Date().toISOString();
  await idbPut(STORE_H_IMAGES, hImage);
  const idx = ALL_H_IMAGES.findIndex((h) => h.id === hImage.id);
  if (idx > -1) ALL_H_IMAGES[idx] = hImage; else ALL_H_IMAGES.push(hImage);
  pushHImageToFirestore(hImage);
}
// One-time repair for the downloadFromDrive bug (see the comment on that
// function): before the fix, a Drive file that 404'd (most likely an H
// upload orphaned by the still-pending account migration, see task
// "Migrate existing data to new Google-auth account") got its JSON error
// body base64-encoded and saved as a "successful" dataUrl — permanently,
// since a truthy dataUrl meant hydrateMissingHImages() never retried it.
// That's what made 21 NSFW uploads render as blank/broken tiles while
// still counting as "untagged" (they have *a* dataUrl, just not a real
// image). Clearing it back to null here lets them fall back into the
// normal pending-hydration path — where they'll either recover once Drive
// is reconnected and the file is found, or stay a clearly-pending "⏳"
// placeholder instead of a silent miscount.
async function repairCorruptedHDataUrls() {
  const marker = 'data:application/json;base64,';
  const bad = ALL_H_IMAGES.filter((h) => h.dataUrl && h.dataUrl.indexOf(marker) === 0);
  if (!bad.length) return;
  for (const h of bad) {
    h.dataUrl = null;
    await saveHImage(h);
  }
  console.warn(`Repaired ${bad.length} NSFW image(s) with a corrupted (failed-download) dataUrl.`);
  if (STATE.view === 'h') render();
}
async function deleteHImage(id) {
  const h = ALL_H_IMAGES.find((x) => x.id === id);
  await idbDelete(STORE_H_IMAGES, id);
  ALL_H_IMAGES = ALL_H_IMAGES.filter((x) => x.id !== id);
  deleteHImageFromFirestore(id);
  if (h && h.driveId) deleteFromDrive(h.driveId);
}
function userHImagesCol() {
  if (!CURRENT_USER) return null;
  return fbStore.collection('users').doc(CURRENT_USER.uid).collection('hImages');
}
function hImageSafeForFirestore(h) {
  return (h.driveId && h.dataUrl) ? { ...h, dataUrl: null } : h;
}
function pushHImageToFirestore(hImage) {
  const col = userHImagesCol();
  if (!col) return;
  const safe = hImageSafeForFirestore(hImage);
  const json = JSON.stringify(safe);
  if (json.length > 900 * 1024) {
    console.error('H image too large to sync to Firestore (kept locally on this device only).');
    showToast('That H image is too big to back up to the cloud — kept on this device only.');
    return;
  }
  col.doc(hImage.id).set(safe).catch((err) => {
    console.error('H image sync failed:', err);
    showToast("Couldn't back up that H image to the cloud — saved locally, will retry later.");
  });
}
function deleteHImageFromFirestore(id) {
  const col = userHImagesCol();
  if (!col) return;
  col.doc(id).delete().catch((err) => console.error('H image delete sync failed:', err));
}
// Same last-write-wins merge philosophy as syncReactionsWithFirestore.
async function syncHImagesWithFirestore(user) {
  const col = fbStore.collection('users').doc(user.uid).collection('hImages');
  const snap = await col.get({ source: 'server' }).catch(() => col.get());
  if (snap.empty) {
    if (ALL_H_IMAGES.length) {
      const batch = fbStore.batch();
      ALL_H_IMAGES.forEach((h) => {
        const safe = hImageSafeForFirestore(h);
        if (JSON.stringify(safe).length <= 900 * 1024) batch.set(col.doc(h.id), safe);
      });
      await batch.commit();
    }
    return;
  }
  const remote = snap.docs.map((d) => d.data());
  const localById = new Map(ALL_H_IMAGES.map((h) => [h.id, h]));
  const merged = [];
  const toLocal = [];
  const toRemote = [];
  remote.forEach((rh) => {
    const lh = localById.get(rh.id);
    if (!lh) { merged.push(rh); toLocal.push(rh); }
    else {
      const rt = new Date(rh.updatedAt || 0).getTime();
      const lt = new Date(lh.updatedAt || 0).getTime();
      merged.push(rt > lt ? rh : lh);
      if (rt > lt) toLocal.push(rh);
      else if (lt > rt) toRemote.push(lh);
    }
    localById.delete(rh.id);
  });
  localById.forEach((lh) => { merged.push(lh); toRemote.push(lh); });
  if (toLocal.length) await idbBulkPut(STORE_H_IMAGES, toLocal);
  if (toRemote.length) {
    const batch = fbStore.batch();
    let anySkipped = false;
    toRemote.forEach((h) => {
      const safe = hImageSafeForFirestore(h);
      if (JSON.stringify(safe).length <= 900 * 1024) batch.set(col.doc(h.id), safe);
      else anySkipped = true;
    });
    await batch.commit().catch((err) => console.error('H image bulk sync failed:', err));
    if (anySkipped) showToast('Some H images are too large to back up to the cloud — kept on this device only.');
  }
  ALL_H_IMAGES = merged;
  toLocal.forEach((h) => { hydrateDriveHImage(h).catch(() => {}); });
}
function startHImagesFirestoreListener(user) {
  if (H_FIRESTORE_UNSUB) { H_FIRESTORE_UNSUB(); H_FIRESTORE_UNSUB = null; }
  const col = fbStore.collection('users').doc(user.uid).collection('hImages');
  let skippedFirst = false;
  H_FIRESTORE_UNSUB = col.onSnapshot((snap) => {
    if (!skippedFirst) { skippedFirst = true; return; }
    let changed = false;
    snap.docChanges().forEach((change) => {
      const data = change.doc.data();
      if (change.type === 'removed') {
        if (ALL_H_IMAGES.some((h) => h.id === data.id)) {
          ALL_H_IMAGES = ALL_H_IMAGES.filter((h) => h.id !== data.id);
          idbDelete(STORE_H_IMAGES, data.id).catch(() => {});
          changed = true;
        }
        return;
      }
      const idx = ALL_H_IMAGES.findIndex((h) => h.id === data.id);
      const local = idx > -1 ? ALL_H_IMAGES[idx] : null;
      const rt = new Date(data.updatedAt || data.createdAt || 0).getTime();
      const lt = local ? new Date(local.updatedAt || local.createdAt || 0).getTime() : -1;
      if (rt >= lt) {
        const patched = { ...data };
        if (!patched.dataUrl && local && local.dataUrl) patched.dataUrl = local.dataUrl;
        if (idx > -1) ALL_H_IMAGES[idx] = patched; else ALL_H_IMAGES.push(patched);
        idbPut(STORE_H_IMAGES, patched).catch(() => {});
        hydrateDriveHImage(patched).catch(() => {});
        changed = true;
      }
    });
    if (changed && STATE.view === 'h') render();
  }, (err) => console.error('H images listener error:', err));
}
async function hydrateDriveHImage(hImage) {
  if (!hImage || !hImage.driveId || hImage.dataUrl) return;
  try {
    hImage.dataUrl = await downloadFromDrive(hImage.driveId);
    await idbPut(STORE_H_IMAGES, hImage);
    const idx = ALL_H_IMAGES.findIndex((h) => h.id === hImage.id);
    if (idx > -1) ALL_H_IMAGES[idx] = hImage;
    if (STATE.view === 'h') render();
  } catch (err) {
    console.error('H image hydrate failed:', err);
  }
}
// Same retry-path reasoning as hydrateMissingReactions() — catches anything
// still stuck as a "?" placeholder because Drive wasn't reachable the one
// time it would otherwise have hydrated.
let H_IMAGE_HYDRATE_BUSY = false;
async function hydrateMissingHImages() {
  if (H_IMAGE_HYDRATE_BUSY) return;
  const missing = ALL_H_IMAGES.filter((h) => h.driveId && !h.dataUrl);
  if (!missing.length) return;
  if (!driveTokenValid()) { DRIVE_NEEDS_RECONNECT = true; return; }
  H_IMAGE_HYDRATE_BUSY = true;
  let lastRender = 0;
  for (const h of missing) {
    if (!driveTokenValid()) break;
    try {
      h.dataUrl = await downloadFromDrive(h.driveId);
      await idbPut(STORE_H_IMAGES, h);
      const idx = ALL_H_IMAGES.findIndex((x) => x.id === h.id);
      if (idx > -1) ALL_H_IMAGES[idx] = h;
    } catch (err) {
      console.error('H image hydrate failed:', err);
    }
    if (STATE.view === 'h' && Date.now() - lastRender > 400) {
      render();
      lastRender = Date.now();
    }
  }
  H_IMAGE_HYDRATE_BUSY = false;
  if (STATE.view === 'h') render();
}

// Uploads straight into the standalone H library — never attached to any
// journal entry, same "add image(s)" pattern as Reactions/Images.
async function addHImageFiles(fileList) {
  const added = [];
  const oversized = [];
  for (const file of fileList) {
    if (file.size > MAX_REACTION_FILE_BYTES) { oversized.push(file); continue; }
    const isAnimated = file.type === 'image/gif' || file.type === 'image/webp';
    const isVideo = file.type.startsWith('video/');
    const dataUrl = (isAnimated || isVideo) ? await fileToDataUrl(file) : await fileToCompressedDataUrl(file, 900);
    // Used to block here with a confirm() popup on a possible-duplicate
    // hash match — per her request, uploads always go through now instead;
    // the Possible Duplicates (H) scan is the dedicated place to find and
    // clean up real dupes after the fact.
    const hash = await hashDataUrl(dataUrl);
    const hImage = { id: uid('h'), dataUrl, hash, createdAt: new Date().toISOString() };
    await saveHImage(hImage);
    added.push(hImage);
    const ext = isVideo ? (file.type.split('/')[1] || 'mp4') : (isAnimated ? (file.type === 'image/gif' ? 'gif' : 'webp') : 'jpg');
    tryUploadImageToDrive(dataUrl, `h-${hImage.id}.${ext}`, 'h').then((fileId) => {
      if (!fileId) return;
      const fresh = ALL_H_IMAGES.find((x) => x.id === hImage.id);
      if (!fresh) return;
      fresh.driveId = fileId;
      saveHImage(fresh);
    });
  }
  if (oversized.length) showOversizedFilesModal(oversized);
  return added;
}

// Groups, same idea/shape as IMAGE_GROUPS/IMAGE_TAG_MAP but a separate
// namespace — H groups (e.g. "favorites") stay independent of regular
// Images-tab groups.
let H_GROUPS = new Set();
let H_TAG_MAP = {}; // { [imageKey]: string[] group names }
// Same hide/delete lifecycle as the shared Images/Reactions groups above,
// but its own separate copy — H's groups were deliberately kept out of that
// shared set, so hiding/deleting one here has no effect on the other two
// galleries and vice versa.
let H_HIDDEN_GROUP_KEYS = new Set();
let H_DELETED_GROUP_KEYS = new Set();
let H_GROUP_MGR_TAB = 'active'; // 'active' | 'hidden'
function persistHGroups() {
  idbPut(STORE_META, { key: 'hGroups', value: Array.from(H_GROUPS) });
  pushMetaField('hGroups', Array.from(H_GROUPS));
}
function persistHTagMap() {
  idbPut(STORE_META, { key: 'hTagMap', value: H_TAG_MAP });
  pushMetaField('hTagMap', H_TAG_MAP);
}
function isHiddenHGroup(name) {
  return H_HIDDEN_GROUP_KEYS.has(name) || H_DELETED_GROUP_KEYS.has(name);
}
async function setHGroupSoftHidden(name, hidden) {
  if (hidden) H_HIDDEN_GROUP_KEYS.add(name); else H_HIDDEN_GROUP_KEYS.delete(name);
  const arr = Array.from(H_HIDDEN_GROUP_KEYS);
  await idbPut(STORE_META, { key: 'hHiddenGroupKeys', value: arr });
  pushMetaField('hHiddenGroupKeys', arr);
}
async function recordDeletedHGroup(name) {
  H_DELETED_GROUP_KEYS.add(name);
  const arr = Array.from(H_DELETED_GROUP_KEYS);
  await idbPut(STORE_META, { key: 'hDeletedGroupKeys', value: arr });
  pushMetaField('hDeletedGroupKeys', arr);
}
async function restoreDeletedHGroup(name) {
  H_DELETED_GROUP_KEYS.delete(name);
  const arr = Array.from(H_DELETED_GROUP_KEYS);
  await idbPut(STORE_META, { key: 'hDeletedGroupKeys', value: arr });
  pushMetaField('hDeletedGroupKeys', arr);
}
function hGroupUsageCount(key) {
  const urls = new Set();
  Object.keys(H_TAG_MAP).forEach((imgKey) => { if ((H_TAG_MAP[imgKey] || []).includes(key)) urls.add(imgKey); });
  return urls.size;
}
function visibleHGroupList() {
  return Array.from(H_GROUPS).filter((k) => !isHiddenHGroup(k)).sort((a, b) => a.localeCompare(b));
}
function addHGroup(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  const deleted = Array.from(H_DELETED_GROUP_KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  if (deleted) { showToast(`"${deleted}" was deleted — restore it from Manage > Hidden first`); return null; }
  const existing = Array.from(H_GROUPS).find((k) => k.toLowerCase() === name.toLowerCase());
  const key = existing || name;
  if (!existing) { H_GROUPS.add(key); persistHGroups(); }
  return key;
}
function renameHGroup(oldKey, rawNewName) {
  const newName = String(rawNewName || '').trim();
  if (!newName || newName === oldKey) return;
  H_GROUPS.delete(oldKey);
  const mergedInto = Array.from(H_GROUPS).find((k) => k.toLowerCase() === newName.toLowerCase());
  const finalKey = mergedInto || newName;
  if (!mergedInto) H_GROUPS.add(finalKey);
  persistHGroups();
  Object.keys(H_TAG_MAP).forEach((k) => {
    if (H_TAG_MAP[k].includes(oldKey)) {
      const tags = new Set(H_TAG_MAP[k].filter((t) => t !== oldKey));
      tags.add(finalKey);
      H_TAG_MAP[k] = Array.from(tags);
    }
  });
  persistHTagMap();
  if (H_GROUP_FILTER === oldKey) H_GROUP_FILTER = finalKey;
}
function deleteHGroup(key) {
  H_GROUPS.delete(key);
  persistHGroups();
  Object.keys(H_TAG_MAP).forEach((k) => {
    if (H_TAG_MAP[k].includes(key)) H_TAG_MAP[k] = H_TAG_MAP[k].filter((t) => t !== key);
  });
  persistHTagMap();
  recordDeletedHGroup(key);
  if (H_GROUP_FILTER === key) H_GROUP_FILTER = null;
}
function getHTags(dataUrl) {
  return H_TAG_MAP[imageKey(dataUrl)] || [];
}
function toggleHTag(dataUrl, tag) {
  const key = imageKey(dataUrl);
  const tags = new Set(H_TAG_MAP[key] || []);
  if (tags.has(tag)) tags.delete(tag); else tags.add(tag);
  H_TAG_MAP[key] = Array.from(tags);
  persistHTagMap();
}
// Free-text caption/keywords per image, same idea as a reaction's `note`
// field (and searched the same way) — kept as a lookup map rather than a
// field on a record, since an H image can be either a standalone upload OR
// a live reference to an entry's photo, and only the map approach works for
// both uniformly (mirrors H_TAG_MAP for the same reason).
let H_NOTE_MAP = {};
function persistHNoteMap() {
  idbPut(STORE_META, { key: 'hNoteMap', value: H_NOTE_MAP });
  pushMetaField('hNoteMap', H_NOTE_MAP);
}
function getHNote(dataUrl) {
  return H_NOTE_MAP[imageKey(dataUrl)] || '';
}
function setHNote(dataUrl, note) {
  H_NOTE_MAP[imageKey(dataUrl)] = note;
  persistHNoteMap();
}
// Same tag-style row layout as renderSharedGroupManagerModal (Images/
// Reactions) — count, hide toggle, merge, rename, delete — just backed by
// H's own separate H_GROUPS/H_TAG_MAP instead of the shared set.
function renderHGroupManagerModal() {
  const allNames = Array.from(H_GROUPS).sort((a, b) => a.localeCompare(b));
  const activeNames = allNames.filter((k) => !isHiddenHGroup(k));
  const hiddenActiveNames = allNames.filter((k) => H_HIDDEN_GROUP_KEYS.has(k) && !H_DELETED_GROUP_KEYS.has(k));
  const names = H_GROUP_MGR_TAB === 'active' ? activeNames : hiddenActiveNames;
  const rows = H_GROUP_MGR_TAB === 'active'
    ? names.map((name) => `
        <div class="tagmgr-row">
          <div class="tagmgr-click-area" style="cursor:default;">
            <div class="tagmgr-name">${escapeHtml(name)}</div>
            <div class="tagmgr-count">${hGroupUsageCount(name)} item${hGroupUsageCount(name) === 1 ? '' : 's'}</div>
          </div>
          <div class="tagmgr-actions">
            <button class="toggle-switch on" data-hgroupmgr-hide="${escapeHtml(name)}" title="Hide from filters (keeps the data)" role="switch" aria-checked="true"><span class="toggle-knob"></span></button>
            <button class="icon-btn-inline" data-hgroupmgr-merge="${escapeHtml(name)}" title="Merge into another group">🔀</button>
            <button class="icon-btn-inline" data-hgroupmgr-rename="${escapeHtml(name)}" title="Rename this group everywhere">✏️</button>
            <button class="icon-btn-inline" data-hgroupmgr-delete="${escapeHtml(name)}" title="Delete this group everywhere">🗑️</button>
          </div>
        </div>`).join('')
    : names.map((name) => `
        <div class="tagmgr-row">
          <div class="tagmgr-click-area" style="cursor:default;">
            <div class="tagmgr-name">${escapeHtml(name)}</div>
            <div class="tagmgr-count">${hGroupUsageCount(name)} item${hGroupUsageCount(name) === 1 ? '' : 's'}</div>
          </div>
          <div class="tagmgr-actions">
            <button class="toggle-switch" data-hgroupmgr-hide="${escapeHtml(name)}" title="Show in filters again" role="switch" aria-checked="false"><span class="toggle-knob"></span></button>
          </div>
        </div>`).join('');
  const deletedRows = H_GROUP_MGR_TAB === 'hidden' && H_DELETED_GROUP_KEYS.size ? `
    <div class="panel-title" style="margin:16px 0 8px;">Permanently deleted</div>
    <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">These had their tag removed from every image — restoring just allows the name to be used again; old images won't get it back.</div>
    ${Array.from(H_DELETED_GROUP_KEYS).sort().map((key) => `
      <div class="tagmgr-row">
        <div class="tagmgr-name" style="flex:1;">${escapeHtml(key)}</div>
        <button class="ref-btn" data-restore-h-group="${escapeHtml(key)}">Allow again</button>
      </div>`).join('')}
  ` : '';
  const tabsHtml = `
    <div class="tagmgr-tabs" style="margin-bottom:8px;">
      <button class="tagmgr-tab ${H_GROUP_MGR_TAB === 'active' ? 'active' : ''}" data-hgroupmgr-tab="active">Active (${activeNames.length})</button>
      <button class="tagmgr-tab ${H_GROUP_MGR_TAB === 'hidden' ? 'active' : ''}" data-hgroupmgr-tab="hidden">Hidden (${hiddenActiveNames.length + H_DELETED_GROUP_KEYS.size})</button>
    </div>`;
  openModal(`
    <h3>Manage groups</h3>
    <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">NSFW's own groups — kept separate from Images/Reactions. Hiding keeps a group's tags intact but off the chip rows; deleting removes it everywhere.</div>
    ${tabsHtml}
    <div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;">
      ${rows || `<div class="empty-state">${H_GROUP_MGR_TAB === 'hidden' ? 'No hidden groups.' : 'No groups yet.'}</div>`}
    </div>
    ${deletedRows}
    <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Done</button></div>
  `);
}
function openManageHGroupsModal() {
  renderHGroupManagerModal();
}

// Flags/unflags an existing entry-sourced image into H without duplicating
// its data anywhere — see H_IMAGE_KEYS and the allAppImages() filter above.
function persistHImageKeys() {
  idbPut(STORE_META, { key: 'hImageKeys', value: Array.from(H_IMAGE_KEYS) });
  pushMetaField('hImageKeys', Array.from(H_IMAGE_KEYS));
}
function pullImageIntoH(dataUrl) {
  H_IMAGE_KEYS.add(imageKey(dataUrl));
  persistHImageKeys();
}
// Removing an image from H means different things depending on where it
// came from: a standalone upload has no other home, so it's deleted outright;
// an entry-sourced image just gets un-flagged (the entry keeps its photo,
// it's just no longer hidden from the Images tab).
async function removeFromH(dataUrl) {
  const upload = ALL_H_IMAGES.find((h) => h.dataUrl === dataUrl);
  if (upload) {
    await deleteHImage(upload.id);
  } else {
    H_IMAGE_KEYS.delete(imageKey(dataUrl));
    persistHImageKeys();
  }
}

// H-flagged entry-sourced images UNION standalone H uploads, in a shape
// compatible with the same masonry-item rendering used by the Images tab.
function allHImages() {
  const map = new Map();
  ALL_ENTRIES.forEach((e) => {
    if (e.semi && e.semi.photo && H_IMAGE_KEYS.has(imageKey(e.semi.photo))) {
      map.set(e.semi.photo, { dataUrl: e.semi.photo, source: 'entry', createdAt: e.updatedAt || e.createdAt });
    }
    if (e.uke && e.uke.photo && H_IMAGE_KEYS.has(imageKey(e.uke.photo))) {
      map.set(e.uke.photo, { dataUrl: e.uke.photo, source: 'entry', createdAt: e.updatedAt || e.createdAt });
    }
    (e.screencaps || []).forEach((src) => {
      if (H_IMAGE_KEYS.has(imageKey(src))) {
        map.set(src, { dataUrl: src, source: 'entry', createdAt: e.updatedAt || e.createdAt });
      }
    });
  });
  const entryItems = Array.from(map.values());
  const uploadItems = ALL_H_IMAGES.map((h) => ({ dataUrl: h.dataUrl, source: 'upload', id: h.id, createdAt: h.createdAt }));
  return [...entryItems, ...uploadItems].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

let H_GROUP_FILTER = null;
// Same shape/behavior as MEME_STATE, so the H gallery's search/untagged
// filtering works exactly like the Reactions gallery's.
let H_STATE = { search: '', untaggedOnly: false };
let H_SELECT_MODE = false;
let H_SELECTED = new Set();
// Same purpose as IMAGES_NAV_LIST/MEME_NAV_LIST above, for the NSFW grid —
// updated on every hMainBody() call.
let H_NAV_LIST = [];
// Same purpose as IMAGES_FILTERS_COLLAPSED above, for the NSFW group chip row.
let H_FILTERS_COLLAPSED = false;

function hFilteredItems() {
  const q = H_STATE.search.trim().toLowerCase();
  // Uploads still waiting on a Drive download (see hydrateMissingHImages())
  // have no dataUrl locally yet — there's no image to show and no way to
  // know their real tag status until they hydrate, so they'd otherwise all
  // collapse into imageKey('') and get miscounted as "untagged" together.
  // Drop them here rather than let them pollute the count/filter/gallery
  // with broken tiles; they'll reappear on their own once hydrated.
  let items = allHImages().filter((i) => i.dataUrl).slice().sort((a, b) => {
    const aUntagged = !getHTags(a.dataUrl).length;
    const bUntagged = !getHTags(b.dataUrl).length;
    if (aUntagged !== bUntagged) return aUntagged ? -1 : 1;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
  if (H_GROUP_FILTER) items = items.filter((i) => getHTags(i.dataUrl).includes(H_GROUP_FILTER));
  if (H_STATE.untaggedOnly) items = items.filter((i) => !getHTags(i.dataUrl).length);
  if (q) items = items.filter((i) => getHNote(i.dataUrl).toLowerCase().includes(q));
  return items;
}

// `forceDel` mirrors the Images/Reactions masonryItem — only passed true
// from the Possible Duplicates tab, where tapping the whole card deletes it
// (see attachHGridHandlers' data-h-item handler) and this big centered ✕ is
// just the visual cue, same pattern as the other two galleries now use.
function hMasonryItem(img, forceDel) {
  return `
    <div class="masonry-item ${H_SELECT_MODE ? 'selectable' : ''} ${H_SELECTED.has(img.dataUrl) ? 'selected' : ''}" data-h-item="${escapeHtml(img.dataUrl)}">
      ${isVideoUrl(img.dataUrl) ? `<video src="${img.dataUrl}" autoplay loop muted playsinline></video>` : `<img src="${img.dataUrl}" alt="" loading="lazy">`}
      ${H_SELECT_MODE ? `<span class="select-check">${H_SELECTED.has(img.dataUrl) ? '✅' : '⬜'}</span>` : (forceDel ? `<span class="dup-del-hint" title="Tap to delete">✕</span>` : (!getHTags(img.dataUrl).length ? `<span class="untagged-badge">Untagged</span>` : ''))}
    </div>`;
}

// Possible-Duplicates for H — same perceptual-hash approach as the
// Reactions/Images scanners, just scoped to allHImages().
let H_DUP_GROUPS = null;
let H_DUP_SCANNING = false;
let H_SHOWING_DUPLICATES = false;
function hDupSignature(group) {
  return group.map((i) => i.id || i.dataUrl).sort().join('|');
}
function persistIgnoredHDupGroups() {
  idbPut(STORE_META, { key: 'ignoredHDupGroups', value: Array.from(IGNORED_H_DUP_GROUPS) });
  pushMetaField('ignoredHDupGroups', Array.from(IGNORED_H_DUP_GROUPS));
}
function dismissHDupGroup(idx) {
  if (!H_DUP_GROUPS || !H_DUP_GROUPS[idx]) return;
  IGNORED_H_DUP_GROUPS.add(hDupSignature(H_DUP_GROUPS[idx]));
  persistIgnoredHDupGroups();
  H_DUP_GROUPS = H_DUP_GROUPS.filter((_, i) => i !== idx);
  render();
}
function resetDismissedHDupGroups() {
  if (!IGNORED_H_DUP_GROUPS.size) return;
  if (!confirm(`Forget ${IGNORED_H_DUP_GROUPS.size} dismissed duplicate pair(s)? They'll be re-checked (and may reappear) the next time you scan.`)) return;
  IGNORED_H_DUP_GROUPS = new Set();
  persistIgnoredHDupGroups();
  showToast('Dismissed duplicates forgotten — scan again to re-check them.');
  render();
}
async function scanForHDuplicates() {
  H_DUP_SCANNING = true;
  render();
  const items = allHImages().filter((i) => i.dataUrl);
  // Same carry-forward as Images/Reactions (see scanForImageDuplicates) — a
  // group of 3+ can be held together by one "hub" image that's close to
  // both of the others without those two being close to each other, so
  // deleting the hub used to make a fresh rescan silently drop the pair.
  const validKeys = new Set(items.map((i) => i.id || i.dataUrl));
  const carriedGroups = (H_DUP_GROUPS || [])
    .map((g) => g.filter((i) => (i.id || i.dataUrl) && validKeys.has(i.id || i.dataUrl)))
    .filter((g) => g.length > 1);
  const withHashes = [];
  for (const i of items) {
    const hash = await perceptualHash(i.dataUrl);
    withHashes.push({ i, hash });
  }
  const groups = [];
  const clusters = clusterByHammingDistance(withHashes.map((x) => x.hash), 6);
  for (const idxs of clusters) {
    const group = idxs.map((idx) => withHashes[idx].i);
    if (!IGNORED_H_DUP_GROUPS.has(hDupSignature(group))) groups.push(group);
  }
  const coveredSets = groups.map((g) => new Set(g.map((i) => i.id || i.dataUrl)));
  carriedGroups.forEach((cg) => {
    if (IGNORED_H_DUP_GROUPS.has(hDupSignature(cg))) return;
    const keys = cg.map((i) => i.id || i.dataUrl);
    if (!coveredSets.some((s) => keys.every((k) => s.has(k)))) groups.push(cg);
  });
  H_DUP_GROUPS = groups;
  H_DUP_SCANNING = false;
  render();
}

function hMainBody() {
  if (H_SHOWING_DUPLICATES) {
    H_NAV_LIST = []; // no coherent "browse order" while comparing duplicate groups
    if (H_DUP_SCANNING) return `<div class="empty-state">Scanning ${allHImages().length} H images for duplicates…</div>`;
    const resetDismissedHLink = IGNORED_H_DUP_GROUPS.size
      ? `<button class="ref-btn" style="width:100%;margin-bottom:10px;font-size:11.5px;color:var(--text-dim);" data-reset-dismissed-h-dups="1">🔄 Forget ${IGNORED_H_DUP_GROUPS.size} dismissed pair${IGNORED_H_DUP_GROUPS.size === 1 ? '' : 's'} (re-check them on next scan)</button>`
      : '';
    if (H_DUP_GROUPS === null) return `<div style="padding:8px 0;"><button class="btn-primary" style="width:100%;margin-bottom:8px;" data-scan-h-duplicates="1">🔍 Scan for possible duplicates</button>${resetDismissedHLink}</div>`;
    if (!H_DUP_GROUPS.length) return `<div class="empty-state">No possible duplicates found. 🎉</div><button class="ref-btn" style="width:100%;margin-bottom:8px;" data-scan-h-duplicates="1">Scan again</button>${resetDismissedHLink}`;
    return `<button class="ref-btn" style="width:100%;margin-bottom:10px;" data-scan-h-duplicates="1">Scan again</button>` + resetDismissedHLink +
      H_DUP_GROUPS.map((group, idx) => `
        <div class="panel">
          <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span>Possible duplicate (${group.length} images)</span>
            <button class="ref-btn" style="flex:0 0 auto;padding:4px 10px;font-size:12px;" data-dismiss-h-dup-group="${idx}">Not duplicates</button>
          </div>
          <div class="image-masonry">${group.map((img) => hMasonryItem(img, true)).join('')}</div>
        </div>`).join('');
  }
  const items = hFilteredItems();
  H_NAV_LIST = items.map((img) => img.dataUrl);
  return items.length
    ? `<div class="image-masonry">${items.map((img) => hMasonryItem(img)).join('')}</div>`
    : `<div class="empty-state">${H_GROUP_FILTER || H_STATE.search || H_STATE.untaggedOnly ? 'No NSFW images match. Try clearing the filter/search.' : 'No NSFW images yet. Pull some in from Images or Reactions (open one → 🔴 Pull into NSFW), or upload directly above.'}</div>`;
}

function renderHLibraryInPlace() {
  const main = document.querySelector('#view-root main');
  if (main) main.innerHTML = hMainBody();
  attachHGridHandlers();
}

function renderHLibrary() {
  // Excludes uploads still waiting on a Drive download (no dataUrl yet) —
  // see hFilteredItems() for why those can't be counted as untagged.
  const untaggedCount = allHImages().filter((i) => i.dataUrl && !getHTags(i.dataUrl).length).length;
  const groupList = visibleHGroupList();
  // No 🏷️ prefix here, same as the Reactions mood-chip row — matches how
  // she wanted the top controls of H to read like the Reactions tab's.
  const groupChips = groupList.map((name) => `<button class="mood-chip ${H_GROUP_FILTER === name ? 'active' : ''}" data-h-group-filter="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('');
  return `
    <div class="app-header">
      <div class="brand-row"><h1>💦 NSFW</h1></div>
      <div style="color:var(--text-dim);font-size:12px;margin:0 0 10px;">${allHImages().length} image${allHImages().length === 1 ? '' : 's'} saved${untaggedCount ? ` · ${untaggedCount} untagged` : ''} — kept separate from the rest of the app.</div>
      <div class="export-row" style="margin-bottom:10px;">
        <label class="upload-btn" style="flex:1;">📎 Add image(s)<input type="file" accept="image/*,video/*" multiple id="h-upload-input"></label>
        <button class="ref-btn" data-h-toggle-select="1">${H_SELECT_MODE ? '✕ Cancel select' : '☑️ Select'}</button>
      </div>
      ${H_SELECT_MODE ? `
        <div class="export-row" style="margin-bottom:10px;background:var(--card);border:1px solid var(--purple);border-radius:var(--radius-sm);padding:8px;">
          <div style="flex:1;font-size:12.5px;color:var(--text-dim);align-self:center;">${H_SELECTED.size} selected</div>
          <button class="ref-btn" data-h-tag-selected="1" ${H_SELECTED.size ? '' : 'disabled'}>🏷️ Add to group…</button>
          <button class="btn-ghost" data-h-delete-selected="1" ${H_SELECTED.size ? '' : 'disabled'}>🗑️ Delete selected</button>
        </div>
      ` : ''}
      <div class="tagmgr-tabs" style="margin-bottom:8px;">
        <button class="tagmgr-tab ${!H_SHOWING_DUPLICATES ? 'active' : ''}" data-h-tab="grid">Gallery</button>
        <button class="tagmgr-tab ${H_SHOWING_DUPLICATES ? 'active' : ''}" data-h-tab="duplicates">Possible Duplicates${H_DUP_GROUPS !== null ? ` (${H_DUP_GROUPS.length})` : ''}</button>
        <button class="ref-btn ${H_STATE.untaggedOnly ? 'active' : ''}" style="flex:0 0 auto;padding:8px 12px;white-space:nowrap;${H_STATE.untaggedOnly ? 'background:var(--purple);color:#fff;' : ''}" data-h-untagged-only="1" title="Show only untagged H images">${untaggedCount} untagged</button>
        <button class="ref-btn" style="flex:0 0 auto;padding:8px 12px;white-space:nowrap;" data-h-manage-groups="1" title="Manage H groups (rename/delete)">✏️ Manage</button>
      </div>
      ${!H_SHOWING_DUPLICATES ? `
        <button class="filters-toggle-btn" data-h-toggle-filters="1">${H_FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters'}</button>
        <div class="filters-collapsible ${H_FILTERS_COLLAPSED ? 'collapsed' : ''}" id="h-filters-collapsible">
          <div class="group-chip-row">
            ${groupChips}
            <button class="mood-chip" data-h-add-group="1">➕ New group</button>
          </div>
        </div>
      ` : ''}
    </div>
    <main class="gallery-dropzone">${hMainBody()}</main>
    ${renderBottomNav('h')}
  `;
}

// Bulk group tagging for multi-selected NSFW images — same gap Images
// already had closed, now closed for NSFW too. Always adds, never toggles
// off (see tagImagesWithGroup/tagMemesWithMood for the same reasoning).
function tagHImagesWithGroup(dataUrls, tag) {
  dataUrls.forEach((dataUrl) => {
    const key = imageKey(dataUrl);
    const tags = new Set(H_TAG_MAP[key] || []);
    tags.add(tag);
    H_TAG_MAP[key] = Array.from(tags);
  });
  persistHTagMap();
}
function openTagSelectedHModal(dataUrls) {
  const groupList = visibleHGroupList();
  openModal(`
    <h3>Add ${dataUrls.length} image${dataUrls.length === 1 ? '' : 's'} to a group…</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
      ${groupList.map((name) => `<button class="mood-chip" data-tag-selected-h-with="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('')}
      <button class="mood-chip" data-tag-selected-h-new-group="1">➕ New group</button>
    </div>
    <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Cancel</button></div>
  `);
  document.querySelectorAll('[data-tag-selected-h-with]').forEach((el) => {
    el.onclick = () => {
      const tag = el.getAttribute('data-tag-selected-h-with');
      tagHImagesWithGroup(dataUrls, tag);
      closeModal();
      H_SELECT_MODE = false;
      H_SELECTED = new Set();
      showToast(`Added ${dataUrls.length} image${dataUrls.length === 1 ? '' : 's'} to "${tag}"`);
      render();
    };
  });
  const newGroupBtn = document.querySelector('[data-tag-selected-h-new-group]');
  if (newGroupBtn) newGroupBtn.onclick = () => {
    const key = addHGroup(prompt('Name this new group:'));
    if (!key) return;
    tagHImagesWithGroup(dataUrls, key);
    closeModal();
    H_SELECT_MODE = false;
    H_SELECTED = new Set();
    showToast(`Added ${dataUrls.length} image${dataUrls.length === 1 ? '' : 's'} to "${key}"`);
    render();
  };
}

async function openHImageModal(dataUrl) {
  const upload = ALL_H_IMAGES.find((h) => h.dataUrl === dataUrl);
  const groupList = visibleHGroupList();
  const currentTags = getHTags(dataUrl);
  const entries = upload ? [] : ALL_ENTRIES.filter((e) => entryImageUrls(e).includes(dataUrl));
  const inReactions = await isDataUrlInReactions(dataUrl);
  const croppable = isCroppableDataUrl(dataUrl);
  const { prev, next } = mediaModalNavNeighbors(H_NAV_LIST, dataUrl);
  openModal(`
    <div class="modal-close-corner-wrap">
      <button class="modal-close-x" data-close-modal="1" title="Close">✕</button>
      <h3>💦 NSFW image</h3>
      <div class="modal-media-nav" id="modal-media-nav" style="margin-bottom:10px;">
        ${mediaModalNavArrowsHtml('h', prev, next)}
        ${dataUrl
          ? (isVideoUrl(dataUrl)
              ? `<video src="${dataUrl}" autoplay loop muted controls playsinline style="width:100%;max-height:60vh;object-fit:contain;border-radius:10px;background:#000;"></video>`
              : `<img src="${dataUrl}" alt="" style="width:100%;max-height:60vh;object-fit:contain;border-radius:10px;background:#000;">`)
          : `<div class="cover-placeholder" style="height:180px;">⏳ Still downloading from Drive…</div>`}
      </div>
      ${entries.length ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">Pulled from: ${entries.map((e) => escapeHtml(e.title)).join(', ')}</div>` : ''}
      <div class="field-row">
        <label>Groups</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
          ${groupList.map((name) => `<button class="mood-chip ${currentTags.includes(name) ? 'active' : ''}" data-toggle-h-tag="${escapeHtml(name)}" data-h-url="${escapeHtml(dataUrl)}">${escapeHtml(name)}</button>`).join('')}
          <button class="mood-chip" data-h-add-group-for="${escapeHtml(dataUrl)}">➕ New group</button>
        </div>
      </div>
      <div class="field-row">
        <label>Also in</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
          ${mediaToggleButtonsHtml(dataUrl, inReactions, true, false, { type: 'h', id: dataUrl })}
        </div>
        ${upload ? `<div style="font-size:11px;color:var(--text-dim);margin-top:6px;">Deleting removes this image entirely — it has no entry or other library to fall back to.</div>` : `<div style="font-size:11px;color:var(--text-dim);margin-top:6px;">Deleting removes it from H only — the entry it came from keeps its photo.</div>`}
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" data-delete-h-image="${escapeHtml(dataUrl)}">🗑️ Delete</button>
        ${croppable ? `<button class="btn-ghost" data-crop-h="${escapeHtml(dataUrl)}">✂️ Crop</button>` : ''}
        ${dataUrl ? `<button class="btn-ghost" data-save-image="${escapeHtml(dataUrl)}">⬇️ Save</button>` : ''}
        <button class="btn-primary" data-close-modal="1">Done</button>
      </div>
    </div>
  `, { centered: true });
  wireModalSwipeNav(prev ? () => openHImageModal(prev) : null, next ? () => openHImageModal(next) : null);
}

function attachHGridHandlers() {
  document.querySelectorAll('[data-h-item]').forEach((el) => {
    el.onclick = async () => {
      const url = el.getAttribute('data-h-item');
      if (H_SELECT_MODE) {
        if (H_SELECTED.has(url)) H_SELECTED.delete(url); else H_SELECTED.add(url);
        render();
      } else if (H_SHOWING_DUPLICATES) {
        // Same fast tap-to-delete triage flow as Images/Reactions duplicates.
        if (!confirm('Delete this image?')) return;
        const hDupGroup = (H_DUP_GROUPS || []).find((g) => g.some((i) => i.dataUrl === url));
        if (hDupGroup) {
          const survivorHUrls = hDupGroup.filter((i) => i.dataUrl !== url).map((i) => i.dataUrl);
          await transferDuplicateTagsOnDelete(url, survivorHUrls);
          await transferEntryAttachmentOnDuplicateDelete(url, survivorHUrls);
        }
        await removeFromH(url);
        if (H_DUP_GROUPS) {
          H_DUP_GROUPS = H_DUP_GROUPS
            .map((g) => g.filter((i) => i.dataUrl !== url))
            .filter((g) => g.length > 1);
        }
        showToast('Deleted');
        render();
      } else {
        openHImageModal(url);
      }
    };
  });
  document.querySelectorAll('[data-h-tab]').forEach((el) => {
    el.onclick = () => { H_SHOWING_DUPLICATES = el.getAttribute('data-h-tab') === 'duplicates'; render(); };
  });
  const toggleHSelectBtn = document.querySelector('[data-h-toggle-select]');
  if (toggleHSelectBtn) toggleHSelectBtn.onclick = () => { H_SELECT_MODE = !H_SELECT_MODE; H_SELECTED = new Set(); render(); };
  const hFiltersToggleBtn = document.querySelector('[data-h-toggle-filters]');
  if (hFiltersToggleBtn) hFiltersToggleBtn.onclick = () => {
    H_FILTERS_COLLAPSED = !H_FILTERS_COLLAPSED;
    const el = document.getElementById('h-filters-collapsible');
    if (el) el.classList.toggle('collapsed', H_FILTERS_COLLAPSED);
    hFiltersToggleBtn.textContent = H_FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters';
  };
  const tagSelectedHBtn = document.querySelector('[data-h-tag-selected]');
  if (tagSelectedHBtn) tagSelectedHBtn.onclick = () => {
    if (H_SELECTED.size) openTagSelectedHModal(Array.from(H_SELECTED));
  };
  const deleteSelectedHBtn = document.querySelector('[data-h-delete-selected]');
  if (deleteSelectedHBtn) deleteSelectedHBtn.onclick = async () => {
    const urls = Array.from(H_SELECTED);
    if (!urls.length) return;
    if (!confirm(`Delete ${urls.length} image${urls.length === 1 ? '' : 's'}? This can't be undone.`)) return;
    for (const url of urls) await removeFromH(url);
    if (H_DUP_GROUPS) {
      H_DUP_GROUPS = H_DUP_GROUPS
        .map((g) => g.filter((i) => !urls.includes(i.dataUrl)))
        .filter((g) => g.length > 1);
    }
    H_SELECT_MODE = false;
    H_SELECTED = new Set();
    showToast('Deleted');
    render();
  };
  const scanHDupBtn = document.querySelector('[data-scan-h-duplicates]');
  if (scanHDupBtn) scanHDupBtn.onclick = () => scanForHDuplicates();
  const resetDismissedHDupsBtn = document.querySelector('[data-reset-dismissed-h-dups]');
  if (resetDismissedHDupsBtn) resetDismissedHDupsBtn.onclick = () => resetDismissedHDupGroups();
  document.querySelectorAll('[data-dismiss-h-dup-group]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); dismissHDupGroup(Number(el.getAttribute('data-dismiss-h-dup-group'))); };
  });
  document.querySelectorAll('[data-h-group-filter]').forEach((el) => {
    el.onclick = () => { const g = el.getAttribute('data-h-group-filter'); H_GROUP_FILTER = H_GROUP_FILTER === g ? null : g; render(); };
  });
  const addGroupBtn = document.querySelector('[data-h-add-group]');
  if (addGroupBtn) addGroupBtn.onclick = () => {
    const key = addHGroup(prompt('Name this new H group:'));
    if (key) { H_GROUP_FILTER = key; render(); }
  };
  const manageGroupsBtn = document.querySelector('[data-h-manage-groups]');
  if (manageGroupsBtn) manageGroupsBtn.onclick = openManageHGroupsModal;
  const untaggedOnlyBtn = document.querySelector('[data-h-untagged-only]');
  if (untaggedOnlyBtn) untaggedOnlyBtn.onclick = () => { H_STATE.untaggedOnly = !H_STATE.untaggedOnly; render(); };
  // Note: [data-delete-h-image] is deliberately NOT wired here — it only
  // ever exists inside the individual-item modal (openHImageModal), which
  // is injected into #modal-sheet well after this function last ran (it's
  // only called on a full grid render/attach, not every time a modal opens).
  // Binding it here meant the button rendered with no click handler at all,
  // so Delete silently did nothing. It's wired via the global document click
  // delegation instead (see [data-delete-h-image] below), same as every
  // other modal-only button (crop, tag toggles, etc).
  const uploadInput = document.querySelector('#h-upload-input');
  if (uploadInput) uploadInput.onchange = async () => {
    if (!uploadInput.files.length) return;
    await addHImageFiles(uploadInput.files);
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
  if (sm.coverUrl && !e.coverIsUserUploaded) e.coverUrl = sm.coverUrl;
  if (sm.url) { e.referenceUrl = sm.url; e.referenceSite = sm.site || 'Anime-Planet'; e.referenceStatus = 'confirmed'; }
  if (sm.summary) e.summaryCache = sm.summary;
  if (sm.tags && sm.tags.length) {
    const merged = new Set([...(e.tags || []), ...sanitizeIncomingTags(sm.tags)]);
    e.tags = Array.from(merged);
  }
  if (!e.author && sm.author) e.author = sm.author;
  if (!e.artist && sm.artist) e.artist = sm.artist;
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

  // Computed up here (rather than after topFieldsHtml, where it used to
  // live) so the display-mode branch below can drop it directly under the
  // Status pill instead of under the cover thumbnail — per her mockup, the
  // "Currently Read" shelf picker belongs next to Status, not the cover.
  // Used to only render for reading (manhwa/manga) entries — now shared with
  // watching (anime/tv) entries too, just relabeled "Viewing Status" there
  // (see topFieldsHtml below); the underlying shelf options are the same.
  const shelfSelect = `
    <select class="shelf-select status-pill-select" data-shelf-select="1">
      ${SHELVES_READING.map((s) => `<option value="${escapeHtml(s)}" ${e.shelf === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
    </select>`;

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
      <div class="field-row"><label>Story Status</label>
        <select id="edit-status">
          <option value="" ${!e.status ? 'selected' : ''}>—</option>
          <option value="WIP" ${e.status === 'WIP' ? 'selected' : ''}>WIP</option>
          <option value="Finished" ${e.status === 'Finished' ? 'selected' : ''}>Finished</option>
        </select>
      </div>
      <div class="modal-actions" style="margin-top:6px;">
        <button class="btn-ghost" data-cancel-edit="1">Cancel</button>
        <button class="btn-primary" data-save-edit="1">Save</button>
      </div>
    ` : `
      <div class="field-row"><label>Title</label><input type="text" id="edit-title" value="${escapeHtml(e.title)}"></div>
      <div class="field-row"><label>Alt title</label><input type="text" id="edit-altTitle" placeholder="Other names this goes by..." value="${escapeHtml(e.altTitle || '')}"></div>
      <div class="field-row"><label>Total Episodes</label><input type="number" id="edit-chapters" value="${e.totalChapters || ''}"></div>
      <div class="field-row"><label>Story Status</label>
        <select id="edit-status">
          <option value="" ${!e.status ? 'selected' : ''}>—</option>
          <option value="WIP" ${e.status === 'WIP' ? 'selected' : ''}>WIP</option>
          <option value="Finished" ${e.status === 'Finished' ? 'selected' : ''}>Finished</option>
        </select>
      </div>
      <div class="modal-actions" style="margin-top:6px;">
        <button class="btn-ghost" data-cancel-edit="1">Cancel</button>
        <button class="btn-primary" data-save-edit="1">Save</button>
      </div>
    `;
  } else {
    topFieldsHtml = isReading ? `
      <div class="field-row-2col">
        <div class="field-row"><label>Title</label><div class="value plain">${escapeHtml(e.title)}</div></div>
        <div class="field-row"><label>Alt title</label><div class="value plain">${escapeHtml(e.altTitle) || '—'}</div></div>
      </div>
      ${(e.isNovel || e.novelAuthor) ? `<div class="field-row"><label>Novel</label><div class="value plain">${escapeHtml(formatNames(e.novelAuthor)) || '—'}</div></div>` : ''}
      <div class="field-row-2col">
        <div class="field-row"><label>Author</label><div class="value plain">${escapeHtml(formatNames(e.author)) || '—'}</div></div>
        <div class="field-row"><label>Artist</label><div class="value plain">${escapeHtml(formatNames(e.artist)) || '—'}</div></div>
      </div>
      <div class="details-divider"></div>
      <div class="field-row-2col wide-gap">
        <div>
          <div class="field-row"><label>Total Seasons</label><div class="value plain">${e.totalSeasons || '—'}</div></div>
          <div class="field-row" style="margin-bottom:0;"><label>Total Chapters</label><div class="value plain">${e.totalChapters || '—'}</div></div>
        </div>
        <div class="field-row" style="margin-bottom:0;">
          <label class="status-pill-label">Story Status</label>
          <select class="shelf-select status-pill-select" data-status-select="1">
            <option value="" ${!e.status ? 'selected' : ''}>—</option>
            <option value="WIP" ${e.status === 'WIP' ? 'selected' : ''}>WIP</option>
            <option value="Finished" ${e.status === 'Finished' ? 'selected' : ''}>Finished</option>
          </select>
          <div style="margin-top:8px;"><label class="status-pill-label">Reading Status</label>${shelfSelect}</div>
        </div>
      </div>
    ` : `
      <div class="field-row-2col">
        <div class="field-row"><label>Title</label><div class="value plain">${escapeHtml(e.title)}</div></div>
        <div class="field-row"><label>Alt title</label><div class="value plain">${escapeHtml(e.altTitle) || '—'}</div></div>
      </div>
      <div class="details-divider"></div>
      <div class="field-row-2col wide-gap">
        <div>
          <div class="field-row" style="margin-bottom:0;"><label>Total Episodes</label><div class="value plain">${e.totalChapters || '—'}</div></div>
        </div>
        <div class="field-row" style="margin-bottom:0;">
          <label class="status-pill-label">Story Status</label>
          <select class="shelf-select status-pill-select" data-status-select="1">
            <option value="" ${!e.status ? 'selected' : ''}>—</option>
            <option value="WIP" ${e.status === 'WIP' ? 'selected' : ''}>WIP</option>
            <option value="Finished" ${e.status === 'Finished' ? 'selected' : ''}>Finished</option>
          </select>
          <div style="margin-top:8px;"><label class="status-pill-label">Viewing Status</label>${shelfSelect}</div>
        </div>
      </div>
    `;
  }

  return `
    <div class="detail-header">
      <div class="detail-header-row">
        <button class="back-btn" data-nav-back="1">← Back</button>
        <h2>${escapeHtml(e.title)}</h2>
        <div class="icon-action">
          <button class="icon-btn save" data-force-save="1" title="Save now">✅</button>
          <span class="icon-label">Save</span>
        </div>
        <div class="icon-action">
          <button class="icon-btn" data-merge-entry="${e.id}" title="Mark as duplicate / merge into another entry">🔀</button>
          <span class="icon-label">Merge</span>
        </div>
        <div class="icon-action">
          <button class="icon-btn danger" data-delete-entry="${e.id}" title="Delete this entry">✕</button>
          <span class="icon-label">Delete</span>
        </div>
        <div class="icon-action">
          <button class="icon-btn ${e.favorite ? 'fav-active' : ''}" data-toggle-fav="1" title="Favorite">${e.favorite ? '💜' : '🤍'}</button>
          <span class="icon-label">Favorite</span>
        </div>
        ${!isSFW() ? `<div class="icon-action">
          <button class="icon-btn ${isHentai(e) ? 'hentai-active' : ''}" data-toggle-hentai="1" title="${isHentai(e) ? 'NSFW — tap to unmark' : 'Mark as NSFW'}">💦</button>
          <span class="icon-label">NSFW</span>
        </div>` : ''}
        <div class="icon-action">
          <button class="icon-btn ${isOnDrive(e) ? 'hd-active' : ''}" data-toggle-hd="1" title="${isOnDrive(e) ? 'On HD — tap to unmark' : 'Mark as On HD'}">💾</button>
          <span class="icon-label">On HD</span>
        </div>
      </div>
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
            <div class="cover-slot">${e.coverUrl ? `<img src="${escapeHtml(e.coverUrl)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='${themeIcon()}'">` : themeIcon()}</div>
            <div class="cover-actions-row">
              <label class="upload-btn small">📷 ${e.coverUrl ? 'Change' : 'Upload'}<input type="file" accept="image/*" style="display:none" id="cover-upload-input"></label>
            </div>
          </div>
          <div>
            ${topFieldsHtml}
          </div>
        </div>
        ${!DETAIL_EDIT_MODE ? `<div class="details-divider details-divider-full"></div>` : ''}
        ${confirmedSummaryHtml}
        ${matchColumnHtml}
      </div>

      <!-- 1b. Reading link -->
      <div class="panel">
        <div class="reading-link-row">
          <div class="field-row" style="flex:1;min-width:0;margin-bottom:0;">
            <label>${isReading ? 'Reading Link' : 'Viewing Link'}</label>
            ${e.readingLink
              ? `<a href="${escapeHtml(e.readingLink)}" target="_blank" rel="noopener noreferrer" class="reading-link-value">${escapeHtml(e.readingLink)}</a>`
              : `<input type="text" id="reading-link-input" placeholder="Paste the link where you're ${isReading ? 'reading' : 'viewing'} this...">`}
          </div>
          <div class="reading-chapter-col">
            <label>Current Chapter</label>
            <input type="text" class="chapter-pill-input" id="current-chapter-input" placeholder="—" value="${escapeHtml(e.currentChapter || '')}">
          </div>
          ${e.readingLink ? `<button class="icon-btn-inline reading-link-clear" data-clear-reading-link="1" title="Remove link">✕</button>` : ''}
        </div>
      </div>

      <!-- 2. Ratings -->
      <div class="panel">
        <div class="rating-grid">
          <div class="rating-block">
            <div class="label">Overall</div>
            <div class="rating-icons" data-rating="qualityRating">${renderRatingIcons(e.qualityRating, '❤️')}</div>
          </div>
          <div class="rating-block">
            <div class="label">${isSFW() ? 'Cute' : 'Smut'}</div>
            <div class="rating-icons" data-rating="smutRating">${renderRatingIcons(e.smutRating, themeIcon())}</div>
          </div>
          <div class="rating-block">
            <div class="label">Crying</div>
            <div class="rating-icons" data-rating="cryRating">${renderRatingIcons(e.cryRating, '😭')}</div>
          </div>
          <div class="rating-block">
            <div class="label">Laughing</div>
            <div class="rating-icons" data-rating="lolRating">${renderRatingIcons(e.lolRating, '😂')}</div>
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
            ${!isSFW() ? `<div class="flag-picker">${renderFlagPicker(e.semi.flag, 'semi')}</div>` : ''}
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
            ${!isSFW() ? `<div class="flag-picker">${renderFlagPicker(e.uke.flag, 'uke')}</div>` : ''}
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
        ${!isReading ? `<div class="field-row"><label>Notes (legacy)</label><input type="text" id="legacy-note-input" value="${escapeHtml(e.legacyNote || '')}"></div>` : ''}
        <textarea id="user-notes" placeholder="Your thoughts...">${escapeHtml(e.notes)}</textarea>
      </div>

      <!-- 7. Images (screencaps, character photos — always attached to this read) -->
      <div class="panel">
        <div class="panel-title">Images</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
          <label class="upload-btn" style="flex:1;">📎 Add photo(s)<input type="file" accept="image/*" multiple id="screencap-input"></label>
        </div>
        <div class="image-masonry screencap-dropzone" id="screencap-dropzone">
          ${(e.screencaps || []).map((src, i) => `<div class="masonry-item"><img src="${src}" data-view-screencap="${i}" loading="lazy"><button class="del" data-del-screencap="${i}">✕</button></div>`).join('')}
        </div>
        ${!(e.screencaps || []).length ? `<div class="empty-state" style="padding:16px 0;">No images yet — drag and drop, or tap "Add photo(s)".</div>` : ''}
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
  // Semi/Uke flag columns drop out entirely for SFW accounts (the feature
  // itself is hidden on the entry page, so there's never anything to show
  // here) — the Smut column becomes "SFW" per her back-end-wording call,
  // still backed by the same smutRating field either way.
  const cols = ['Title', 'Format', 'Shelf', 'Author', 'Tags', ...(isSFW() ? [] : ['Semi Flag', 'Uke Flag']), isSFW() ? 'SFW' : 'Smut', 'Quality', 'Favorite', 'Notes'];
  const trs = rows.map((e) => `
    <tr>
      <td>${escapeHtml(e.title)}</td>
      <td>${e.format}</td>
      <td>${escapeHtml(e.shelf)}</td>
      <td>${escapeHtml(formatNames(e.author))}</td>
      <td>${escapeHtml((e.tags || []).concat(e.customTags || []).filter((t) => !isHiddenTag(t)).join(', '))}</td>
      ${isSFW() ? '' : `<td>${(e.semi && e.semi.flag) || ''}</td><td>${(e.uke && e.uke.flag) || ''}</td>`}
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
    </div>
    <main>
      <div class="account-panel">
        <div class="account-info">
          <div class="account-label">Synced account</div>
          <div class="account-email">${escapeHtml(CURRENT_USER ? CURRENT_USER.email : '')}</div>
        </div>
        <button class="icon-btn-inline" data-sign-out="1" title="Sign out">Sign Out</button>
      </div>
      <div class="account-panel" style="flex-direction:column;align-items:stretch;gap:8px;margin-top:-6px;">
        <div class="account-label">Theme</div>
        ${THEME_MODE
          ? `<div style="font-size:14px;">${THEME_MODE === 'sfw' ? '💕 SFW' : '💦 NSFW'}</div>`
          : `<button class="ref-btn" data-open-theme-picker="1">🎨 Choose your theme (one-time)</button>`}
        ${isAdmin() ? `<button class="ref-btn" data-preview-theme-picker="1">🔍 Preview new-user theme screen</button>` : ''}
      </div>
      <div class="panel" style="margin-bottom:14px;">
        <div class="panel-title">Data Cleanup Tools</div>
        <div class="export-row">
          <button class="ref-btn" data-nav="review">🔎 Review missing cover/reference (${reviewCount})</button>
          <button class="ref-btn" data-nav="duplicates">🧬 Review duplicates (${dupCount})</button>
        </div>
        <p style="font-size:11px;color:var(--text-dim);margin:6px 0 0;">Entries missing a cover image or reference link, and possible duplicate titles — both flagged automatically as you add and cross-reference entries.</p>
        ${BULK_SWEEP.running ? `
          <div class="export-row" style="margin-top:8px;">
            <div style="flex:1;font-size:12.5px;color:var(--text-dim);">🔄 Checking ${BULK_SWEEP.checked}/${BULK_SWEEP.total} against Anime-Planet/MangaGo — ${BULK_SWEEP.found} found so far</div>
            <button class="ref-btn" data-stop-bulk-sweep="1">Stop</button>
          </div>
        ` : `
          <div class="export-row" style="margin-top:8px;">
            <button class="ref-btn" data-run-bulk-sweep="1">🚀 Run match sweep now (${bulkSweepCandidates().length} unmatched)</button>
          </div>
          <p style="font-size:11px;color:var(--text-dim);margin:6px 0 0;">Searches Anime-Planet/MangaGo for every unmatched entry in one pass instead of the usual 20-a-day auto-sweep — paced to be gentle on the proxy, so it can take a while for a big backlog. Requires a proxy URL below.</p>
        `}
        ${IMAGE_BACKFILL.running ? `
          <div class="export-row" style="margin-top:8px;">
            <div style="flex:1;font-size:12.5px;color:var(--text-dim);">☁️ Uploading ${IMAGE_BACKFILL.checked}/${IMAGE_BACKFILL.total} — ${IMAGE_BACKFILL.uploaded} sent to Drive so far</div>
            <button class="ref-btn" data-stop-image-backfill="1">Stop</button>
          </div>
        ` : `
          <div class="export-row" style="margin-top:8px;">
            <button class="ref-btn" data-run-image-backfill="1">☁️ Upload local-only images to Drive (${imageBackfillCandidates().length} pending)</button>
          </div>
          <p style="font-size:11px;color:var(--text-dim);margin:6px 0 0;">Images added before Drive was hooked up (or while it was disconnected) only ever saved on the device that added them. This pushes anything still local-only up to your Drive so other devices can finally pull it down. Requires Google Drive to be connected.</p>
        `}
      </div>
      ${(() => {
        const failedUploads = imageBackfillCandidates();
        if (!failedUploads.length) return '';
        return `
      <div class="panel" style="margin-bottom:14px;">
        <div class="panel-title">📤 Failed Uploads (${failedUploads.length})</div>
        <p style="font-size:11px;color:var(--text-dim);margin:0 0 8px;">These are only saved on this device — usually because the file was too large to back up to Google Drive/the cloud on the first try. Compress & Retry shrinks it down and tries again.</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          ${failedUploads.map(renderFailedUploadCard).join('')}
        </div>
      </div>
        `;
      })()}
      ${renderSettingsPanel()}
      <div class="export-row">
        <button class="ref-btn" data-export-csv="1">⬇ Export CSV</button>
        <span style="color:var(--text-dim);font-size:12.5px;align-self:center;">${rows.length} total entries</span>
      </div>
      <div class="search-bar" style="margin-bottom:10px;"><span>🔍</span><input type="search" id="db-search" placeholder="Filter table..."></div>
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

// Pulled out of the old ⚙️ gear-icon modal into its own always-visible panel
// in Database mode, per user request — it was easy to forget the gear icon
// existed at all, and this settings content (proxy URL, Get Info bookmarklet)
// is squarely a "data cleanup tools" adjacent concern anyway.
function renderSettingsPanel() {
  return `
    <div class="panel" style="margin-bottom:14px;">
      <div class="panel-title">⚙️ Settings</div>
      <div class="field-row">
        <label>Cross-reference proxy URL (your Apps Script web app URL)</label>
        <input type="text" id="proxy-url-input" value="${escapeHtml(getProxyUrl())}" placeholder="https://script.google.com/macros/s/.../exec">
      </div>
      <p style="font-size:11.5px;color:var(--text-dim);margin:0 0 12px;">This is only used when you tap "Cross-reference" on an entry — it fetches the Anime-Planet page server-side so the app can read the summary/cover. No reading data is ever sent out.</p>
      <div style="border-top:1px solid var(--border);padding-top:12px;">
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
    </div>
  `;
}

/* ---------------------------------------------------------------------- */
/* BULK SUGGESTED-MATCH REVIEW                                            */
/* ---------------------------------------------------------------------- */

function renderReviewCard(e) {
  const sm = e.suggestedMatch;
  const cover = (sm && sm.coverUrl)
    ? `<img src="${escapeHtml(sm.coverUrl)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>${themeIcon()}</div>'">`
    : `<div class="cover-placeholder">${themeIcon()}</div>`;
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
  const items = ALL_ENTRIES.filter(needsReview).sort((a, b) => a.title.localeCompare(b.title));
  const body = items.length
    ? items.map(renderReviewCard).join('')
    : `<div class="empty-state">Everything has a cover or reference link. 🎉</div>`;
  return `
    <div class="app-header">
      <div class="brand-row">
        <button class="back-btn" data-nav-back="1">← Back</button>
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
  target.lolRating = Math.max(target.lolRating || 0, source.lolRating || 0);
  target.cryRating = Math.max(target.cryRating || 0, source.cryRating || 0);
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
  navigate('detail', targetId);
}

// Merge triggered from inside a duplicate-group comparison (Database >
// Review Duplicates). Two differences from the generic mergeIntoTarget()
// above: no picker (the target is already known — it's the other item in
// the comparison), and it stays on the Review Duplicates list afterward
// instead of jumping to the surviving entry's detail page, since the whole
// point is to keep working through the rest of the list.
async function mergeDuplicateGroupItem(sourceId, targetId) {
  const source = getEntry(sourceId);
  const target = getEntry(targetId);
  if (!source || !target) return;
  if (!confirm(`Merge "${source.title}" into "${target.title}"? Its notes/ratings/tags/images are combined in, then "${source.title}" is deleted.`)) return;
  mergeEntryData(target, source);
  await saveEntry(target);
  await deleteEntry(sourceId);
  showToast('Merged and deleted');
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

// What actually differs between the entries in a possible-duplicate group —
// this is the piece that was missing before: seeing "Author" and "Shelf"
// tells you nothing about whether one copy has notes/ratings/tags the other
// doesn't, which is exactly the information you need before deciding whether
// to delete one outright or merge them instead.
function duplicateFieldDiffs(group) {
  const fields = [
    { label: 'Shelf', get: (e) => e.shelf || '—' },
    { label: 'Status', get: (e) => e.status || '—' },
    { label: 'Author', get: (e) => formatNames(e.author) || '—' },
    { label: isSFW() ? 'SFW' : 'Smut Level', get: (e) => String(e.smutRating || 0) },
    { label: 'Overall', get: (e) => String(e.qualityRating || 0) },
    { label: 'Favorite', get: (e) => (e.favorite ? 'Yes' : 'No') },
    { label: 'Tags', get: (e) => (e.tags || []).concat(e.customTags || []).filter((t) => !isHiddenTag(t)).join(', ') || '—' },
    // Semi/Uke flags are an SFW-hidden feature (see the detail page) — no
    // point surfacing them in a duplicate comparison for an account that
    // can never see or set them.
    ...(isSFW() ? [] : [
      { label: 'Semi flag', get: (e) => (e.semi && e.semi.flag) || '—' },
      { label: 'Uke flag', get: (e) => (e.uke && e.uke.flag) || '—' },
    ]),
    { label: 'Cover image', get: (e) => (e.coverUrl ? 'Yes' : 'No') },
    { label: 'Reference link', get: (e) => (e.referenceStatus === 'confirmed' ? (e.referenceSite || 'Linked') : 'Not linked') },
    { label: 'Notes', get: (e) => (e.notes || '').trim() || '—' },
  ];
  return fields
    .map((f) => ({ label: f.label, values: group.map((e) => f.get(e)) }))
    .filter((row) => new Set(row.values).size > 1);
}

function renderDuplicateGroup(group) {
  const items = group.map((e, i) => {
    const coverSrc = e.coverUrl || (e.suggestedMatch ? e.suggestedMatch.coverUrl : null);
    const cover = coverSrc
      ? `<img src="${escapeHtml(coverSrc)}" referrerpolicy="no-referrer" onerror="this.parentElement.innerHTML='<div class=\\'cover-placeholder\\'>${themeIcon()}</div>'">`
      : `<div class="cover-placeholder">${themeIcon()}</div>`;
    // Within a duplicate comparison there are only ever a couple of items
    // being looked at, so "Merge into" should just pull whichever other
    // item(s) are already in this same comparison — no need to reopen a
    // picker and search the whole library for the one you're staring at.
    const others = group.filter((x) => x.id !== e.id).map((x) => x.id).join(',');
    const mergeLabel = group.length === 2 ? `🔀 Merge into #${group.findIndex((x) => x.id !== e.id) + 1}` : '🔀 Merge into…';
    return `
      <div class="dup-item">
        <div class="cover-thumb" style="width:64px;flex:0 0 64px;">${cover}</div>
        <div class="review-card-info">
          <strong>#${i + 1} ${escapeHtml(e.title)}</strong>
          <div style="font-size:11px;color:var(--text-dim);">${escapeHtml(e.shelf)}${e.author ? ' · ' + escapeHtml(formatNames(e.author)) : ''}</div>
          <div style="font-size:11px;color:var(--text-dim);">Updated ${e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : '—'}${e.favorite ? ' · 💜 favorite' : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="ref-btn" data-open-entry="${e.id}">Open</button>
          <button class="ref-btn" data-merge-group-source="${e.id}" data-merge-group-targets="${others}" title="Merge this into the other item(s) in this comparison">${mergeLabel}</button>
          <button class="btn-ghost" data-dup-delete="${e.id}">Delete this one</button>
        </div>
      </div>`;
  }).join('');
  const diffs = duplicateFieldDiffs(group);
  const rowGridStyle = `display:grid;grid-template-columns:90px repeat(${group.length}, 1fr);gap:6px;`;
  const diffHtml = diffs.length ? `
    <div class="dup-diff-table">
      <div class="dup-diff-row dup-diff-head" style="${rowGridStyle}">
        <div></div>${group.map((e, i) => `<div>#${i + 1}</div>`).join('')}
      </div>
      ${diffs.map((row) => `
        <div class="dup-diff-row" style="${rowGridStyle}">
          <div class="dup-diff-label">${escapeHtml(row.label)}</div>
          ${row.values.map((v) => `<div>${escapeHtml(v.length > 140 ? v.slice(0, 140) + '…' : v)}</div>`).join('')}
        </div>`).join('')}
    </div>
  ` : `<div style="font-size:11.5px;color:var(--text-dim);margin:0 0 10px;">No differences found in the fields that are usually worth comparing — looks like a clean duplicate.</div>`;
  return `<div class="panel"><div class="panel-title">Possible duplicate</div>${diffHtml}${items}<button class="ref-btn" style="width:100%;margin-top:8px;" data-dup-not-duplicate="${dupGroupSignature(group)}">Not duplicates — keep both, stop asking</button></div>`;
}

function renderDuplicates() {
  const groups = findDuplicateGroups();
  const body = groups.length
    ? groups.map(renderDuplicateGroup).join('')
    : `<div class="empty-state">No duplicates detected. 🎉</div>`;
  return `
    <div class="app-header">
      <div class="brand-row">
        <button class="back-btn" data-nav-back="1">← Back</button>
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
      e.semi && e.semi.flag, e.semi && e.semi.notes, e.uke && e.uke.flag, e.uke && e.uke.notes,
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
    ${proxy ? '' : `<div style="background:var(--pink-soft);color:var(--pink);padding:8px 10px;border-radius:8px;font-size:12px;margin-bottom:10px;">No proxy URL set yet. Add one in the Settings panel (Database mode) to enable live fetching — see the setup notes I gave you.</div>`}
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

// Reads whatever the cross-reference bookmarklet (see renderSettingsPanel) just
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
    var authorM = html.match(/([A-Za-z0-9 .'-]+)\s*<\/[a-z]+>?\s*(Original Creator|Story\s*&\s*Art|Author)(?!s)/i);
    if (authorM) author = authorM[1].trim();
    var artist = '';
    var artistM = html.match(/([A-Za-z0-9 .'-]+)\s*<\/[a-z]+>?\s*Artist/i);
    if (artistM) artist = artistM[1].trim();
    data = { site: 'Anime-Planet', sourceUrl: url, title: title, altTitle: alt, coverUrl: meta('og:image'), summary: meta('og:description'), tags: tags, author: author, artist: artist };
  } else if (url.indexOf('mangago.me') > -1) {
    data = { site: 'MangaGo', sourceUrl: url, title: meta('og:title'), altTitle: '', coverUrl: meta('og:image'), summary: meta('og:description'), tags: [], author: '', artist: '' };
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
    artist: data.artist,
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
  if (data.coverUrl && !e.coverIsUserUploaded) e.coverUrl = data.coverUrl;
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
  if (!e.artist && data.artist) e.artist = data.artist;
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
/* Add entry modal                                                        */
/* ---------------------------------------------------------------------- */

// Which format the user explicitly picked in the Add modal's new glowing
// emoji picker — deliberately separate from STATE.format (the homepage's
// own filter) so adding an entry never silently inherits whatever the
// homepage filter happens to be set to; she has to choose it every time.
let ADD_FORMAT_PICK = null;

function openAddModal() {
  ADD_FORMAT_PICK = null;
  openModal(`
    <h3>Add new title</h3>
    <div class="add-format-pick-row">
      <span class="add-format-pick-icon" data-add-format-pick="reading" title="Reading (Manhwa/Manga)">📖</span>
      <span class="add-format-pick-icon" data-add-format-pick="watching" title="Watching (Anime)">📺</span>
    </div>
    <div class="field-row"><label>Title *</label><input type="text" id="add-title"></div>
    <div class="field-row"><label>Author</label><input type="text" id="add-author"></div>
    <div class="modal-actions">
      <button class="btn-ghost" data-close-modal="1">Cancel</button>
      <button class="btn-primary" data-submit-add="1">Add</button>
    </div>
  `, { centered: true });
}

async function submitAdd() {
  const title = document.getElementById('add-title').value.trim();
  if (!title) { showToast('Title is required'); return; }
  if (!ADD_FORMAT_PICK) { showToast('Pick 📖 Reading or 📺 Watching first'); return; }
  const author = document.getElementById('add-author').value.trim();
  const entry = {
    id: uid(ADD_FORMAT_PICK === 'reading' ? 'manhwa' : 'anime'),
    format: ADD_FORMAT_PICK, title, altTitle: '', novelAuthor: '', author, artist: '', isNovel: false,
    totalSeasons: null, totalChapters: null, epilogue: '', officialLink: '', released: null,
    status: '', currentlyReadingRaw: '', downloaded: '', currentChapter: '',
    shelf: ADD_FORMAT_PICK === 'reading' ? 'Plan to Read' : 'Completed',
    tags: [], customTags: [], notes: '', favorite: false,
    coverUrl: null, referenceUrl: null, referenceSite: null, referenceStatus: 'none', suggestedMatch: null,
    summaryCache: null, summaryCachedAt: null, smutRating: 0, qualityRating: 0, lolRating: 0, cryRating: 0,
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

  // Whole-gallery drag-and-drop for Images/Reactions/H — drop anywhere in
  // the masonry area (not just onto the small upload label) to upload a
  // batch of files at once.
  const galleryDropzone = root.querySelector('main.gallery-dropzone');
  if (galleryDropzone && (STATE.view === 'reactions' || STATE.view === 'meme' || STATE.view === 'h')) {
    wireMultiFileDropZone(galleryDropzone, async (files) => {
      if (STATE.view === 'h') await addHImageFiles(files);
      else await addReactionFiles(files, STATE.view === 'meme' ? 'reactions' : 'images');
      render();
    });
  }

  // The "Yaoi Journal" logo/name in the global header is a second path to
  // the same destination as the footer Journal button — same full reset,
  // same navigate('home') call, from any screen in the app.
  root.querySelectorAll('[data-header-home]').forEach((el) => {
    el.onclick = () => {
      resetHomeFiltersClean();
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
      if (view === 'home') resetHomeFiltersClean();
      navigate(view);
    };
  });
  root.querySelectorAll('[data-nav-back]').forEach((el) => {
    el.onclick = () => navigateBack();
  });
  root.querySelectorAll('[data-nav-filter]').forEach((el) => {
    el.onclick = () => {
      const which = el.getAttribute('data-nav-filter');
      STATE.showFavoritesOnly = which === 'favorites';
      STATE.showOnDriveOnly = which === 'onDrive';
      STATE.showHentaiOnly = which === 'hentai';
      STATE.showArtworkOnly = which === 'artwork';
      // Every filter chip in this row should behave the same way — results
      // appear below the filter container, which stays put. Favorites/On HD
      // used to force the whole filter section closed, which was jarring and
      // inconsistent with every other filter (hentai, shelf, tags, ratings).
      navigate('home');
    };
  });
  const searchInput = root.querySelector('#search-input');
  if (searchInput) {
    searchInput.oninput = (ev) => {
      STATE.search = ev.target.value;
      // Same stale-modal issue navigate() guards against — typing here while
      // already on the home view re-renders in place instead of routing
      // through navigate(), so it needs its own closeModal() call too.
      closeModal();
      if (STATE.view === 'home') {
        renderHomeInPlace();
      } else {
        // Search lives in the global header now, reachable from any screen —
        // typing while elsewhere jumps to Journal to show results, then
        // restores focus/cursor so the jump doesn't interrupt typing.
        STATE.showFavoritesOnly = false; STATE.showOnDriveOnly = false; STATE.showHentaiOnly = false; STATE.showArtworkOnly = false; FILTERS_COLLAPSED = false;
        SEARCH_INPUT_SHOULD_FOCUS = true;
        navigate('home');
      }
    };
    if (SEARCH_INPUT_SHOULD_FOCUS) {
      SEARCH_INPUT_SHOULD_FOCUS = false;
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }
    // Pressing Enter submits the search — blur so the mobile keyboard
    // closes automatically instead of staying up until manually dismissed.
    searchInput.onkeydown = (ev) => { if (ev.key === 'Enter') searchInput.blur(); };
  }
  root.querySelectorAll('[data-format]').forEach((el) => {
    // Clicking the already-active icon turns it off (STATE.format = null,
    // meaning no format filter — Reading + Watching both show, mixed
    // together). Clicking the other icon switches to it as before.
    el.onclick = () => { const val = el.getAttribute('data-format'); STATE.format = STATE.format === val ? null : val; STATE.shelf = 'ALL'; STATE.tagFilters = []; STATE.smutFilter = null; STATE.qualityFilter = null; STATE.lolFilter = null; STATE.cryFilter = null; STATE.flagFilter = null; STATE.linkFilter = false; STATE.noLinkFilter = false; STATE.storyStatusFilter = null; render(); };
  });
  root.querySelectorAll('[data-shelf]').forEach((el) => {
    el.onclick = () => { STATE.shelf = el.getAttribute('data-shelf'); render(); };
  });
  root.querySelectorAll('[data-story-status-filter]').forEach((el) => {
    el.onclick = () => {
      const val = el.getAttribute('data-story-status-filter');
      STATE.storyStatusFilter = val === 'ALL' ? null : val;
      render();
    };
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
  root.querySelectorAll('[data-toggle-home-section]').forEach((el) => {
    el.onclick = async () => {
      const rowId = el.getAttribute('data-toggle-home-section');
      await toggleHomeSectionCollapsed(rowId);
      const collapsed = HOME_COLLAPSED_SECTIONS.has(rowId);
      const bodyEl = document.getElementById(rowId);
      if (bodyEl) bodyEl.classList.toggle('collapsed', collapsed);
      const chevron = el.querySelector('.home-section-chevron');
      if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
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
  root.querySelectorAll('[data-lol-filter]').forEach((el) => {
    el.onclick = () => {
      const n = Number(el.getAttribute('data-lol-filter'));
      STATE.lolFilter = STATE.lolFilter === n ? null : n;
      render();
    };
  });
  root.querySelectorAll('[data-cry-filter]').forEach((el) => {
    el.onclick = () => {
      const n = Number(el.getAttribute('data-cry-filter'));
      STATE.cryFilter = STATE.cryFilter === n ? null : n;
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
  root.querySelectorAll('[data-link-filter]').forEach((el) => {
    el.onclick = () => {
      STATE.linkFilter = !STATE.linkFilter;
      render();
    };
  });
  root.querySelectorAll('[data-no-link-filter]').forEach((el) => {
    el.onclick = () => {
      STATE.noLinkFilter = !STATE.noLinkFilter;
      render();
    };
  });
  const addBtn = root.querySelector('[data-add-entry]');
  if (addBtn) addBtn.onclick = openAddModal;
  const proxyUrlInput = root.querySelector('#proxy-url-input');
  if (proxyUrlInput) proxyUrlInput.onblur = () => {
    setProxyUrl(proxyUrlInput.value);
    showToast('Settings saved');
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
  const readingLinkInput = root.querySelector('#reading-link-input');
  if (readingLinkInput) readingLinkInput.onblur = async () => {
    let val = readingLinkInput.value.trim();
    if (!val) return;
    if (!/^https?:\/\//i.test(val)) val = 'https://' + val;
    const e = getEntry(STATE.entryId);
    if (!e) return;
    e.readingLink = val;
    await saveEntry(e);
    render();
  };
  const clearReadingLinkBtn = root.querySelector('[data-clear-reading-link]');
  if (clearReadingLinkBtn) clearReadingLinkBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    if (!e) return;
    e.readingLink = '';
    await saveEntry(e);
    render();
  };
  const currentChapterInput = root.querySelector('#current-chapter-input');
  if (currentChapterInput) currentChapterInput.onblur = async () => {
    const e = getEntry(STATE.entryId);
    if (!e) return;
    e.currentChapter = currentChapterInput.value.trim();
    await saveEntry(e);
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
  // Hentai toggle — same tag-based on/off pattern as On HD above. Since
  // isHentai() just checks whether the entry has a "hentai" tag, typing that
  // tag in manually has the same effect as tapping this button; they're two
  // paths to the same underlying state, per her spec.
  const hentaiBtn = root.querySelector('[data-toggle-hentai]');
  if (hentaiBtn) hentaiBtn.onclick = async () => {
    const e = getEntry(STATE.entryId);
    if (isHentai(e)) {
      e.tags = (e.tags || []).filter((t) => normalizeTagKey(t) !== HENTAI_TAG_KEY);
      e.customTags = (e.customTags || []).filter((t) => normalizeTagKey(t) !== HENTAI_TAG_KEY);
    } else {
      e.customTags = [...(e.customTags || []), 'Hentai'];
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
  // querySelectorAll (not querySelector) — this same attribute is now used
  // both for the single 🔀 icon on an entry's own detail header AND for a
  // "Merge into…" button per item inside each Review Duplicates group, so
  // there can legitimately be more than one on screen at once.
  root.querySelectorAll('[data-merge-entry]').forEach((el) => {
    el.onclick = () => openMergePickerModal(el.getAttribute('data-merge-entry'));
  });
  root.querySelectorAll('[data-merge-group-source]').forEach((el) => {
    el.onclick = () => {
      const sourceId = el.getAttribute('data-merge-group-source');
      const targets = (el.getAttribute('data-merge-group-targets') || '').split(',').filter(Boolean);
      if (targets.length === 1) {
        mergeDuplicateGroupItem(sourceId, targets[0]);
      } else if (targets.length > 1) {
        // 3+ items flagged as possible duplicates together — ask which of
        // the other items in *this* comparison to merge into, rather than
        // reopening a full-library picker.
        const options = targets.map((id) => getEntry(id)).filter(Boolean);
        openModal(`
          <h3>Merge into which one?</h3>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${options.map((o) => `<button class="ref-btn" style="width:100%;text-align:left;" data-merge-group-pick="${o.id}">${escapeHtml(o.title)}</button>`).join('')}
          </div>
          <div class="modal-actions"><button class="btn-ghost" data-close-modal="1">Cancel</button></div>
        `);
        document.querySelectorAll('[data-merge-group-pick]').forEach((btn) => {
          btn.onclick = () => { closeModal(); mergeDuplicateGroupItem(sourceId, btn.getAttribute('data-merge-group-pick')); };
        });
      }
    };
  });
  const shelfSelectEl = root.querySelector('[data-shelf-select]');
  if (shelfSelectEl) shelfSelectEl.onchange = async () => {
    const e = getEntry(STATE.entryId);
    e.shelf = shelfSelectEl.value;
    await saveEntry(e);
    showToast('Shelf updated');
    render();
  };
  const statusSelectEl = root.querySelector('[data-status-select]');
  if (statusSelectEl) statusSelectEl.onchange = async () => {
    const e = getEntry(STATE.entryId);
    e.status = statusSelectEl.value;
    await saveEntry(e);
    showToast('Status updated');
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
    el.onchange = () => applyCharPhotoFile(el.getAttribute('data-char-photo'), el.files[0]);
  });
  const coverUploadInput = root.querySelector('#cover-upload-input');
  if (coverUploadInput) coverUploadInput.onchange = () => applyCoverFile(coverUploadInput.files[0]);
  // Drag-and-drop onto the cover / semi / uke photo slots, in addition to the
  // existing tap-to-pick file inputs — previously requested, wasn't wired up.
  const coverSlotEl = root.querySelector('.cover-slot');
  if (coverSlotEl) wireImageDropZone(coverSlotEl, applyCoverFile);
  root.querySelectorAll('.char-photo-slot').forEach((slotEl) => {
    const input = slotEl.querySelector('[data-char-photo]');
    if (!input) return;
    const who = input.getAttribute('data-char-photo');
    wireImageDropZone(slotEl, (file) => applyCharPhotoFile(who, file));
  });
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
  const legacyNoteInput = root.querySelector('#legacy-note-input');
  if (legacyNoteInput) legacyNoteInput.onblur = async () => {
    const e = getEntry(STATE.entryId); e.legacyNote = legacyNoteInput.value.trim(); await saveEntry(e);
  };
  const notesArea = root.querySelector('#user-notes');
  if (notesArea) {
    attachBulletTextarea(notesArea);
    // Resetting height to 'auto' before remeasuring momentarily collapses the
    // box, which shifts the Images panel sitting right below it — the
    // browser's scroll-anchoring logic was fighting that shift on every
    // keystroke and visibly yanking the page toward Images (or to the top).
    // A full collapse-and-remeasure is only needed once up front and again
    // once typing has stopped (on blur); while actively typing, only grow in
    // place when content actually overflows, which never collapses anything.
    const fullAutoGrow = () => { notesArea.style.height = 'auto'; notesArea.style.height = (notesArea.scrollHeight + 2) + 'px'; };
    const growIfNeeded = () => {
      if (notesArea.scrollHeight > notesArea.clientHeight) notesArea.style.height = (notesArea.scrollHeight + 2) + 'px';
    };
    fullAutoGrow();
    notesArea.oninput = growIfNeeded;
    notesArea.onblur = async () => {
      fullAutoGrow();
      const e = getEntry(STATE.entryId); e.notes = notesArea.value; await saveEntry(e);
    };
  }
  const screencapInput = root.querySelector('#screencap-input');
  if (screencapInput) screencapInput.onchange = () => applyScreencapFiles(screencapInput.files);
  const screencapDropzone = root.querySelector('#screencap-dropzone');
  if (screencapDropzone) wireImageDropZone(screencapDropzone, (file) => applyScreencapFiles([file]));
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
  // (the old per-item [data-del-reaction] corner button in the Reactions
  // duplicates view is gone — deleting there now happens via the
  // [data-open-meme] click handler in attachMemeGridHandlers, which
  // branches on MEME_SHOWING_DUPLICATES)
  root.querySelectorAll('[data-images-item]').forEach((el) => {
    el.onclick = async () => {
      const url = el.getAttribute('data-images-item');
      if (IMAGE_SELECT_MODE) {
        if (IMAGE_SELECTED.has(url)) IMAGE_SELECTED.delete(url); else IMAGE_SELECTED.add(url);
        render();
      } else if (IMAGES_TAB === 'duplicates') {
        // Possible Duplicates is a fast triage screen — tapping a copy
        // deletes it outright (still behind a confirm as the safety net)
        // instead of opening the full edit modal.
        if (!confirm('Delete this image? It will be removed from any read it\'s attached to.')) return;
        // Bug fix: this used to always pass reactionId: null, so a
        // standalone Images-tab upload (which is actually backed by an
        // ALL_REACTIONS record, source: 'images') never got deleted at
        // all — deleteImageFromGalleryEverywhere only knows how to strip a
        // dataUrl off an entry's semi/uke/screencaps, so with no matching
        // entry it silently did nothing. Rescanning then found the same
        // "deleted" image again since it was never actually gone. Look up
        // the real record so reaction-backed images route through
        // deleteReaction like they're supposed to.
        const match = allAppImages().find((i) => i.dataUrl === url);
        // Before it's gone for good, hand off anything this copy had —
        // mood/group tags, Reactions/NSFW membership — to whichever other
        // copy(ies) remain in this same comparison, so tapping the "wrong"
        // one to delete never costs already-done sorting work.
        const dupGroup = (IMAGE_DUP_GROUPS || []).find((g) => g.some((img) => img.dataUrl === url));
        if (dupGroup) {
          const survivorImageUrls = dupGroup.filter((img) => img.dataUrl !== url).map((img) => img.dataUrl);
          await transferDuplicateTagsOnDelete(url, survivorImageUrls, match ? match.reactionId : null);
          // Do this BEFORE the actual delete below — once the entry's photo
          // reference has already been swapped to the survivor, deleteImage-
          // FromGalleryEverywhere's own entry scan (which matches by this
          // exact dataUrl) simply won't find anything left to strip there.
          await transferEntryAttachmentOnDuplicateDelete(url, survivorImageUrls);
        }
        await deleteImageFromGalleryEverywhere({ dataUrl: url, reactionId: match ? match.reactionId : null });
        if (IMAGE_DUP_GROUPS) {
          IMAGE_DUP_GROUPS = IMAGE_DUP_GROUPS
            .map((g) => g.filter((x) => x.dataUrl !== url))
            .filter((g) => g.length > 1);
        }
        showToast('Deleted');
        render();
      } else {
        openImageAttachmentsModal(url);
      }
    };
  });
  root.querySelectorAll('[data-images-pending-entry]').forEach((el) => {
    el.onclick = () => navigate('detail', el.getAttribute('data-images-pending-entry'));
  });
  const toggleSelectBtn = root.querySelector('[data-images-toggle-select]');
  if (toggleSelectBtn) toggleSelectBtn.onclick = () => {
    IMAGE_SELECT_MODE = !IMAGE_SELECT_MODE;
    IMAGE_SELECTED = new Set();
    render();
  };
  // Same in-place DOM toggle the homepage's Hide/Show Filters button uses —
  // no full render() needed, just flip the class and button label.
  const imagesFiltersToggleBtn = root.querySelector('[data-images-toggle-filters]');
  if (imagesFiltersToggleBtn) imagesFiltersToggleBtn.onclick = () => {
    IMAGES_FILTERS_COLLAPSED = !IMAGES_FILTERS_COLLAPSED;
    const el = document.getElementById('images-filters-collapsible');
    if (el) el.classList.toggle('collapsed', IMAGES_FILTERS_COLLAPSED);
    imagesFiltersToggleBtn.textContent = IMAGES_FILTERS_COLLAPSED ? '▸ Show Filters' : '▴ Hide Filters';
  };
  const attachSelectedBtn = root.querySelector('[data-images-attach-selected]');
  if (attachSelectedBtn) attachSelectedBtn.onclick = () => {
    if (IMAGE_SELECTED.size) openAttachImagesToEntryModal(Array.from(IMAGE_SELECTED));
  };
  const tagSelectedBtn = root.querySelector('[data-images-tag-selected]');
  if (tagSelectedBtn) tagSelectedBtn.onclick = () => {
    if (IMAGE_SELECTED.size) openTagSelectedImagesModal(Array.from(IMAGE_SELECTED));
  };
  const addSelectedReactionsBtn = root.querySelector('[data-images-add-selected-reactions]');
  if (addSelectedReactionsBtn) addSelectedReactionsBtn.onclick = async () => {
    const urls = Array.from(IMAGE_SELECTED);
    let added = 0;
    for (const url of urls) {
      const r = await addImageAsReaction(url);
      if (r) added++;
    }
    IMAGE_SELECT_MODE = false;
    IMAGE_SELECTED = new Set();
    showToast(`Added ${added} of ${urls.length} to Reactions${added < urls.length ? ' (rest were already in there)' : ''}`);
    render();
  };
  const pullSelectedIntoHBtn = root.querySelector('[data-images-pull-selected-into-h]');
  if (pullSelectedIntoHBtn) pullSelectedIntoHBtn.onclick = () => {
    const urls = Array.from(IMAGE_SELECTED);
    urls.forEach((url) => pullImageIntoH(url));
    IMAGE_SELECT_MODE = false;
    IMAGE_SELECTED = new Set();
    showToast(`Pulled ${urls.length} image${urls.length === 1 ? '' : 's'} into H`);
    render();
  };
  // Mainly here for the Possible Duplicates tab — select mode already worked
  // there (the shared masonry item honors IMAGE_SELECT_MODE regardless of
  // tab), it just had no bulk delete option, only one-at-a-time via each
  // item's own "✕". This lets her clear out a whole group of dupes at once.
  const deleteSelectedImagesBtn = root.querySelector('[data-images-delete-selected]');
  if (deleteSelectedImagesBtn) deleteSelectedImagesBtn.onclick = async () => {
    const urls = Array.from(IMAGE_SELECTED);
    if (!urls.length) return;
    if (!confirm(`Delete ${urls.length} image${urls.length === 1 ? '' : 's'}? They'll be removed from any read they're attached to. This can't be undone.`)) return;
    // Same reactionId lookup fix as the single-tap duplicates delete above.
    const allImgs = allAppImages();
    for (const url of urls) {
      const match = allImgs.find((i) => i.dataUrl === url);
      await deleteImageFromGalleryEverywhere({ dataUrl: url, reactionId: match ? match.reactionId : null });
    }
    if (IMAGE_DUP_GROUPS) {
      IMAGE_DUP_GROUPS = IMAGE_DUP_GROUPS
        .map((g) => g.filter((x) => !urls.includes(x.dataUrl)))
        .filter((g) => g.length > 1);
    }
    IMAGE_SELECT_MODE = false;
    IMAGE_SELECTED = new Set();
    showToast('Deleted');
    render();
  };
  root.querySelectorAll('[data-images-tab]').forEach((el) => {
    el.onclick = () => { IMAGES_TAB = el.getAttribute('data-images-tab'); render(); };
  });
  root.querySelectorAll('[data-images-kind-filter]').forEach((el) => {
    el.onclick = () => {
      const kind = el.getAttribute('data-images-kind-filter');
      IMAGE_KIND_FILTER = IMAGE_KIND_FILTER === kind ? null : kind;
      render();
    };
  });
  root.querySelectorAll('[data-images-group-filter]').forEach((el) => {
    el.onclick = () => {
      const g = el.getAttribute('data-images-group-filter');
      IMAGE_GROUP_FILTER = IMAGE_GROUP_FILTER === g ? null : g;
      render();
    };
  });
  const imagesUntaggedOnlyBtn = root.querySelector('[data-images-untagged-only]');
  if (imagesUntaggedOnlyBtn) imagesUntaggedOnlyBtn.onclick = () => { IMAGES_UNTAGGED_ONLY = !IMAGES_UNTAGGED_ONLY; render(); };
  const addImageGroupBtn = root.querySelector('[data-images-add-group]');
  if (addImageGroupBtn) addImageGroupBtn.onclick = () => {
    const key = addImageGroup(prompt('Name this new image group (e.g. "favorites", "wallpaper-worthy"):'));
    if (key) { IMAGE_GROUP_FILTER = key; render(); }
  };
  const manageImageGroupsBtn = root.querySelector('[data-images-manage-groups]');
  if (manageImageGroupsBtn) manageImageGroupsBtn.onclick = openManageImageGroupsModal;
  const scanDupBtn = root.querySelector('[data-scan-duplicates]');
  if (scanDupBtn) scanDupBtn.onclick = () => scanForImageDuplicates();
  const resetDismissedImageDupsBtn = root.querySelector('[data-reset-dismissed-image-dups]');
  if (resetDismissedImageDupsBtn) resetDismissedImageDupsBtn.onclick = () => resetDismissedImageDupGroups();
  root.querySelectorAll('[data-dismiss-image-dup-group]').forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); dismissImageDupGroup(Number(el.getAttribute('data-dismiss-image-dup-group'))); };
  });
  // (the old per-item [data-del-dup-image] corner button is gone — deleting
  // from Possible Duplicates now happens via the [data-images-item] click
  // handler above, which branches on IMAGES_TAB itself)

  // Meme/reaction library
  attachMemeGridHandlers();
  const memeUploadInput = root.querySelector('#meme-upload-input');
  if (memeUploadInput) memeUploadInput.onchange = async () => {
    if (!memeUploadInput.files.length) return;
    await addReactionFiles(memeUploadInput.files, 'reactions');
    render();
  };

  // H library
  attachHGridHandlers();
  root.querySelectorAll('[data-meme-mood-filter]').forEach((el) => {
    el.onclick = () => {
      const mood = el.getAttribute('data-meme-mood-filter');
      MEME_STATE.moodFilter = MEME_STATE.moodFilter === mood ? null : mood;
      render();
    };
  });
  const addMoodBtn = root.querySelector('[data-meme-add-mood]');
  if (addMoodBtn) addMoodBtn.onclick = () => {
    const key = addCustomMood(prompt('Name this new mood group (e.g. "creepy", "cute"):'));
    if (key) { MEME_STATE.moodFilter = key; render(); }
  };
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
  const toggleSuggBtn = root.querySelector('[data-toggle-suggestions]');
  if (toggleSuggBtn) toggleSuggBtn.onclick = async () => {
    await setSuggestionsCollapsed(!TAG_SUGGESTIONS_COLLAPSED);
    render();
  };
  root.querySelectorAll('[data-tagmgr-merge]').forEach((el) => {
    el.onclick = async () => {
      const name = el.getAttribute('data-tagmgr-merge');
      const targetRaw = prompt(`Merge "${name}" into which existing tag? (its entries will get that tag instead, and "${name}" will disappear)`);
      if (!targetRaw || !targetRaw.trim()) return;
      const target = targetRaw.trim();
      if (target.toLowerCase() === name.toLowerCase()) return;
      for (const e of ALL_ENTRIES) {
        let changed = false;
        if ((e.tags || []).includes(name)) {
          e.tags = e.tags.filter((t) => t !== name);
          if (!e.tags.includes(target) && !(e.customTags || []).includes(target)) e.tags.push(target);
          changed = true;
        }
        if ((e.customTags || []).includes(name)) {
          e.customTags = e.customTags.filter((t) => t !== name);
          if (!(e.tags || []).includes(target) && !e.customTags.includes(target)) e.customTags.push(target);
          changed = true;
        }
        if (changed) await saveEntry(e);
      }
      showToast(`Merged "${name}" into "${target}"`);
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
  root.querySelectorAll('[data-suggest-hide]').forEach((el) => {
    el.onclick = async () => {
      await setTagSoftHidden(el.getAttribute('data-suggest-hide'), true);
      showToast('Hidden');
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
  const imageBackfillBtn = root.querySelector('[data-run-image-backfill]');
  if (imageBackfillBtn) imageBackfillBtn.onclick = runImageBackfill;
  const stopImageBackfillBtn = root.querySelector('[data-stop-image-backfill]');
  if (stopImageBackfillBtn) stopImageBackfillBtn.onclick = cancelImageBackfill;
  const consolidateDriveBtn = root.querySelector('[data-consolidate-drive-folders]');
  if (consolidateDriveBtn) consolidateDriveBtn.onclick = consolidateDriveFolders;
  const openThemeBtn = root.querySelector('[data-open-theme-picker]');
  if (openThemeBtn) openThemeBtn.onclick = () => openThemePickerModal({ autoForced: false });
  const previewThemeBtn = root.querySelector('[data-preview-theme-picker]');
  if (previewThemeBtn) previewThemeBtn.onclick = () => openThemePickerModal({ preview: true });
  root.querySelectorAll('[data-retry-failed-upload]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true;
      el.textContent = '⏳ Retrying…';
      await retryFailedUpload(el.getAttribute('data-retry-failed-upload'));
    };
  });
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
      if (sm.coverUrl && !e.coverIsUserUploaded) e.coverUrl = sm.coverUrl;
      if (sm.url) { e.referenceUrl = sm.url; e.referenceSite = sm.site || 'Anime-Planet'; e.referenceStatus = 'confirmed'; }
      if (sm.summary) e.summaryCache = sm.summary;
      if (sm.tags && sm.tags.length) {
        const merged = new Set([...(e.tags || []), ...sanitizeIncomingTags(sm.tags)]);
        e.tags = Array.from(merged);
      }
      if (!e.author && sm.author) e.author = sm.author;
      if (!e.artist && sm.artist) e.artist = sm.artist;
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
  if (STATE.shelf === 'ALL' && !STATE.tagFilters.length && !STATE.search && !STATE.showFavoritesOnly && !STATE.showOnDriveOnly && !STATE.showHentaiOnly && !STATE.showArtworkOnly && !STATE.smutFilter && !STATE.qualityFilter && !STATE.lolFilter && !STATE.cryFilter && !STATE.flagFilter && !STATE.linkFilter && !STATE.noLinkFilter && !STATE.storyStatusFilter) {
    const suggestedGroup = entries.filter((e) => e.suggestedMatch);
    if (suggestedGroup.length > 0) {
      body += homeSectionHtml('row-suggested', '🔎 Suggested Matches', suggestedGroup.length, suggestedGroup.map((e) => renderCoverCard(e, true)).join(''));
    }
    const shelvesToShow = STATE.format === 'watching' ? ['Completed'] : SHELVES_READING;
    shelvesToShow.forEach((shelf) => {
      const group = entries.filter((e) => e.shelf === shelf);
      if (group.length === 0) return;
      const rowId = 'row-' + shelf.replace(/[^a-z0-9]+/gi, '-');
      body += homeSectionHtml(rowId, shelf, group.length, group.map((e) => renderCoverCard(e)).join(''));
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
    main.querySelectorAll('[data-toggle-home-section]').forEach((el) => {
      el.onclick = async () => {
        const rowId = el.getAttribute('data-toggle-home-section');
        await toggleHomeSectionCollapsed(rowId);
        const collapsed = HOME_COLLAPSED_SECTIONS.has(rowId);
        const bodyEl = document.getElementById(rowId);
        if (bodyEl) bodyEl.classList.toggle('collapsed', collapsed);
        const chevron = el.querySelector('.home-section-chevron');
        if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
      };
    });
  }
}

/* ---------------------------------------------------------------------- */
/* Global modal button delegation (settings/add/crossref use event         */
/* delegation on the overlay itself since they're re-rendered often)       */
/* ---------------------------------------------------------------------- */

document.addEventListener('click', async (ev) => {
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
  // Prev/next chevrons in the individual Images/Reactions/H item modals —
  // see mediaModalNavArrowsHtml/mediaModalNavNeighbors near openModal().
  if (t.matches('[data-images-nav-prev]')) openImageAttachmentsModal(t.getAttribute('data-images-nav-prev'));
  if (t.matches('[data-images-nav-next]')) openImageAttachmentsModal(t.getAttribute('data-images-nav-next'));
  if (t.matches('[data-meme-nav-prev]')) openMemeEditModal(t.getAttribute('data-meme-nav-prev'));
  if (t.matches('[data-meme-nav-next]')) openMemeEditModal(t.getAttribute('data-meme-nav-next'));
  if (t.matches('[data-h-nav-prev]')) openHImageModal(t.getAttribute('data-h-nav-prev'));
  if (t.matches('[data-h-nav-next]')) openHImageModal(t.getAttribute('data-h-nav-next'));
  if (t.matches('[data-goto-entry-from-modal]')) {
    closeModal();
    navigate('detail', t.getAttribute('data-goto-entry-from-modal'));
  }
  if (t.matches('[data-attach-this-image]')) {
    // Reuses the same "Attach to a read..." picker the multi-select bulk
    // action already uses, just with a single-item array — before this, the
    // Images gallery's individual item view could only show which reads an
    // image was ALREADY attached to, with no way to attach it to one from
    // here (only possible one at a time from inside that entry's own page,
    // or via multi-select back on the gallery grid).
    openAttachImagesToEntryModal([t.getAttribute('data-attach-this-image')]);
  }
  if (t.matches('[data-merge-pick-target]')) {
    const targetId = t.getAttribute('data-merge-pick-target');
    const source = getEntry(MERGE_SOURCE_ID);
    const target = getEntry(targetId);
    if (source && target && confirm(`Merge "${source.title}" into "${target.title}"? "${source.title}" will be deleted after its data is copied over.`)) {
      mergeIntoTarget(MERGE_SOURCE_ID, targetId);
    }
  }
  if (t.matches('[data-meme-toggle-mood]')) {
    const id = t.getAttribute('data-meme-id');
    const mood = t.getAttribute('data-meme-toggle-mood');
    const r = ALL_REACTIONS.find((x) => x.id === id);
    if (r) {
      r.moodTags = r.moodTags || [];
      if (r.moodTags.includes(mood)) r.moodTags = r.moodTags.filter((m) => m !== mood);
      else r.moodTags.push(mood);
      saveReaction(r);
      // Re-render the grid behind the modal too, not just the modal itself —
      // otherwise an item that just got tagged (or un-tagged) stays parked
      // in its old untagged-first/tagged position until something else
      // happens to trigger a full re-render.
      render();
      openMemeEditModal(id);
    }
  }
  if (t.matches('[data-meme-add-mood-for]')) {
    const id = t.getAttribute('data-meme-add-mood-for');
    const key = addCustomMood(prompt('Name this new mood group (e.g. "creepy", "cute"):'));
    const r = ALL_REACTIONS.find((x) => x.id === id);
    if (key && r) {
      r.moodTags = r.moodTags || [];
      if (!r.moodTags.includes(key)) r.moodTags.push(key);
      saveReaction(r);
      render();
      openMemeEditModal(id);
    }
  }
  if (t.matches('[data-meme-manage-moods]')) openManageMoodsModal();
  // Shared group-manager modal actions (Images "Manage" + Reactions
  // "Manage" both open the same modal now — see renderSharedGroupManagerModal).
  if (t.matches('[data-groupmgr-tab]')) {
    GROUP_MGR_TAB = t.getAttribute('data-groupmgr-tab');
    renderSharedGroupManagerModal(GROUP_MGR_MODAL_TITLE);
  }
  if (t.matches('[data-groupmgr-hide]')) {
    const name = t.getAttribute('data-groupmgr-hide');
    const nowHidden = !HIDDEN_GROUP_KEYS.has(name);
    setGroupSoftHidden(name, nowHidden).then(() => {
      showToast(nowHidden ? 'Hidden from filters' : 'Shown in filters again');
      renderSharedGroupManagerModal(GROUP_MGR_MODAL_TITLE);
      render();
    });
  }
  if (t.matches('[data-groupmgr-merge]')) {
    const name = t.getAttribute('data-groupmgr-merge');
    const targetRaw = prompt(`Merge "${name}" into which existing group? (its images/reactions will get that group instead, and "${name}" will disappear)`);
    if (targetRaw && targetRaw.trim() && targetRaw.trim().toLowerCase() !== name.toLowerCase()) {
      renameImageGroup(name, targetRaw.trim());
      showToast(`Merged "${name}" into "${targetRaw.trim()}"`);
      render();
      renderSharedGroupManagerModal(GROUP_MGR_MODAL_TITLE);
    }
  }
  if (t.matches('[data-groupmgr-rename]')) {
    const oldKey = t.getAttribute('data-groupmgr-rename');
    const newName = prompt(`Rename "${oldKey}" to:`, oldKey);
    if (newName && newName.trim() && newName.trim() !== oldKey) {
      renameImageGroup(oldKey, newName);
      render();
      renderSharedGroupManagerModal(GROUP_MGR_MODAL_TITLE);
    }
  }
  if (t.matches('[data-groupmgr-delete]')) {
    const key = t.getAttribute('data-groupmgr-delete');
    if (confirm(`Delete the "${key}" group? This removes it from every image/reaction — the items themselves are kept. It won't reappear (by hand or future import) until restored from the Hidden tab.`)) {
      deleteImageGroup(key);
      render();
      renderSharedGroupManagerModal(GROUP_MGR_MODAL_TITLE);
    }
  }
  if (t.matches('[data-restore-group]')) {
    const key = t.getAttribute('data-restore-group');
    restoreDeletedGroup(key).then(() => {
      showToast('Restored — this group can be used again');
      renderSharedGroupManagerModal(GROUP_MGR_MODAL_TITLE);
    });
  }
  if (t.matches('[data-toggle-image-tag]')) {
    const tag = t.getAttribute('data-toggle-image-tag');
    const url = t.getAttribute('data-image-url');
    toggleImageTag(url, tag);
    render();
    openImageAttachmentsModal(url);
  }
  if (t.matches('[data-hgroupmgr-tab]')) {
    H_GROUP_MGR_TAB = t.getAttribute('data-hgroupmgr-tab');
    renderHGroupManagerModal();
  }
  if (t.matches('[data-hgroupmgr-hide]')) {
    const name = t.getAttribute('data-hgroupmgr-hide');
    const nowHidden = !H_HIDDEN_GROUP_KEYS.has(name);
    setHGroupSoftHidden(name, nowHidden).then(() => {
      showToast(nowHidden ? 'Hidden from filters' : 'Shown in filters again');
      renderHGroupManagerModal();
      render();
    });
  }
  if (t.matches('[data-hgroupmgr-merge]')) {
    const name = t.getAttribute('data-hgroupmgr-merge');
    const targetRaw = prompt(`Merge "${name}" into which existing group? (its images will get that group instead, and "${name}" will disappear)`);
    if (targetRaw && targetRaw.trim() && targetRaw.trim().toLowerCase() !== name.toLowerCase()) {
      renameHGroup(name, targetRaw.trim());
      showToast(`Merged "${name}" into "${targetRaw.trim()}"`);
      render();
      renderHGroupManagerModal();
    }
  }
  if (t.matches('[data-hgroupmgr-rename]')) {
    const oldKey = t.getAttribute('data-hgroupmgr-rename');
    const newName = prompt(`Rename "${oldKey}" to:`, oldKey);
    if (newName && newName.trim() && newName.trim() !== oldKey) {
      renameHGroup(oldKey, newName);
      render();
      renderHGroupManagerModal();
    }
  }
  if (t.matches('[data-hgroupmgr-delete]')) {
    const key = t.getAttribute('data-hgroupmgr-delete');
    if (confirm(`Delete the "${key}" group? This removes it from every image — the images themselves are kept. It won't reappear until restored from the Hidden tab.`)) {
      deleteHGroup(key);
      render();
      renderHGroupManagerModal();
    }
  }
  if (t.matches('[data-restore-h-group]')) {
    const key = t.getAttribute('data-restore-h-group');
    restoreDeletedHGroup(key).then(() => {
      showToast('Restored — this group can be used again');
      renderHGroupManagerModal();
    });
  }
  if (t.matches('[data-toggle-h-tag]')) {
    const tag = t.getAttribute('data-toggle-h-tag');
    const url = t.getAttribute('data-h-url');
    toggleHTag(url, tag);
    render();
    openHImageModal(url);
  }
  if (t.matches('[data-h-add-group-for]')) {
    const url = t.getAttribute('data-h-add-group-for');
    const key = addHGroup(prompt('Name this new H group:'));
    if (key) { toggleHTag(url, key); render(); openHImageModal(url); }
  }
  if (t.matches('[data-toggle-reaction-membership]')) {
    // Only ever rendered from the Images modal (see mediaToggleButtonsHtml's
    // showReactionsToggle comment) — reopening that same modal in place
    // instead of closing it means she can immediately tag a mood on it from
    // the Reactions tab without having to re-find and reopen the item.
    const url = t.getAttribute('data-toggle-reaction-membership');
    toggleReactionMembership(url).then((nowIn) => {
      showToast(nowIn ? 'Added to Reactions — tag it with a mood from the Reactions tab' : 'Removed from Reactions');
      render();
      openImageAttachmentsModal(url);
    });
  }
  if (t.matches('[data-toggle-h-membership]')) {
    // Reopen whichever modal this button was actually rendered from (see
    // the `reopen` param on mediaToggleButtonsHtml) instead of closing —
    // same reasoning as the Reactions toggle above.
    const url = t.getAttribute('data-toggle-h-membership');
    const modalType = t.getAttribute('data-h-toggle-modal-type') || 'images';
    const modalId = t.getAttribute('data-h-toggle-modal-id') || url;
    const nowIn = toggleHMembership(url);
    showToast(nowIn ? 'Pulled into H — hidden elsewhere in the app from now on.' : 'Removed from H');
    render();
    if (modalType === 'meme') openMemeEditModal(modalId);
    else if (modalType === 'h') openHImageModal(modalId);
    else openImageAttachmentsModal(modalId);
  }
  if (t.matches('[data-crop-meme]')) openCropReactionModal(t.getAttribute('data-crop-meme'));
  if (t.matches('[data-crop-image]')) openCropImageModal(t.getAttribute('data-crop-image'));
  if (t.matches('[data-crop-h]')) openCropHModal(t.getAttribute('data-crop-h'));
  if (t.matches('[data-save-image]')) {
    const url = t.getAttribute('data-save-image');
    downloadDataUrl(url, `yaoi-journal-${Date.now()}.${dataUrlExt(url)}`);
    showToast('Saved to your device');
  }
  if (t.matches('[data-delete-h-image]')) {
    const url = t.getAttribute('data-delete-h-image');
    if (confirm('Delete this H image?')) {
      // Awaited — removeFromH's upload branch is itself async (awaits an
      // IndexedDB delete before mutating ALL_H_IMAGES), so firing render()
      // without waiting on it used to re-render against the still-stale
      // array, leaving the deleted item visible until some unrelated later
      // render happened to run.
      await removeFromH(url);
      closeModal();
      showToast('Deleted');
      render();
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
      // Awaited for the same reason as data-delete-h-image above — deleteReaction
      // awaits an IndexedDB delete before splicing ALL_REACTIONS, so the
      // immediately-following render() used to run against the pre-delete array.
      await deleteReaction(id);
      closeModal();
      showToast('Deleted');
      render();
    }
  }
  if (t.matches('[data-delete-image-attachment]')) {
    const dataUrl = t.getAttribute('data-delete-image-attachment');
    const reactionId = t.getAttribute('data-delete-image-reaction-id') || null;
    if (confirm('Delete this image? Any reads it\'s attached to lose their copy.')) {
      await deleteImageFromGalleryEverywhere({ dataUrl, reactionId });
      if (IMAGE_DUP_GROUPS) IMAGE_DUP_GROUPS = IMAGE_DUP_GROUPS.filter((g) => !g.some((img) => img.dataUrl === dataUrl));
      closeModal();
      showToast('Deleted');
      render();
    }
  }
  if (t.matches('[data-add-format-pick]')) {
    ADD_FORMAT_PICK = t.getAttribute('data-add-format-pick');
    // Direct DOM toggle instead of a full modal re-render, so anything
    // already typed into Title/Author isn't wiped out by the click.
    document.querySelectorAll('[data-add-format-pick]').forEach((el) => {
      el.classList.toggle('glow', el.getAttribute('data-add-format-pick') === ADD_FORMAT_PICK);
    });
  }
  if (t.matches('[data-submit-add]')) submitAdd();
  if (t.matches('[data-fetch-ref]')) fetchReferencePreview(t.getAttribute('data-fetch-ref'));
  if (t.matches('[data-confirm-ref]')) confirmReference(t.getAttribute('data-confirm-ref'));
  if (t.matches('[data-paste-ref]')) pasteReferenceFromClipboard(t.getAttribute('data-paste-ref'));
});
document.getElementById('overlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'overlay' && !THEME_PICKER_BLOCKING) closeModal();
});
document.getElementById('toast-ok').addEventListener('click', hideToast);

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

// One-time (or run-whenever-needed) backfill: images added BEFORE Drive
// storage existed — or added while Drive was disconnected — only ever got
// saved locally (IndexedDB) on the device that uploaded them, with no
// *DriveId set. That's exactly why a device with a fresh sign-in (like a
// laptop) never receives them: hydrateDriveImages() only pulls a copy down
// when the Firestore doc HAS a Drive id to fetch, and this device never
// pushed one up. This walks every entry/reaction, uploads anything still
// local-only, and saves the resulting id so it finally syncs.
const IMAGE_BACKFILL = { running: false, checked: 0, total: 0, uploaded: 0, cancel: false };
// Only actual base64 data: URLs can be uploaded to Drive (dataUrlToBlob()
// needs real base64 payload to decode) — a coverUrl copied straight from a
// confirmed cross-reference match is a plain https:// link to someone
// else's CDN, not a locally-stored image, and doesn't need (or support)
// backing up to Drive at all. Counting those as "pending" made this button
// permanently stuck reporting leftover items that could never actually
// succeed — every attempt failed with "atob: not correctly encoded" and the
// count never moved. Filtering to data: URLs only is the actual fix.
function isLocalDataUrl(v) {
  return typeof v === 'string' && v.startsWith('data:');
}
function imageBackfillCandidates() {
  const tasks = [];
  ALL_ENTRIES.forEach((e) => {
    if (isLocalDataUrl(e.coverUrl) && !e.coverDriveId) tasks.push({ kind: 'cover', entry: e });
    if (e.semi && isLocalDataUrl(e.semi.photo) && !e.semi.photoDriveId) tasks.push({ kind: 'semi', entry: e });
    if (e.uke && isLocalDataUrl(e.uke.photo) && !e.uke.photoDriveId) tasks.push({ kind: 'uke', entry: e });
    if (e.screencaps && e.screencaps.filter(isLocalDataUrl).length > (e.screencapDriveIds || []).length) tasks.push({ kind: 'screencaps', entry: e });
  });
  ALL_REACTIONS.forEach((r) => {
    if (isLocalDataUrl(r.dataUrl) && !r.driveId) tasks.push({ kind: 'reaction', reaction: r });
  });
  // H images were missing from this list entirely until now — they have the
  // exact same local-only-until-uploaded shape (dataUrl + driveId) as
  // reactions, they just live in a separate array/store. Without this, a
  // stuck H upload would never show up in the pending count or get picked up
  // by either the bulk sweep below or the Failed Uploads panel.
  ALL_H_IMAGES.forEach((h) => {
    if (isLocalDataUrl(h.dataUrl) && !h.driveId) tasks.push({ kind: 'himage', hImage: h });
  });
  return tasks;
}
async function runImageBackfill() {
  if (IMAGE_BACKFILL.running) return;
  if (!driveTokenValid()) { showToast('Reconnect Google Drive first, then try this again.'); return; }
  const candidates = imageBackfillCandidates();
  if (!candidates.length) { showToast('Nothing to upload — every image already has a Drive copy.'); return; }
  IMAGE_BACKFILL.running = true;
  IMAGE_BACKFILL.checked = 0;
  IMAGE_BACKFILL.total = candidates.length;
  IMAGE_BACKFILL.uploaded = 0;
  IMAGE_BACKFILL.cancel = false;
  if (STATE.view === 'database') render();
  for (const t of candidates) {
    if (IMAGE_BACKFILL.cancel) break;
    if (!driveTokenValid()) {
      // Token lapsed mid-run (redirect/reconnect isn't available from
      // inside this loop) — stop cleanly instead of burning through the
      // rest of the list failing silently.
      showToast('Google Drive disconnected mid-upload — reconnect and run this again to finish the rest.');
      break;
    }
    try {
      if (t.kind === 'cover') {
        const id = await tryUploadImageToDrive(t.entry.coverUrl, `${t.entry.id}-cover.jpg`);
        if (id) { t.entry.coverDriveId = id; await saveEntry(t.entry); IMAGE_BACKFILL.uploaded++; }
      } else if (t.kind === 'semi') {
        const id = await tryUploadImageToDrive(t.entry.semi.photo, `${t.entry.id}-semi-photo.jpg`);
        if (id) { t.entry.semi.photoDriveId = id; await saveEntry(t.entry); IMAGE_BACKFILL.uploaded++; }
      } else if (t.kind === 'uke') {
        const id = await tryUploadImageToDrive(t.entry.uke.photo, `${t.entry.id}-uke-photo.jpg`);
        if (id) { t.entry.uke.photoDriveId = id; await saveEntry(t.entry); IMAGE_BACKFILL.uploaded++; }
      } else if (t.kind === 'screencaps') {
        const e = t.entry;
        e.screencapDriveIds = e.screencapDriveIds || [];
        for (let i = e.screencapDriveIds.length; i < e.screencaps.length; i++) {
          if (IMAGE_BACKFILL.cancel || !driveTokenValid()) break;
          const id = await tryUploadImageToDrive(e.screencaps[i], `${e.id}-screencap-${Date.now()}-${i}.jpg`);
          if (id) { e.screencapDriveIds.push(id); IMAGE_BACKFILL.uploaded++; }
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        await saveEntry(e);
      } else if (t.kind === 'reaction') {
        const id = await tryUploadImageToDrive(t.reaction.dataUrl, `reaction-${t.reaction.id}.jpg`, 'reaction');
        if (id) { t.reaction.driveId = id; await saveReaction(t.reaction); IMAGE_BACKFILL.uploaded++; }
      } else if (t.kind === 'himage') {
        const id = await tryUploadImageToDrive(t.hImage.dataUrl, `h-${t.hImage.id}.jpg`, 'h');
        if (id) { t.hImage.driveId = id; await saveHImage(t.hImage); IMAGE_BACKFILL.uploaded++; }
      }
    } catch (err) {
      console.error('Image backfill item failed:', err);
    }
    IMAGE_BACKFILL.checked++;
    if (STATE.view === 'database' && IMAGE_BACKFILL.checked % 2 === 0) render();
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  const wasCancelled = IMAGE_BACKFILL.cancel;
  IMAGE_BACKFILL.running = false;
  if (STATE.view === 'database') render();
  showToast(wasCancelled || !driveTokenValid()
    ? `Stopped — uploaded ${IMAGE_BACKFILL.uploaded} of ${IMAGE_BACKFILL.checked} checked`
    : `Done — uploaded ${IMAGE_BACKFILL.uploaded} image${IMAGE_BACKFILL.uploaded === 1 ? '' : 's'} to Drive`);
}
function cancelImageBackfill() {
  IMAGE_BACKFILL.cancel = true;
}

/* ---------------------------------------------------------------------- */
/* Failed Uploads panel (Database view)                                    */
/* Same underlying "local-only, no Drive id" candidates as the bulk        */
/* backfill sweep above, but surfaced one item at a time with a preview so */
/* she can actually see what's stuck, plus a per-item retry that shrinks   */
/* the file first — the bulk sweep re-uploads the ORIGINAL bytes, which is */
/* exactly what already failed once (usually for being too large), so on  */
/* its own it just fails the same way again for the true oversized cases. */
/* ---------------------------------------------------------------------- */

// Runs the original through compressDataUrlHarder first (skipped for
// video/gif/webp, where re-encoding would destroy the animation — those
// just get retried as-is), uploads whatever came out of that, and only on
// success patches the record's driveId (and, if it was actually shrunk,
// swaps in the smaller dataUrl too so it stays smaller going forward).
async function compressAndUploadField(getUrl, setUrl, setDriveId, filename, kind) {
  const original = getUrl();
  if (!original) return false;
  const skipCompression = isVideoUrl(original) || /^data:image\/(gif|webp)/.test(original);
  let toUpload = original;
  if (!skipCompression) {
    try { toUpload = await compressDataUrlHarder(original, 800, 0.7); } catch (err) { console.error('Compress-before-retry failed, uploading original instead:', err); toUpload = original; }
  }
  const fileId = await tryUploadImageToDrive(toUpload, filename, kind);
  if (!fileId) return false;
  setDriveId(fileId);
  if (toUpload !== original) setUrl(toUpload);
  return true;
}

async function retryFailedUpload(key) {
  const sep = key.indexOf('|');
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  let ok = false;
  try {
    if (kind === 'cover') {
      const e = ALL_ENTRIES.find((x) => x.id === id);
      if (!e) return;
      ok = await compressAndUploadField(() => e.coverUrl, (v) => { e.coverUrl = v; }, (v) => { e.coverDriveId = v; }, `${e.id}-cover.jpg`, 'entry');
      if (ok) await saveEntry(e);
    } else if (kind === 'semi') {
      const e = ALL_ENTRIES.find((x) => x.id === id);
      if (!e || !e.semi) return;
      ok = await compressAndUploadField(() => e.semi.photo, (v) => { e.semi.photo = v; }, (v) => { e.semi.photoDriveId = v; }, `${e.id}-semi-photo.jpg`, 'entry');
      if (ok) await saveEntry(e);
    } else if (kind === 'uke') {
      const e = ALL_ENTRIES.find((x) => x.id === id);
      if (!e || !e.uke) return;
      ok = await compressAndUploadField(() => e.uke.photo, (v) => { e.uke.photo = v; }, (v) => { e.uke.photoDriveId = v; }, `${e.id}-uke-photo.jpg`, 'entry');
      if (ok) await saveEntry(e);
    } else if (kind === 'screencaps') {
      const e = ALL_ENTRIES.find((x) => x.id === id);
      if (!e) return;
      e.screencapDriveIds = e.screencapDriveIds || [];
      let anyOk = false;
      for (let i = e.screencapDriveIds.length; i < e.screencaps.length; i++) {
        const original = e.screencaps[i];
        if (!isLocalDataUrl(original)) continue;
        const skipCompression = isVideoUrl(original) || /^data:image\/(gif|webp)/.test(original);
        let toUpload = original;
        if (!skipCompression) {
          try { toUpload = await compressDataUrlHarder(original, 800, 0.7); } catch (err) { toUpload = original; }
        }
        const fileId = await tryUploadImageToDrive(toUpload, `${e.id}-screencap-${Date.now()}-${i}.jpg`, 'entry');
        if (!fileId) break; // still failing — stop here rather than skip ahead out of order
        e.screencapDriveIds.push(fileId);
        if (toUpload !== original) e.screencaps[i] = toUpload;
        anyOk = true;
      }
      ok = anyOk;
      await saveEntry(e);
    } else if (kind === 'reaction') {
      const r = ALL_REACTIONS.find((x) => x.id === id);
      if (!r) return;
      ok = await compressAndUploadField(() => r.dataUrl, (v) => { r.dataUrl = v; }, (v) => { r.driveId = v; }, `reaction-${r.id}.jpg`, 'reaction');
      if (ok) await saveReaction(r);
    } else if (kind === 'himage') {
      const h = ALL_H_IMAGES.find((x) => x.id === id);
      if (!h) return;
      ok = await compressAndUploadField(() => h.dataUrl, (v) => { h.dataUrl = v; }, (v) => { h.driveId = v; }, `h-${h.id}.jpg`, 'h');
      if (ok) await saveHImage(h);
    }
  } catch (err) {
    console.error('Failed-upload retry errored:', err);
  }
  showToast(ok ? '☁️ Uploaded to Drive' : "Still couldn't upload — check your connection and try again.");
  if (STATE.view === 'database') render();
}

// One card per pending item — a thumbnail plus a Compress & Retry (or, for
// video/gif/webp, a plain Retry) button. Built from the exact same task
// shape imageBackfillCandidates() already produces for the bulk sweep, just
// rendered individually instead of only shown as a single aggregate count.
function renderFailedUploadCard(t) {
  let preview, key, label, sub = '';
  if (t.kind === 'cover') { preview = t.entry.coverUrl; key = `cover|${t.entry.id}`; label = t.entry.title || 'Untitled'; sub = 'Cover image'; }
  else if (t.kind === 'semi') { preview = t.entry.semi.photo; key = `semi|${t.entry.id}`; label = t.entry.title || 'Untitled'; sub = 'Semi photo'; }
  else if (t.kind === 'uke') { preview = t.entry.uke.photo; key = `uke|${t.entry.id}`; label = t.entry.title || 'Untitled'; sub = 'Uke photo'; }
  else if (t.kind === 'screencaps') {
    const doneCount = (t.entry.screencapDriveIds || []).length;
    const pendingCount = t.entry.screencaps.filter(isLocalDataUrl).length - doneCount;
    preview = t.entry.screencaps[doneCount];
    key = `screencaps|${t.entry.id}`;
    label = t.entry.title || 'Untitled';
    sub = `${pendingCount} screencap${pendingCount === 1 ? '' : 's'}`;
  } else if (t.kind === 'reaction') {
    preview = t.reaction.dataUrl;
    key = `reaction|${t.reaction.id}`;
    label = t.reaction.source === 'images' ? 'Image' : t.reaction.source === 'reactions' ? 'Reaction' : 'Image/Reaction';
  } else if (t.kind === 'himage') {
    preview = t.hImage.dataUrl;
    key = `himage|${t.hImage.id}`;
    label = 'H image';
  }
  if (!preview) return '';
  const skipCompression = isVideoUrl(preview) || /^data:image\/(gif|webp)/.test(preview);
  const media = isVideoUrl(preview)
    ? `<video src="${preview}" muted playsinline style="width:100%;height:110px;object-fit:cover;border-radius:8px;background:#000;"></video>`
    : `<img src="${preview}" alt="" style="width:100%;height:110px;object-fit:cover;border-radius:8px;background:#000;">`;
  return `
    <div class="failed-upload-card" style="width:128px;">
      ${media}
      <div style="font-size:11px;margin-top:4px;line-height:1.3;">${escapeHtml(label)}${sub ? `<br><span style="color:var(--text-dim);">${escapeHtml(sub)}</span>` : ''}</div>
      <button class="ref-btn" style="width:100%;margin-top:4px;font-size:11px;padding:4px;" data-retry-failed-upload="${escapeHtml(key)}">${skipCompression ? '🔄 Retry' : '🗜️ Compress & Retry'}</button>
    </div>`;
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
    // Rehydrate whatever screen/history the user was on before this reload —
    // see the big comment above NAV_HISTORY for why a reload can happen
    // without the user ever touching the back button.
    restoreNavState();
    db = await openDB();
    await ensureSeeded();
    await loadAllEntries();
    await loadAllReactions();
    await loadAllHImages();
    repairCorruptedHDataUrls().catch((err) => console.error('H dataUrl repair failed:', err));
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
    const savedCustomMoods = await idbGet(STORE_META, 'customMoods');
    const savedSuggCollapsed = await idbGet(STORE_META, 'tagSuggestionsCollapsed');
    if (savedSuggCollapsed && typeof savedSuggCollapsed.value === 'boolean') TAG_SUGGESTIONS_COLLAPSED = savedSuggCollapsed.value;
    const savedHomeCollapsed = await idbGet(STORE_META, 'homeCollapsedSections');
    if (savedHomeCollapsed && Array.isArray(savedHomeCollapsed.value)) HOME_COLLAPSED_SECTIONS = new Set(savedHomeCollapsed.value);
    const savedImageGroups = await idbGet(STORE_META, 'imageGroups');
    // CUSTOM_MOODS and IMAGE_GROUPS are the same shared Set (see its
    // declaration) — merge both legacy meta keys into one Set on load and
    // assign it to both variables so they start out unified.
    if ((savedCustomMoods && Array.isArray(savedCustomMoods.value)) || (savedImageGroups && Array.isArray(savedImageGroups.value))) {
      const mergedGroups = new Set([...(savedCustomMoods && savedCustomMoods.value || []), ...(savedImageGroups && savedImageGroups.value || [])]);
      CUSTOM_MOODS = mergedGroups;
      IMAGE_GROUPS = mergedGroups;
    }
    const savedImageTagMap = await idbGet(STORE_META, 'imageTagMap');
    if (savedImageTagMap && savedImageTagMap.value && typeof savedImageTagMap.value === 'object') IMAGE_TAG_MAP = savedImageTagMap.value;
    const savedHiddenGroups = await idbGet(STORE_META, 'hiddenGroupKeys');
    if (savedHiddenGroups && Array.isArray(savedHiddenGroups.value)) HIDDEN_GROUP_KEYS = new Set(savedHiddenGroups.value);
    const savedDeletedGroups = await idbGet(STORE_META, 'deletedGroupKeys');
    if (savedDeletedGroups && Array.isArray(savedDeletedGroups.value)) DELETED_GROUP_KEYS = new Set(savedDeletedGroups.value);
    const savedIgnoredImageDup = await idbGet(STORE_META, 'ignoredImageDupGroups');
    if (savedIgnoredImageDup && Array.isArray(savedIgnoredImageDup.value)) IGNORED_IMAGE_DUP_GROUPS = new Set(savedIgnoredImageDup.value);
    const savedIgnoredMemeDup = await idbGet(STORE_META, 'ignoredMemeDupGroups');
    if (savedIgnoredMemeDup && Array.isArray(savedIgnoredMemeDup.value)) IGNORED_MEME_DUP_GROUPS = new Set(savedIgnoredMemeDup.value);
    const savedIgnoredHDup = await idbGet(STORE_META, 'ignoredHDupGroups');
    if (savedIgnoredHDup && Array.isArray(savedIgnoredHDup.value)) IGNORED_H_DUP_GROUPS = new Set(savedIgnoredHDup.value);
    const savedHImageKeys = await idbGet(STORE_META, 'hImageKeys');
    if (savedHImageKeys && Array.isArray(savedHImageKeys.value)) H_IMAGE_KEYS = new Set(savedHImageKeys.value);
    const savedHGroups = await idbGet(STORE_META, 'hGroups');
    if (savedHGroups && Array.isArray(savedHGroups.value)) H_GROUPS = new Set(savedHGroups.value);
    const savedHTagMap = await idbGet(STORE_META, 'hTagMap');
    if (savedHTagMap && savedHTagMap.value && typeof savedHTagMap.value === 'object') H_TAG_MAP = savedHTagMap.value;
    const savedHHiddenGroups = await idbGet(STORE_META, 'hHiddenGroupKeys');
    if (savedHHiddenGroups && Array.isArray(savedHHiddenGroups.value)) H_HIDDEN_GROUP_KEYS = new Set(savedHHiddenGroups.value);
    const savedHDeletedGroups = await idbGet(STORE_META, 'hDeletedGroupKeys');
    if (savedHDeletedGroups && Array.isArray(savedHDeletedGroups.value)) H_DELETED_GROUP_KEYS = new Set(savedHDeletedGroups.value);
    const savedHNoteMap = await idbGet(STORE_META, 'hNoteMap');
    if (savedHNoteMap && savedHNoteMap.value && typeof savedHNoteMap.value === 'object') H_NOTE_MAP = savedHNoteMap.value;
    const savedThemeMode = await idbGet(STORE_META, 'themeMode');
    if (savedThemeMode && typeof savedThemeMode.value === 'string') THEME_MODE = savedThemeMode.value;
    if ('serviceWorker' in navigator) {
      setupAutoUpdatingServiceWorker();
    }
    // Completes the signInWithRedirect() round trip used ONLY for
    // standalone/PWA identity sign-in now (see isStandalonePWA() in
    // signInWithGoogle()) — the Drive token itself no longer goes through
    // Firebase's redirect/popup result at all (see requestDriveToken()),
    // so this just needs to surface a sign-in error if one occurred.
    // onAuthStateChanged below picks up the signed-in user regardless of
    // whether this call itself succeeds.
    try {
      const redirectResult = await fbAuth.getRedirectResult();
      if (redirectResult && redirectResult.user && isStandalonePWA()) {
        // Just signed in via redirect (standalone PWA) — no Drive token yet
        // (GIS needs a fresh tap), so let her know the Reconnect banner is
        // expected right after this.
        showToast('Signed in — tap "Reconnect Google Drive" to enable image sync.');
      }
    } catch (err) {
      console.error('Redirect sign-in failed:', err);
      if (err && err.code !== 'auth/no-auth-event') AUTH_ERROR = authErrorMessage(err);
    }
    fbAuth.onAuthStateChanged(async (user) => {
      CURRENT_USER = user;
      if (user) {
        SYNC_BUSY = true;
        try {
          await syncWithFirestore(user);
          await syncReactionsWithFirestore(user);
          await syncHImagesWithFirestore(user);
          await pullMetaState();
          startFirestoreListener(user);
          startReactionsFirestoreListener(user);
          startHImagesFirestoreListener(user);
        } catch (err) {
          console.error('Firestore sync failed:', err);
          showToast("Couldn't sync — check your connection");
        }
        SYNC_BUSY = false;
        autoMatchSweepIfDue();
        runFavoriteTagMigrationOnce();
      }
      render();
      // A genuinely brand-new account (no entries/reactions/H images ever
      // synced) with no theme chosen yet gets the picker automatically, once
      // per session — this is the "asked upon new user creation" flow. An
      // EXISTING account that predates this feature also has no themeMode,
      // but forcing the modal on someone returning to an app they already
      // use would be jarring, so those instead just see a one-time button
      // under Database > Synced Account (see renderDatabase()).
      if (user && !THEME_MODE && !THEME_PICKER_AUTO_SHOWN && !ALL_ENTRIES.length && !ALL_REACTIONS.length && !ALL_H_IMAGES.length) {
        THEME_PICKER_AUTO_SHOWN = true;
        openThemePickerModal({ autoForced: true });
      }
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

/* ---------------------------------------------------------------------- */
/* Pull-to-refresh (mobile)                                               */
/* Installed/standalone PWAs don't reliably get the browser's native pull-*/
/* to-refresh gesture (iOS Safari in particular suppresses it once "Add to*/
/* Home Screen" is used), so this adds a manual equivalent: dragging down  */
/* from the very top of the page reloads the app. Only arms while at the  */
/* very top of the page scroll AND no modal is open (a modal has its own  */
/* internal scroll — e.g. a long Groups/Manage list — and shouldn't get   */
/* hijacked into reloading the whole app mid-scroll).                     */
/* ---------------------------------------------------------------------- */
(function setupPullToRefresh() {
  const THRESHOLD = 80; // px of downward drag before it counts as a "pull"
  let startY = null;
  let armed = false;
  window.addEventListener('touchstart', (ev) => {
    const overlay = document.getElementById('overlay');
    if (overlay && overlay.classList.contains('open')) { startY = null; return; }
    if (window.scrollY > 0 || ev.touches.length !== 1) { startY = null; return; }
    startY = ev.touches[0].clientY;
    armed = false;
  }, { passive: true });
  window.addEventListener('touchmove', (ev) => {
    if (startY === null) return;
    const dy = ev.touches[0].clientY - startY;
    if (dy > THRESHOLD && window.scrollY === 0) armed = true;
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (armed) { armed = false; startY = null; location.reload(); return; }
    startY = null;
  });
})();

/* ---------------------------------------------------------------------- */
/* Drive hydration auto-retry                                             */
/* hydrateMissingEntryImages()/hydrateMissingReactions()/                 */
/* hydrateMissingHImages() previously only ever fired once — right when   */
/* navigate() switched to the relevant tab. If the Drive token wasn't     */
/* valid at that exact instant (e.g. it had just expired, or a reconnect  */
/* was still in flight), the placeholder was stuck until the user left    */
/* and came back to the tab. This ticks every ~30s and retries whichever  */
/* gallery is currently open, so a stuck "?" placeholder resolves itself  */
/* on its own while she's sitting right there looking at it.              */
/* ---------------------------------------------------------------------- */
setInterval(() => {
  if (STATE.view === 'reactions') hydrateMissingEntryImages().catch(() => {});
  else if (STATE.view === 'meme') hydrateMissingReactions().catch(() => {});
  else if (STATE.view === 'h') hydrateMissingHImages().catch(() => {});
}, 30000);

boot();
