# BookTrack — project context

A GitHub-like platform for tracking reading + coding progress through technical
programming books (e.g. *The C Programming Language*, *The Go Programming
Language*). Local-first: PDFs never leave the user's device; the server only
stores book **metadata** (fingerprint-keyed catalog) and reading **commits**
(session metrics).

## Vision (the full goal, not yet built)

- Git-style model: readers make a "commit" per reading session (pages, time,
  scroll depth); solving an exercise = commit code to a per-book repo.
- GitHub-like social/contribution layer: contribution heatmaps, per-book repos,
  follow readers, exercise/solution sharing.
- Book catalog is a shared, community-curated metadata record (chapters/TOC,
  latest edition), edited via a PR-like review/change flow.
- Browser-extension bridge for reading off-platform (future).

Key design answers already decided:
- Reading-time tracking is **client-first**: events buffer in IndexedDB, a
  session commit is pushed only at session end (page-hide or manual "End
  session"), then flushed on reconnect/`online`.
- **No PDF upload.** Files are opened locally (File System Access API) and only
  a SHA-256 fingerprint (~first 1 MB) + metrics reach the server. Legal: paid
  books are never redistributed.
- Book identity is deduped by fingerprint → a single shared catalog record;
  page→chapter mapping via an editable TOC.
- Real git is only used (future) for exercise code; reading progress is a
  DB-backed "commit" model (like GitHub's metadata layer, not git itself).

## Repo layout

```
book-tracker/
├── package.json          # npm workspaces; npm run dev runs both
├── server/               # Express + SQLite (better-sqlite3)
│   ├── index.js          # REST API
│   └── db.js             # schema + prepared statements (data/reader.db)
└── client/               # React + Vite + pdfjs-dist
    └── src/
        ├── App.jsx           # home/library list → fullscreen viewer; Activity + Settings floating drawers
        ├── BookInfo.jsx      # minimal book info page (/book/:slug): title/author/edition/pages/slug/TOC + "Read on this device" (→ /read/:slug)
        ├── useLocalBook.js   # File System Access API: pick/persist/restore/missing/relocate; close()/forget()/removeStats(); beginReading()
        ├── BookWizard.jsx    # add-book setup modal (before reader opens): metadata, TOC, page-1 thumbnail
        ├── PdfReader.jsx     # pdf.js renderer + dwell tracking + session lifecycle
        ├── Heatmap.jsx       # GitHub-style contribution grid (minutes read/day); day cells are clickable filters
        ├── PageHeatmap.jsx   # per-page grid (boxes = pages) with shade = time on page; collapse→25-page chunks; ±100 range zoom
        ├── TocTable.jsx      # spreadsheet-style editable chapter grid (title/start + Pages span)
        ├── ChapterProgress.jsx # per-chapter progress bars (done/active/not started) in the Activity drawer
        ├── storage.js        # IndexedDB handles/queue/sessions/thumbnails + localStorage helpers
        └── api.js            # fetch wrappers for the server
```

## Data model

Server (SQLite, `server/../data/reader.db`) — **v5 (hierarchy + roles)**, see the
**Phase D contract** section below for full rules. Schema:
- `works(id, slug UNIQUE, title, author, retired, created_at)` — the shared URL identity
- `editions(id, work_id REFERENCES works ON DELETE CASCADE, label, page_count, toc, created_at, UNIQUE(work_id, label))` — TOC is 1:1 with the edition
- `fingerprints(id, hash UNIQUE, edition_id REFERENCES editions ON DELETE CASCADE, pending, created_at)` — source files, many → one edition
- `commits(id, fingerprint_id REFERENCES fingerprints ON DELETE CASCADE, user_id, session_id, device_id, started_at, ended_at, minutes, pages JSON, read_pages JSON, created_at)` — facts written against the fingerprint read
- `users(id, github_id, display_name, username, avatar_url, created_at, role TEXT DEFAULT 'member')` — role = `super_admin` | `admin` | `member`; exactly one super admin enforced by the partial unique index `idx_users_super_admin ON users(role) WHERE role='super_admin'`

`PRAGMA foreign_keys = ON` at db open; migration v5 rebuilt `commits` to
`fingerprint_id` and dropped the old flat `books` table. `user_version = 5`.

Client (IndexedDB `book-tracker`) — every book's local state is keyed by its **server slug** (the work's canonical, URL-safe identity; there is no separate client UUID):
- `handles` — persisted FileSystemFileHandle per slug (reconnects file in later sessions)
- `queue` — commits pending push (key = sessionId)
- `sessions` — current in-progress session snapshot (crash recovery)
- `thumbnails` — page-1 cover previews (key = slug, value `{bookId: slug, dataUrl}`), shown on home library items
LocalStorage: `book-tracker:meta` (slug → {title, fingerprint, fileKey, serverId, slug, pending}),
`book-tracker:device` (deviceId UUID). Identity is NOT stored locally — it comes
from the server's `bt_session` cookie via `GET /api/auth/me`.

On boot `storage.migrateLegacyBookKeys()` re-keys any leftover UUID-keyed
handles/thumbnails/meta to their `meta.slug` (one-time upgrade from before
slugs existed). `storage.rekeyBook(old, new)` moves all local state when the
slug changes (e.g. edited in Settings); the saved-list source of truth is the
handle store so Remove Book (handle-only delete) can't resurrect on refresh.

## Phase D contract (implemented)

### Catalog hierarchy

The flat `books` record becomes a three-level hierarchy. The `/book/:slug`
URL is the **work**; versions and source files sit beneath it.

```
work (slug UNIQUE, title, author)                  ← the shared URL identity
 └── editions (label, page_count, toc)             ← TOC is 1:1 with the edition
      └── fingerprints (source files, hash UNIQUE) ← many → one edition
           └── commits (per reader)                ← written against the fingerprint read
```

Rules:
- The slug lives on the **work**. All editions of a work share it; adding an
  edition or source file never changes the URL.
- **TOC is edition-scoped**, not work- or file-scoped. Different scans of the
  same edition share pagination, so they share the edition's TOC. A different
  edition has its own TOC (page numbers differ).
- A fingerprint binds to exactly **one** edition (many-to-one). No
  cross-edition file merging.
- Commit facts (`read_pages`, `pages`, `minutes`) are immutable and
  edition-scoped. Per-session `chapters` / `totalChapters` / per-page attribution
  are recomputed on read from the *current* edition TOC
  (`chapterIndexes(read_pages, toc)` in `db.getUserStats`), so a TOC correction
  retroactively fixes attribution without editing commits.

### Registration & binding

- `POST /api/books` with an unknown fingerprint creates a row in a **pending**
  (unbound) state carrying the client's provisional metadata/toc.
- **Members**: binding is admin-confirmed. The fingerprint stays pending until a
  Super Admin or Admin binds it:
  - same edition as an existing fingerprint → join that edition (adopt its TOC);
  - genuinely different edition → create a new edition under the correct work;
  - no matching work → create a new work.
- **Super Admin / Admin** uploads bind **immediately** (same match logic, no
  pending state) — admins bootstrap the catalog.
- Re-registering a *verified* fingerprint after retire → reactivates the work
  (history reattaches) instead of creating a duplicate.

### Delete / retire / slug lifecycle

| Action | Zero-commit record | Has commits |
|---|---|---|
| Admin/Super Admin delete | hard delete (row gone, slug freed) | **retire** the work |

- **Retire** = `works.retired = 1`; editions/fingerprints/commits all kept, slug
  **kept** (historical session links stay live). Excluded from catalog listings;
  new lookups don't surface it.
- **Hard delete** only ever touches records with zero commits, so no reader's
  history is ever destroyed. A slug is freed only by hard delete or by an admin
  `PATCH` rename of the occupying work (the renamed record keeps its commits
  under its new slug; client `rekeyBook` moves readers' local keys).
- Rationale: nothing is hosted — the record only anchors read-history metadata,
  so destructive deletion is never required (e.g. no legal takedown).

### Roles (Super Admin / Admin / Member)

- `users.role TEXT NOT NULL DEFAULT 'member'` replaces the `is_admin` boolean.
  - **super_admin** — everything (role management, config, deploy). Exactly 1.
  - **admin** — catalog curation: bind/review, works/editions, retire,
    hard-delete zero-commit, slug renames. Cannot touch roles.
  - **member** — read/track/commit; uploads go pending.
- **Exactly one super admin**, enforced with a partial unique index:
  `CREATE UNIQUE INDEX idx_users_super_admin ON users(role) WHERE role='super_admin'`.
- **Admins cannot revoke the super admin.** Role management is super-admin-only;
  the `super_admin` role changes only via the transfer flow, initiated by the
  incumbent.
- **Swap authority before removal**: self-account deletion is refused for the
  super admin until they transfer the role (successor → `super_admin`,
  incumbent → `admin`) in a single transaction.
- **Bootstrap**: the super admin is pinned in env (`GITHUB_SUPER_ADMIN_IDS`,
  one id). On OAuth login, if that id matches and no super admin row exists, the
  user is promoted (self-heal). After a transfer, the DB is authoritative.
- **Display**: roles are strictly internal. Public profiles and `/api/auth/me`
  expose only a boolean `is_admin` (`role !== 'member'`); a Super Admin renders
  the same "admin" badge as any Admin — no "super admin" string is ever shown.

Permissions matrix:

| Capability | Member | Admin | Super Admin |
|---|---|---|---|
| Track reading, upload sources | ✅ | ✅ | ✅ |
| Immediate bind (own uploads) | ❌ → pending | ✅ | ✅ |
| Review & bind pending fingerprints | ❌ | ✅ | ✅ |
| Create/edit works & editions, merge/unmerge | ❌ | ✅ | ✅ |
| Retire / reactivate / hard-delete zero-commit | ❌ | ✅ | ✅ |
| Rename slugs (free-for-reuse) | ❌ | ✅ | ✅ |
| Assign/revoke admin | ❌ | ❌ | ✅ |
| Transfer super admin | ❌ | ❌ | ✅ (incumbent) |
| Server config, env, deploy | ❌ | ❌ | ✅ |

Env: `GITHUB_SUPER_ADMIN_IDS` (owner) + `GITHUB_ADMIN_IDS` (curators).

### Migration v5 plan

From the flat model to the hierarchy + roles, as one transaction on startup:

1. `users.role TEXT NOT NULL DEFAULT 'member'`; backfill `is_admin = 1 → 'admin'`;
   add the partial unique index for `super_admin`; promote the env-pinned super
   admin id; drop the `is_admin` column afterward.
2. Create `works(id, slug UNIQUE, title, author, created_at)` and
   `editions(id, work_id REFERENCES works(id) ON DELETE CASCADE, label TEXT,
   page_count, toc, created_at, UNIQUE(work_id, label))`.
3. Backfill from the current `books` table:
   - one work per (slug, title, author) → slug from old `books.slug`;
   - one edition per (work, old `edition` value, `page_count`, old `toc`);
   - each old `books` row becomes a `fingerprints` row
     (`id, hash = books.fingerprint UNIQUE, edition_id`).
4. Re-key commits: `commits.book_id` now references fingerprint rows (commit →
   file → edition → work).
5. Add `works.retired INTEGER NOT NULL DEFAULT 0` and
   `fingerprints.pending INTEGER NOT NULL DEFAULT 0` (unbound state).
6. Turn `foreign_keys = ON` (db.js init) so works/editions/fingerprints cascades
   and the zero-commit hard delete stay consistent.
7. Client: library dedupe at work level; slug-keyed local state unchanged
   (slug remains the identity readers see); `rekeyBook` reused for renames.

## API

- `GET /api/books`, `GET /api/books/:id`, `GET /api/book/:slug`
- `POST /api/books` `{fingerprint, title?, author?, pageCount?, slug?}` — upsert by fingerprint. Slug is slugified (lowercase, dashes) and auto-deduped (`-2`, `-3`, …) against a UNIQUE index; if omitted it's derived from the title. Existing rows missing a slug get backfilled. **Role-aware (v5):** anonymous/member uploads create a row in `fingerprints.pending = 1` (unbound); admins/super admins bind immediately (same match logic: same edition → join, new edition → create under correct work, no work → create work). Re-registering a *verified* fingerprint of a retired work reactivates it.
- `PATCH /api/books/:id` `{title?, author?, edition?, pageCount?, toc?, slug?}` — a provided slug is deduped against other works; `null`/empty keeps/regenerates the current one. Admin-only (v5).
- `DELETE /api/books/:id` — admin-only (v5). **Retire** (works.retired = 1, everything kept, slug kept, hidden from listings) when commits exist anywhere on the work; **hard delete** (row gone, slug freed) only for zero-commit records.
- `GET /api/books/pending` — admin-only; pending fingerprints awaiting bind.
- `POST /api/books/bind/:fingerprintId` — admin-only; confirms a pending fingerprint (join edition / new edition / new work), returning the bound record.
- `GET /api/books/retired` — admin-only; retired works.
- `POST /api/books/reactivate/:id` — admin-only; reopens a retired work.
- `DELETE /api/books/:id/commits` — removes **your own** commits (stats) for a book
- `POST /api/books/:id/commits` `{sessionId?, deviceId, startedAt, endedAt, secondsPerPage, readPages, fingerprint?}` — authenticated session required; optional `fingerprint` pins the exact file read, else falls back to the work's primary fingerprint.
- `GET /api/books/:id/commits` — your own commits only
- `GET /api/auth/github` — redirect to GitHub authorize (client_id, scope `read:user`, random `state`)
- `GET /api/auth/github/callback` — exchange code → upsert `users` by `github_id` → set httpOnly `bt_session` cookie → redirect
- `GET /api/auth/me` → `{user: {id, display_name, username, avatar_url, is_admin, created_at} | null}` — `is_admin = role !== 'member'`; the raw role is never exposed here (or publicly)
- `GET /api/admin/role` — admin-only; `{role: 'super_admin' | 'admin'}` so the admin console can branch super-only features
- `GET /api/admin/users` — super-admin-only; all users with their role
- `PATCH /api/admin/users/:id/role` `{role: 'admin' | 'member'}` — super-admin-only; refuses to touch the `super_admin` row
- `POST /api/admin/transfer` `{userId}` — super-admin-only; successor → `super_admin`, incumbent → `admin` (single transaction, demotes first to respect the partial unique index)
- `DELETE /api/me` — deletes the signed-in account + its commits; **refused (400) for the super admin** until authority is transferred
- `GET /api/users/:username` — **public** profile: `{user: {id, display_name, username, avatar_url, is_admin, created_at}, stats}` for any user (no auth; the admin flag rides along so the profile card badge shows even logged out); `404 {error: "user not found"}` when the username doesn't exist
- `POST /api/auth/logout`
- Optional `API_KEY`: when set, every `/api` request must send the matching `x-api-key` header.
- **Commits are never anonymous:** every commit endpoint is behind auth; the user is derived from the session cookie, and any client-declared identity is ignored. `PdfReader`'s Start session is gated on being signed in.
- **Sessions re-read the live role from the DB on each request** (`freshUser` in `server/index.js`): the in-memory session caches a user snapshot, so without this a demoted/transferred admin would keep stale powers until re-login; role changes apply immediately.
- **HTTP hardening** (server/index.js + auth.js): the `bt_session` cookie is `Secure` by default (opt out with `COOKIE_SECURE=0` for plain-http localhost); CORS is locked to `CLIENT_ORIGIN` (comma-separated, default `http://localhost:5173,http://localhost:4000`) with `credentials: true`; response headers include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, and a `Content-Security-Policy` on non-API responses (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob: https://avatars.githubusercontent.com`, `worker-src 'self' blob:`, `connect-src 'self'`, `frame-ancestors 'none'`, etc. — pdf.js worker stays same-origin happy).
- **npm security**: `npm audit` clean for runtime deps (express/qs brought current via `npm audit fix`). Two dev-only advisories remain on the Vite dev server (esbuild/vite <=6.4.2; only exploitable against a reachable dev server, and the client build output is static) — fixing requires a breaking vite 8 major, so it's parked.

## How reading tracking works (PdfReader)

- Continuous-scroll renderer: all pages are stacked vertically (`.pdf-page`,
  each wrapped in `.pdf-frame` holding the `<canvas>`, `.text-layer` and
  `.annotation-layer`), and only a window (WINDOW_BEFORE=3 / WINDOW_AFTER=10
  around the current page) has canvases drawn; out-of-window canvases are reset
  to 1x1 to bound memory. **Pages are sized per-page, not uniformly:** on load
  we fetch every page's scale-1 viewport (`loadAllRatios`, 8-way concurrency)
  and give each `.pdf-page` its own height = ratio ⨯ current cssWidth; each
  canvas is scaled relative to *its own* page width (`scale = cssWidth·dpr /
  base_i.width`, so CSS width is always cssWidth). This keeps the
  text-selection overlay and link annotations aligned even when a document has
  mixed page sizes (e.g. a different-sized cover). Cumulative per-page offsets
  (`offsetsRef`, rebuilt when width/zoom changes) drive current-page detection
  (`pageFromOffset`, binary search), `jumpTo`, and initial scroll position;
  zoom/resize keeps the proportional scroll position via total doc height.
  Initial scroll positioning is **deferred until the real page heights are
  committed to the DOM** (`positionedRef` + a settle-`requestAnimationFrame`,
  keyed on `[ready, pageHeights, pageWidth]`): positioning inside the heights
  effect runs against still-empty `.pdf-page` heights, and the premature
  `onScroll` that follows re-marks a wrong current page (and overwrites the
  persisted last-read page). Scroll events and `markCurrent` are ignored while
  `settlingRef` is set, so resume lands on the saved page exactly.
- Zoom is a multiplier vs. scroll-container width; **default is 50%**, range
  50–300% (100% = fit reader width), set via the toolbar. Resizing the window
  re-renders at the new fit-width. Default was requested at 50%.
- Each drawn page also renders a **pdf.js TextLayer** (`.text-layer` overlay,
  `--scale-factor` = CSS-scale so it aligns with the canvas) so PDF text is
  selectable/copyable even though the page is a canvas. A pdf.js
  **AnnotationLayer** (`.annotation-layer`) is drawn on top for Link
  annotations: internal links (`goToDestination` → `getPageIndex`) jump the
  reader, external URLs open in a new tab. A hand-rolled `linkService` object
  drives it (see `linkServiceRef`); only `LINK_ANNOTATION` (type 2) annotations
  are rendered.
- The "current page" is derived from `scrollTop / pageHeight` (scroll handler,
  rAF-throttled); it feeds the page inputs, chapter badge, session tick, and
  last-read-page persistence.
- **Add-book wizard** (before the reader opens): `pick()` registers the file but does *not* open the reader for a brand-new book — it sets `active` to `STATUS.WIZARD` (book + file are held on the home screen, `showLibrary = !bookOpen || status === WIZARD` renders the library behind a modal). `BookWizard.jsx` loads the PDF once, renders page 1 at 168px width to a PNG data URL (`onThumbnail` → App keeps `thumbData`, persisted to the `thumbnails` store + `thumbs` map on Save), exposes editable metadata (reuses App's `meta` setter) and the same `TocTable` used in Settings, plus an **Import from PDF outline** button that calls the shared `flattenOutline(pdf)` against the wizard's own pdf object (the reader isn't mounted yet). Save = `saveMeta({})` + optional thumbnail persist, then `beginReading()` flips `active` to READY so the reader opens. Cancel/`✕` = `close()` (book stays attached in the library, setup can be redone later in Settings). Existing books (Locate file / missing) still go straight to READY, no wizard.
- `jumpTo(n)` is exposed via `useImperativeHandle` (`ref.current.jumpTo`); `getOutline()` is also exposed there — it flattens the PDF's embedded outline via the exported `flattenOutline(pdf)` module function into `{title, startPage}` rows (nested items indented two spaces per level), resolving each destination to its real page number, and is also reused by the wizard's import button. The Settings TOC editor's **Import from PDF outline** button fills the TOC from it (no outline → notice, nothing replaced).
- **Floating TOC badge** (`.toc-badge`, not in the toolbar): an absolutely-positioned capsule at the top-left of the PDF view showing the current chapter/sub-section name. Clicking it toggles between the current reading page and the table of contents:
  - The TOC page is `toc[0].startPage` (first row of the book's TOC data), tracked in `tocPageRef` (initialized/reset when `toc[0].startPage` changes; also the "last TOC page" once you navigate away from it).
  - Clicking away from the TOC page records the current page in `returnToRef`, then jumps to the TOC. Clicking again while on the TOC page jumps back to that saved page.
  - Any `jumpTo` that *originates on the TOC page* (e.g. clicking a PDF-internal link in the contents) remembers that exact TOC page (`tocPageRef = from`), so subsequent badge clicks return to the same contents page, not `toc[0]`. Jumps made from non-TOC pages never touch `tocPageRef`. All navigation funnels through `jumpTo` (toolbar nav, links, named actions), so the hook covers everything.
- The Settings **TOC editor is a spreadsheet-like grid** (`TocTable.jsx`): rows are CSS-grid cells with a chapter title input (flex), a start-page number input, and a read-only Pages column (span until the next chapter / `page_count`, computed in `App.jsx` as `chapterRows`). No jump column and **no progress in Settings** — progress is an activity concept. Enter in an input moves focus down to the next row's same column. Rows are separated by hover-reveal **insert handles** (`.toc-insert`): hovering a border highlights it (accent line + `+`) and clicking inserts a new chapter at that position (top, between rows) via `onInsert`, defaulting its start page to the nearest following chapter's; the trailing "+ Add chapter" still appends at the bottom.
- **Chapter progress lives in the Activity drawer** (`ChapterProgress.jsx`, fed by the same `chapterRows`): one row per chapter with a title, a progress bar (visited pages in the chapter range over span, from `read_pages`/`pages` across all commits), and a status (`✓ done` when every page in the range is visited, `x/y` while reading, `not started`). Driving heuristic: "done" = every page of the chapter's range was rendered at least once.
- 1-second tick accumulates per-page dwell time into the session snapshot
  (persisted to IndexedDB each tick for crash recovery).
- A page is "visited" (read_pages entry) the moment it renders on screen —
  even a sub-second glance counts; the 1-second tick adds dwell time to
  `secondsPerPage` for shade. Shade = relative time-on-page; outline = visited.
  Every visit persists (short sessions are NOT dropped).
- The reader resumes at the last-read page per book (localStorage
  `book-tracker:lastpage` keyed by fingerprint), not page 1.
- Session ends on "End session" button, tab hide (`visibilitychange`), or
  unmount; all sessions are committed (no minimum-duration drop). The commit is
  queued then flushed; flush also runs on the browser `online` event.
- **← Library pauses the session:** the reader's `pause()` imperative marks the
  current session `paused` (+ `pausedAt`, `bookKey`) and saves it to
  IndexedDB instead of committing; the unmount cleanup skips `endSession` when
  a pause/end was requested (`skipUnmountEndRef`). Reopening the same book
  resumes that session (clock and visited pages carry over) rather than
  starting fresh. Paused sessions are skipped by `rolloverPending`; **End
  session** and tab-hide still commit. Opening a *different* book starts a new
  session.
- On (re)load, any pending unfinished session is rolled over and committed.

## Commands

```bash
npm run dev        # server :4000 + client :5173 (vite proxy /api -> :4000)
npm run build      # production build of the client (validation step)
npm run dev:server # server only
npm run dev:client # client only
```

Run `npm run build` after changes to catch compile errors. There is no test
suite; verify UI in a Chromium browser (Brave/Chrome). Server smoke test:
`curl -s http://localhost:5173/api/books`.

## Gotchas / known issues (read before editing)

- **File System Access API only** — works in Chrome/Edge/Safari, not Firefox.
  No arbitrary file-path access in browsers; handles are per-origin and
  re-opening requires a user gesture (`requestPermission`). Firefox users get a
  clear "browser not supported" state; a real `<input type=file>` fallback does
  **not** exist yet (legacy flows are unimplemented).
- **`useLocalBook.js` hook ordering**: all `useCallback`s must be defined
  *before* the boot `useEffect` that references them — the deps array is
  evaluated eagerly, so referencing a later-declared const throws a TDZ
  ReferenceError and blanks the whole app (this bit us once; the boot effect
  must stay below `restore`).
- **`setSavedEntry` adds OR updates** — new bookIds must be appended to the
  sidebar list, not only mapped over, or newly added books are invisible until
  reload.
- **Metadata saves must also write localStorage, keyed by the book's server slug.**
  Every book's local state (handle, meta, thumbs, saved-list entry, URL,
  `active.bookId`) is keyed by the slug returned from the server. The only
  other id is the numeric SQLite row id (`active.book.id` / `meta.serverId`,
  used for every `/api/books/:id` call). `App.saveMeta` performs the API
  update with `active.book.id` and then calls `persistSavedMeta(active.bookId, …)`
  (`storage.saveMetaFor` + a `setSavedEntry` re-read) under the **slug** only.
  When the slug changes, `renameBook(old, new)` re-keys handle/thumbnail/meta
  and updates the saved list and active state; the handle store remains the
  source of truth for refresh so Remove Book (handle-only delete) can't
  resurrect. `restore()` must also re-read local meta *after* `register()`
  (which re-syncs the server title) instead of using the pre-register
  snapshot, or boot shows stale titles.
- **Global key handling in PdfReader** must ignore events from interactive
  elements (`INPUT`/`TEXTAREA`/`SELECT`/`BUTTON`/contenteditable), otherwise
  space/arrows "steal" keystrokes from the metadata/TOC form fields.
- HMR/dev: do not run two servers on :4000 (EADDRINUSE); kill stray
  `node index.js`/`vite` processes.
- Relocating a missing file that is a *different edition* (new fingerprint)
  joins the matching edition of the same work (v5 edition binding; no new
  record for a mere re-scan of the same work).
- **Auth sessions are in-memory** (`server/auth.js` `sessions` map). Restarting
  the server signs everyone out — this is expected in dev; production will need
  a persistent session store (or signed stateless tokens). Cookie `bt_session` is
  httpOnly, `SameSite=Lax`, 30-day expiry. GitHub OAuth uses a random `state`
  with a 10-minute expiry to prevent CSRF; the callback URL must be
  `<host>/api/auth/github/callback` (in dev it routes through the Vite `/api`
  proxy on `:5173`).
- **Commits' JSON columns must be parsed server-side.** SQLite stores `pages`
  /`read_pages` as TEXT; `listCommits`/`insertCommit` must go through
  `parseCommit` (JSON.parse), or the client receives strings and
  `Object.entries(c.pages)` mangles them into per-character garbage (whole page
  heatmap shows "no time"). `parseBook` already does this for `toc`.

## Done so far (milestone 1: reading progress)

- Monorepo scaffold + Express/SQLite REST API + React/Vite/pdf.js client.
- Local PDF picking with persisted handles, missing-file detection and
  "Locate file" flow.
- Book catalog (fingerprint dedup) + editable metadata (title/author/edition)
  + TOC editor mapping pages → chapters.
- UI is GitHub-repo-style: a home/library page lists saved books; opening one
  shows the PDF viewer fullscreen with three stacked bars: the **top** bar is
  the reader toolbar (page nav, zoom, session stats, End session) rendered by
  `PdfReader` **through a React portal** into the `.reader-top` slot in
  `App.jsx` (id `reader-toolbar-slot`); the `.viewer-main` flex child holds the
  PDF canvas plus the floating `.drawer` (absolute overlay, right side — it can
  never cover the top or bottom bars); the **bottom** bar (`.viewer-top`) holds
  ← Library, title, and the Activity/Settings toggles. Settings holds metadata +
  TOC + a Danger zone (Remove Book / Remove Stats / Forget Book). `close()`
  returns to the library without deleting the handle.
- Three per-book actions: **Remove Book** (detach local handle only; server
  record + stats kept), **Remove Stats** (deletes only the commits via
  `DELETE /api/books/:id/commits`, book + local file stay), **Forget Book**
  (everything: server book + commits, local handle/meta/lastpage/thumbnail, queued
  commits, pending session). They live in the Settings drawer's Danger zone.
  **Remove Stats also invalidates the running timer**: it calls the reader's
  `resetSession()` imperative (fresh `sessionRef` + session stats zeroed) in
  addition to clearing queued commits and the IndexedDB pending session, so the
  on-screen session clock restarts at 00:00:00 and no pre-removal time is
  pushed in the current session.
- **Add-book setup wizard**: adding a new book opens `BookWizard` (page-1
  thumbnail preview, metadata, TOC with outline import) before the reader;
  Save persists and then opens the reader, and the thumbnail is cached in
  IndexedDB (`thumbnails` store) and shown on the library list. Cancel keeps
  the book attached (setup can be redone in Settings).
- Per-page dwell/word-count-threshold reading tracker with crash-safe session
  buffering and commit push at session end.
- 26-week GitHub-style reading heatmap.
- Per-page reading heatmap beside the calendar: one box per page, shade = total
  time on page, outline = passed the read threshold; day-selection filters it;
  Collapse view groups 25-page chunks; ±100/«/All range zoom handles ~1000-page
  books. Page count comes from `PdfReader` via `onPagesKnown` (falls back to
  server `page_count`).
- GitHub OAuth sign-in (`/api/auth/github` flow, `users` upsert by `github_id`,
  httpOnly `bt_session` cookie, `/api/auth/me` + logout). Reading commits now
  require being signed in: `PdfReader`'s Start session is gated on the session,
  all commit endpoints are behind `auth.requireAuth`, and the server derives the
  user from the cookie — no client-supplied identity is accepted. Book deletion
  is admin-only via the session (`user.is_admin` derived from `GITHUB_ADMIN_IDS`;
  there is deliberately no admin key/token — a client-bundled admin secret is
  extractable by anyone). Phase D replaced the boolean with a `users.role`
  (`super_admin`/`admin`/`member`) and env `GITHUB_SUPER_ADMIN_IDS` +
  `GITHUB_ADMIN_IDS`; see the Phase D contract. Sessions are in-memory (`server/auth.js` map); server
  restart signs everyone out (harmless, devs just re-login), and role
  checks re-read the live role from the DB per request.
- Bug fixes: TDZ hook order (blank page), sidebar not updating on book add,
  keyboard listener stealing form input.
- **React Router (Phase C)**: URL-based navigation via `react-router-dom`
  (`<BrowserRouter>` in `main.jsx`, `useNavigate`/`useLocation` in `App.jsx`).
  Routes: `/` library, `/user/:username` profile (**public** — works signed in
  or out; missing usernames render a "doesn't exist yet" message, no redirect),
  `/book/:slug` book info page (see below), `/read/:slug`
  reader. Landing on `/read/:slug` triggers
  auto-reconnect (with a `reconnectTriggeredRef` guard to avoid double calls);
  navigating away from a book route calls `close()`. Profile uses the GitHub
  `username` (stored in a new `users.username` column, migration v2, populated
  from `me.login` in the OAuth callback; `/api/auth/me` now returns it). A
  production SPA fallback in `server/index.js` serves `client/dist/index.html`
  for any non-`/api` GET route so browser refresh works on nested routes
  (dev refresh still flows through the Vite proxy; the fallback only matters
  when serving via the Express server).
- **Book slugs (migration v3)**: `books.slug` UNIQUE (plain column + named
  unique index, since SQLite can't `ADD COLUMN` a UNIQUE constraint). Slug
  generation lives server-side (`db.slugify`/`db.uniqueSlug`): lowercase,
  diacritics stripped, non-alphanumerics → `-`, truncated to 60 chars, `-2`/`-3`
  auto-dedupe on collision (exact lookup through the unique index — no
  probabilistic structure needed). `POST /api/books` accepts an optional `slug`
  (else derives from title); `PATCH` dedupes against other books but keeps its
  own; legacy rows are backfilled on next register. New `GET /api/book/:slug`
  resolves the catalog record — the future `/book/:slug` info-page identity
  that survives delete/reupload (content-addressed), unlike a numeric id.
  Client: `BookWizard` has an auto-suggested (live from title, editable,
  normalized on input) slug field with a `/book/…` preview; the slug is saved to
  local meta alongside `serverId` and re-persisted on any metadata save; a slug
  field was also added to the Settings drawer.
- **Slug is the single book identity; client UUID dropped.** `useLocalBook`
  no longer generates `crypto.randomUUID()` per book — picking a PDF registers
  it server-side first (`ensureRegistered` → `POST /api/books`) so the returned
  slug is known *before* the file handle is saved, and every local store
  (`handles`, `thumbnails`, `book-tracker:meta`, the saved list, the activated
  book, and the `/book/:slug` URL) is keyed by that slug. `storage.rekeyBook`
  + hook `renameBook` move all local state when a slug is edited, and a one-time
  `migrateLegacyBookKeys()` on boot re-keys any leftover UUID-keyed data. The
  wizard's Save and slug edits navigate by the *final* slug returned by the
  server (not a possibly-stale client id).
- **Book info page**: `/book/:slug` renders `BookInfo.jsx` — a minimal page
  showing title, author, edition, page count, slug, and a "Read on this device"
  button (TOC intentionally omitted for now). The PDF reader lives at
  `/read/:slug` (auto-reconnects on landing). Library items have separate
  **Open** (→ reader) and **Info** (→ info page) buttons; clicking the row
  itself also opens the reader. The `/api/book/:slug` endpoint is public (no
  auth required).
- **Home revamp (Phase C)**: the library page leads with a signed-in welcome
  line (`Welcome back, {firstName}`, admin chip) or, when logged out, a
  featured hero ("Welcome to BookTrack") whose single primary CTA signs you in
  (the header no longer shows a second sign-in button). A **Continue reading**
  card offers the most recent attached session (last page, last-session clock,
  relative time, Resume → `/read/:slug`). A **snapshot** shows today/this
  week/all-time minutes, pages and chapters (server `GET /api/me/stats`), the
  library is ordered by most recently read, and a **recent-sessions** list
  (latest 10) sits under the shelf. Signed-out visitors see the hero instead of
  a snapshot.
- **Profile page (/user/:username, public)** (Phase C): identity card plus a
  stats panel (books started, chapters done across books, reading time, longest
  consecutive reading-day streak, `Joined {month year} · N active days`), an
  **all-books reading heatmap** (reuses `Heatmap.jsx` fed with all sessions,
  day cells filter the log) and a **filterable session log** (per-book select +
  day filter from the heatmap; rows show book, end time, minutes, pages,
  chapters; "Show more" pages +50). Any visitor can view it signed in or out
  via public `GET /api/users/:username` (404 → "doesn't exist yet" state);
  the admin badge renders whenever the profile owner is admin, signed in or not.
  Data comes from `GET /api/me/stats` / the same stats computed publicly
  (returns up to the 1000 latest sessions, each with `pages`/`chapters`, plus
  `totalChapters` = distinct (book, chapter-index) pairs via each book's TOC).
  `GET /api/auth/me` also returns `created_at` for the join date.
- **Catalog hierarchy + roles (Phase D)**: migration v5 restructured the flat
  `books` table into `works` → `editions` → `fingerprints` (commits re-keyed to
  `fingerprint_id`, old `books` dropped, `foreign_keys` ON), added
  `users.role` (`super_admin`/`admin`/`member`, backfilled from `is_admin`,
  exactly-one-super-admin partial unique index, env-pinned bootstrap from
  `GITHUB_SUPER_ADMIN_IDS` when there's a vacancy). Registered:
  `POST /api/books` is role-aware (members/anonymous → pending;
  admins/super admins → immediate bind, same-edition join / new-edition /
  new-work match logic), `GET /api/books/pending`, `POST /api/books/bind/:id`,
  retire/reactivate (`DELETE` with commits → `works.retired`, zero-commit →
  hard delete; `GET /api/books/retired`, `POST /api/books/reactivate/:id`),
  super-admin role management (`GET /api/admin/users`,
  `PATCH /api/admin/users/:id/role`, `POST /api/admin/transfer`,
  `GET /api/admin/role`), `DELETE /api/me` (refused for the super admin until
  authority is transferred). Commits now optionally pin the exact fingerprint
  read. Role checks re-read the live row from the DB each request, so transfer /
  demote take effect immediately even on cached sessions. Client:
  `AdminPage.jsx` (`/admin` — pending review with Bind, retired list with
  Reactivate, super-only Users table with role select + Transfer, self
  account deletion), pending-review badge on library items / book info /
  wizard and in saved meta, admin nav link, and `api.js` now throws errors with
  their HTTP status.

## Not built yet (next steps)

- Commit-graph "git-like" timeline view (reading commits drawn as a history).
- Catalog contribution/PR review flow for TOC (public profiles themselves are already live via `GET /api/users/:username` — profiles render for any visitor signed in or out, with a 404 "doesn't exist yet" state for unknown usernames).
- Browser-extension bridge for off-platform reading.
- Smarter session thresholds; dark/light theming.
- Parked (deliberately out of scope): the exercises/code-commit feature
  (auto-detect page-named exercises from the PDF, embedded code editor, per-book
  repos). It was dropped because its OAuth/editor/repo surface would dominate
  early development for little initial value. The old `books.exercises` column
  was removed in migration v4 for the same reason; if it ever returns it should
  be a separate paginated `exercises` table, never an inline JSON column.