# BookTrack

A GitHub-like platform for tracking reading and coding progress through technical programming books.

![Status: work in progress](https://img.shields.io/badge/status-Work%20in%20progress-yellow)
![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen?logo=github)
![License](https://img.shields.io/github/license/ishanmitra/BookTrack)
![Top language](https://img.shields.io/github/languages/top/ishanmitra/BookTrack)

![Node.js 18+](https://img.shields.io/badge/Node.js%2018%2B-339933?logo=nodedotjs&logoColor=fff)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=000)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=fff)
![libSQL/SQLite · Turso](https://img.shields.io/badge/libSQL%2FSQLite--Turso-003B57?logo=sqlite&logoColor=fff)

## What is it?

BookTrack tracks how you actually read technical books. Reading sessions are modeled like **git commits**: each session records pages read, minutes, and per-page dwell time, which roll up into contribution heatmaps, streaks, and chapter progress bars — GitHub-style, but for learning.

**Local-first by design:**

- **PDFs never leave your device.** Files are opened locally (File System Access API); only a SHA-256 fingerprint (first ~1 MB) and reading metrics reach the server — paid books are never redistributed.
- The catalog is a **shared, fingerprint-keyed record**: the same book scanned by a thousand readers dedupes to one canonical entry with an editable chapters/TOC. Commits are written against the exact fingerprint you read.
- Reading tracking is **client-first**: events buffer in IndexedDB, a session commits at end-of-session, then flushes on reconnect. Crash-safe.

## Key features

- Local PDF reader with continuous scroll, text selection, and link annotations
- Git-style session commits (time, pages, per-page heat) + chapter progress
- GitHub-style contribution heatmaps (week + per-page) and activity timeline
- Public reader profiles and a searchable library
- Community-curated book catalog: works → editions → fingerprints with an admin bind/review flow
- GitHub OAuth sign-in with a role model (member / admin / super admin)

## Roadmap

**Phase 1 — Launch**
- Deploy to Render + Turso (free tier) via the included `render.yaml`
- Stats hardening: server-side streaks and keyset pagination beyond 1,000 sessions
- Broader OAuth providers; an `<input type=file>` fallback for browsers without the File System Access API

**Phase 2 — Cross-platform**
- Browser-extension bridge for reading off-platform
- Native iOS/Android apps; lift the per-device id into a server-side device registry for sync
- Direct page-chapter attribution improvements

**Phase 3 — Community & ecosystem**
- Git-like commit-graph history timeline
- Public API for integrations
- PR-style contribution flow for catalog/TOC edits
- Reading streaks, better session thresholds, dark/light theming

## Contributing

BookTrack is **WIP and single-maintainer** — the API and UI can and will shift. All contributions are welcome: bug reports, feature ideas, and PRs.

Pick an item from the **Roadmap** or an open issue — good targets are clearly-scoped bugs and the phase ideas above.

### Running the project locally

```bash
npm install        # installs server + client (workspaces)
npm run dev        # server :4000 + client :5173 (vite proxies /api -> :4000)
```

No database setup needed — the server auto-creates and migrates `data/reader.db` (the local SQLite/libSQL engine) on first boot. `data/` is git-ignored.

**Optional env**: copy `server/.env.example` → `server/.env`. Set `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (+ your id in `GITHUB_SUPER_ADMIN_IDS`) to enable sign-in and become super admin locally. Without OAuth everything works read-only. Set `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` to point at a Turso/remote DB instead of the local file.

### Opening a PR

- License is MIT (see [`LICENSE`](LICENSE)).
- Verify with `npm run build` before opening a PR (there is no test suite yet); smoke-test in a Chromium browser.

## License

[MIT](LICENSE) © 2026 Ishan Mitra