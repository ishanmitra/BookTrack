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
  exercises, latest edition), edited via a PR-like review/change flow.
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

Server (SQLite, `server/../data/reader.db`):
- `books(id, fingerprint UNIQUE, title, author, edition, page_count, toc JSON, exercises JSON, slug UNIQUE, created_at)`
- `commits(id, book_id, session_id, device_id, started_at, ended_at, minutes, pages JSON {page:secs}, read_pages JSON [n], created_at)`

Client (IndexedDB `book-tracker`):
- `handles` — persisted FileSystemFileHandle per bookId (reconnects file in later sessions)
- `queue` — commits pending push (key = sessionId)
- `sessions` — current in-progress session snapshot (crash recovery)
- `thumbnails` — page-1 cover previews (key = bookId, value `{bookId, dataUrl}`), shown on home library items
LocalStorage: `book-tracker:meta` (bookId → {title, fingerprint, fileKey, serverId}),
`book-tracker:device` (deviceId UUID). Identity is NOT stored locally — it comes
from the server's `bt_session` cookie via `GET /api/auth/me`.

## API

- `GET /api/books`, `GET /api/books/:id`, `GET /api/book/:slug`
- `POST /api/books` `{fingerprint, title?, author?, pageCount?, slug?}` — upsert by fingerprint. Slug is slugified (lowercase, dashes) and auto-deduped (`-2`, `-3`, …) against a UNIQUE index; if omitted it's derived from the title. Existing rows missing a slug get backfilled.
- `PATCH /api/books/:id` `{title?, author?, edition?, pageCount?, toc?, exercises?, slug?}` — a provided slug is deduped against other books; `null`/empty keeps/regenerates the current one
- `DELETE /api/books/:id` — removes the book + its commits (`ON DELETE CASCADE`); admin session user only (`is_admin`)
- `DELETE /api/books/:id/commits` — removes **your own** commits (stats) for a book
- `POST /api/books/:id/commits` `{sessionId?, deviceId, startedAt, endedAt, secondsPerPage, readPages}` — authenticated session required
- `GET /api/books/:id/commits` — your own commits only
- `GET /api/auth/github` — redirect to GitHub authorize (client_id, scope `read:user`, random `state`)
- `GET /api/auth/github/callback` — exchange code → upsert `users` by `github_id` → set httpOnly `bt_session` cookie → redirect
- `GET /api/auth/me` → `{user: {id, display_name, username, avatar_url, is_admin} | null}`
- `POST /api/auth/logout`
- Optional `API_KEY`: when set, every `/api` request must send the matching `x-api-key` header.
- **Commits are never anonymous:** every commit endpoint is behind `auth.requireAuth`; the user is derived from the session cookie, and any client-declared identity is ignored. `PdfReader`'s Start session is gated on being signed in.

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
- **Metadata saves must also write localStorage, keyed by the CLIENT book id.**
  The client uses two separate ids: the client UUID (`active.bookId`, key for
  `handles`/localStorage meta/saved list/thumbs) and the SQLite row id
  (`active.book.id` / `meta.serverId`, used for every `/api/books/:id` call).
  `App.saveMeta` therefore performs the API update with `active.book.id` and
  then calls `persistSavedMeta(active.bookId, …)` (`storage.saveMetaFor` + a
  `setSavedEntry` re-read) under the **client** id only. Passing the server id
  to `persistSavedMeta` breaks both ways at once: the real entry's title never
  updates (meta lives under an id the list doesn't render) *and* `setSavedEntry`
  appends a ghost entry (server id has no book handle) that vanishes on refresh
  (boot list is built from handle keys only). `restore()` must also re-read
  local meta *after* `register()` (which re-syncs the server title) instead of
  using the pre-register snapshot, or boot shows stale titles.
- **Global key handling in PdfReader** must ignore events from interactive
  elements (`INPUT`/`TEXTAREA`/`SELECT`/`BUTTON`/contenteditable), otherwise
  space/arrows "steal" keystrokes from the metadata/TOC form fields.
- HMR/dev: do not run two servers on :4000 (EADDRINUSE); kill stray
  `node index.js`/`vite` processes.
- Relocating a missing file that is a *different edition* (new fingerprint)
  creates a new catalog record; the old record remains.
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
  heatmap shows "no time"). `parseBook` already does this for `toc`/`exercises`.

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
  extractable by anyone). Sessions are in-memory (`server/auth.js` map); server
  restart signs everyone out (harmless, devs just re-login).
- Bug fixes: TDZ hook order (blank page), sidebar not updating on book add,
  keyboard listener stealing form input.
- **React Router (Phase C)**: URL-based navigation via `react-router-dom`
  (`<BrowserRouter>` in `main.jsx`, `useNavigate`/`useLocation` in `App.jsx`).
  Routes: `/` library, `/user/:username` profile (self only for now; others
  redirect home), `/book/:bookKey` reader. Landing on `/book/:bookKey` triggers
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

## Not built yet (next steps)

- Exercise metadata (auto-detect from PDF text; lazy add while reading) and the
  exercise list in the UI.
- Code committing for exercises: embedded editor (CodeMirror/Monaco) + commits,
  and/or GitHub OAuth sync; per-book repos.
- Commit-graph "git-like" timeline view (reading + code commits together).
- Auth / multi-user; the catalog contribution/PR review flow for TOC/exercises.
- Browser-extension bridge for off-platform reading.
- Cross-edition dedup policy; smarter session thresholds; dark/light theming.