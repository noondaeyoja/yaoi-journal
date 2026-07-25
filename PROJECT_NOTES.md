# Yaoi Journal — Project Notes for Claude

Read this first before making any changes. It's the working context for an ongoing project — not user-facing docs.

## What this is

A single-page PWA for tracking manhwa/manga/anime (BL/yaoi) reading and watching progress. Personal-use app for one user (Cristina, aka noondaeyoja).

- **Live site:** https://noondaeyoja.github.io/yaoi-journal/
- **Repo:** github.com/noondaeyoja/yaoi-journal (public)
- **Files that matter:** `index.html`, `app.js` (all app logic, single file, no build step, no framework), `styles.css`, `sw.js` (service worker), `manifest.json`, `seed_data.json` (initial/seed entries)

There is no local dev environment, no npm, no build/bundler. It's plain HTML/CSS/JS loaded directly by the browser. Firebase is loaded via CDN `<script>` tags (compat SDK, not modular) in `index.html`.

## How changes get deployed

There is no git CLI access in this workflow. The process is:

1. Edit `app.js` / `styles.css` / `index.html` etc. as plain text files.
2. Run `node --check app.js` to catch syntax errors before pushing (there's no other test suite).
3. Push via **GitHub's web upload UI**: navigate to `https://github.com/noondaeyoja/yaoi-journal/upload/main`, upload the changed file(s) (same filename = overwrite), write a commit message, click "Commit changes" directly to the `main` branch.
4. GitHub Pages auto-deploys on push (`pages-build-deployment` workflow under the repo's Actions tab). Takes ~30-60s. Always verify the deployment went green before telling the user it's live.
5. The site has a service worker (`sw.js`) that's network-first for `index.html`/`app.js`/`styles.css`/`manifest.json` specifically so deploys show up on next reload without manual cache-busting. If `sw.js` itself ever needs to change, bump `CACHE_NAME` in it (currently `yaoi-journal-v18`).

There's no staging environment — every push goes straight to production for the one real user.

## Backend: Firebase + Google Drive

**Firebase project:** `yaoi-journal` (console.firebase.google.com/project/yaoi-journal). Config lives in `app.js` under `FIREBASE_CONFIG` (apiKey, authDomain `yaoi-journal.firebaseapp.com`, etc.) — this is a public client key, fine to have in the repo.

**Auth:** Google Sign-In only (email/password was fully removed and replaced). User's account: `noondaeyoja@gmail.com`.
- ⚠️ **Authorized domains** (Firebase Console → Authentication → Settings → Authorized domains) must include `noondaeyoja.github.io` — this is NOT added by default (only `localhost` and the `*.firebaseapp.com`/`*.web.app` domains are). Missing this causes Google's OAuth popup to open and immediately error/close. Already fixed as of this writing, but worth checking first if sign-in ever breaks again after a Firebase project change.
- Sign-in uses `signInWithPopup` on desktop, falls back to `signInWithRedirect` for installed/standalone PWA contexts (detected via `isStandalonePWA()`) or if the popup itself fails (`auth/popup-blocked` etc.), since installed PWAs frequently can't host popup windows.
- **⚠️ Drive token acquisition uses Google Identity Services (GIS), NOT Firebase's popup/redirect result.** Firebase's `authDomain` (`yaoi-journal.firebaseapp.com`) differs from the app's real hosting origin (`noondaeyoja.github.io`). Both `signInWithPopup`+`credentialFromResult()` and `signInWithRedirect`+`getRedirectResult()` rely on a cross-origin relay between those two origins to hand back the OAuth access token — and that relay can silently break under modern browsers' third-party storage restrictions (Google's screens all complete normally, but the app never gets the token back, with no error). This was confirmed live (screen-watched a popup complete on Google's side then hang) and via a "no result came back from Google" toast. Fix: `index.html` loads `https://accounts.google.com/gsi/client`, and `app.js` uses `google.accounts.oauth2.initTokenClient(...)` (see `getGisTokenClient()`/`requestDriveToken()`) to mint the Drive access token directly — no cross-origin relay involved. Firebase Auth (`onAuthStateChanged`) is still used for basic identity only. Deployed and confirmed live as of this writing (commit `c274f58`).

**Data storage — Firestore:** `users/{uid}/entries/{entryId}`, `users/{uid}/reactions/{reactionId}`, `users/{uid}/meta/appState`. IndexedDB is the local on-device cache (stores: entries, meta, reactions). Firestore is the source of truth for cross-device sync. Last-write-wins merge by each entry's `updatedAt` ISO timestamp.
- Firestore has a 1MiB per-document cap. `firestoreSafeEntry()` strips large image fields (in order: screencaps → uke photo → semi photo → coverUrl) before writing, and flags `*TooLargeForSync` so the UI knows an image is local-only. **Since the Drive migration**, images are supposed to go to Drive instead of inline base64 — the trimming logic is now mostly a legacy safety net, not the primary path.

**Image storage — Google Drive (as of the most recent work):** Because this is a single-user app, we moved image storage off Firebase (which would require the paid Blaze plan for Cloud Storage) onto the user's own Google Drive, using the `drive.file` OAuth scope (non-sensitive scope — Google doesn't require app verification for it). Images live in a dedicated Drive folder named "Yaoi Journal Images" (auto-created on first use, id cached in `DRIVE_FOLDER_ID`). Firestore entries store Drive file ids (`coverDriveId`, `semi.photoDriveId`, `uke.photoDriveId`, `screencapDriveIds`) instead of the image bytes; each device downloads and locally caches (IndexedDB) the actual bytes on demand via `hydrateDriveImages()`/`hydrateDriveReaction()`.

- ⚠️ **Known limitation, by design:** the Google OAuth access token used for Drive calls is short-lived (~1hr) and is **not** persisted or silently refreshed across page reloads by Firebase (unlike the separate, persistent Firebase Auth session). This means after basically any reload, Drive calls will need a fresh token. The app shows a "Google Drive needs reconnecting to sync images" banner with a Reconnect button (`reconnectGoogleDrive()`) when this happens. This is expected behavior, not a bug — the user has already been told and accepted this tradeoff to avoid Firebase billing.
- **Resolved (see GIS note above):** the Reconnect banner not clearing after a successful Google consent screen was the Firebase cross-origin relay failure. Fixed by switching Drive token acquisition to GIS. If a similar silent-hang symptom ever reappears, don't reach for Firebase's popup/redirect result again — check the GIS token client path first (`getGisTokenClient()`, `requestDriveToken()` in `app.js`).
- Image-to-Drive backfill tool exists (Database → Data Cleanup Tools → "Upload local-only images to Drive") for images that were only ever saved locally (e.g. added while Drive was disconnected) and never got a `*DriveId`, so other devices had nothing to pull down. Run this any time a device reports images not syncing elsewhere.

**Migration status:** The ~1046 entries under the OLD Firebase Auth UID (`dbMUPtPAmzO26ZnzbdOPcS4KPLo2`, original email/password login `cristina.st.germain@gmail.com`) appear to have already carried over automatically the first time the user signed in with the new Google account in the same browser (IndexedDB was shared locally across the account switch, then synced up to the new UID in Firestore) — the new UID (`yoLpDj7py1TRKheUPWpEebsXPT82`) already has 1045 entries as of this writing. **Not fully closed out:** the user separately reported losing notes and duplicate/individual-read-comparison work under a specific entry ("The Ghost's Nocturne", `manhwa-0730` and possibly `manhwa-0255`). Investigation so far: `manhwa-0730`'s notes field is IDENTICAL between old and new UID (nothing lost in that field); both entries under the new UID share one identical, more-recent `updatedAt` timestamp, consistent with `runFavoriteTagMigrationOnce()` (a one-time fix-up that calls `saveEntry()`, which unconditionally bumps `updatedAt`) running for the first time under the new account — this would explain the timestamp shift without necessarily explaining actual data loss. Still unresolved: what specific duplicate-comparison action/decision she remembers making that's actually missing (as opposed to the descriptive notes text, which is intact), and whether `manhwa-0255`'s content matches across UIDs. Next step if this comes up again: ask her exactly what she remembers doing/writing, then diff that specific field between the two UIDs in the Firestore console before assuming anything is actually gone.

## Other architecture notes

- Cross-referencing entries against external platforms (AniList/MangaGo/anime-planet etc.) goes through a Google Apps Script proxy (`apps-script-proxy/Code.gs` in the repo) — its URL is stored in `localStorage` (`yj_proxy_url`) and mirrored to the Firestore meta doc so it only needs to be set once across devices.
- Perceptual/average-hash (aHash) image comparison is used for duplicate detection in the Reactions/Meme library.
- There's both an automatic daily match-sweep (`autoMatchSweepIfDue()`, capped, per-device) and a manual on-demand bulk sweep (`runBulkMatchSweep()`) for cross-referencing many unmatched entries at once, gated by a `suggestedMatchDismissed` flag so dismissed suggestions don't reappear.
- Mobile-specific fixes already in place: viewport meta pinned to prevent auto-zoom, `env(safe-area-inset-top)`-based header padding for the notch, 16px minimum font-size on inputs (iOS auto-zooms below that).

## Working style expected on this project

- The user sends batched, informal lists of bugs/feature requests — treat each item as a real, separate task, don't skip any.
- She's reported real data-loss before (images/matches not saving across devices) — treat any sync-related change with extra care, verify with `node --check`, and spot-check the live site (or ask her to) after every deploy rather than assuming success.
- No formal issue tracker — this file plus git commit history is the record of what's been done.
