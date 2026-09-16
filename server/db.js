import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "reader.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled book',
  author TEXT NOT NULL DEFAULT 'Unknown',
  edition INTEGER NOT NULL DEFAULT 1,
  page_count INTEGER,
  toc TEXT NOT NULL DEFAULT '[]',
  exercises TEXT NOT NULL DEFAULT '[]',
  slug TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  minutes REAL NOT NULL DEFAULT 0,
  pages TEXT NOT NULL DEFAULT '{}',
  read_pages TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  username TEXT,
  github_id TEXT UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

function ensureColumn(table, column, ddl) {
  const cols = db.pragma(`table_info(${table})`).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

const SCHEMA_VERSION = 3;
function migrate() {
  const version = db.pragma("user_version", { simple: true }) || 0;
  if (version < 1) {
    ensureColumn("commits", "user_id", "user_id INTEGER REFERENCES users(id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_commits_user ON commits(user_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_commits_book ON commits(book_id)");
    db.pragma(`user_version = 1`, { simple: true });
  }
  if (version < 2) {
    ensureColumn("users", "username", "username TEXT");
    db.pragma(`user_version = 2`, { simple: true });
  }
  if (version < 3) {
    // SQLite can't ADD COLUMN with a UNIQUE constraint, so use a plain
    // column + a separate unique index (NULLs are distinct, so all existing
    // rows pass as-is).
    ensureColumn("books", "slug", "slug TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_books_slug ON books(slug)");
    db.pragma(`user_version = 3`, { simple: true });
  }
}
migrate();

db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_books_slug ON books(slug)");

const q = {
  listBooks: db.prepare("SELECT * FROM books ORDER BY title"),
  getBook: db.prepare("SELECT * FROM books WHERE id = ?"),
  getByFingerprint: db.prepare("SELECT * FROM books WHERE fingerprint = ?"),
  getBookBySlug: db.prepare("SELECT * FROM books WHERE slug = ?"),
  insertBook: db.prepare(
    `INSERT INTO books (fingerprint, title, author, page_count, slug, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  updateBook: db.prepare(
    `UPDATE books SET title = ?, author = ?, edition = ?, page_count = ?, toc = ?, exercises = ?, slug = ?
     WHERE id = ?`
  ),
  insertCommit: db.prepare(
    `INSERT INTO commits (book_id, user_id, session_id, device_id, started_at, ended_at, minutes, pages, read_pages, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  listCommitsForUser: db.prepare("SELECT * FROM commits WHERE book_id = ? AND user_id = ? ORDER BY ended_at"),
  deleteCommitsForUser: db.prepare("DELETE FROM commits WHERE book_id = ? AND user_id = ?"),
  getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  getUserByGithubId: db.prepare("SELECT * FROM users WHERE github_id = ?"),
  insertGithubUser: db.prepare(
    "INSERT INTO users (user_key, display_name, avatar_url, username, github_id, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  updateGithubUser: db.prepare("UPDATE users SET display_name = ?, avatar_url = ?, username = ?, is_admin = ? WHERE id = ?"),
  deleteBook: db.prepare("DELETE FROM books WHERE id = ?"),
};

export const isoNow = () => new Date().toISOString();

export function slugify(str = "") {
  return (
    str
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "book"
  );
}

// Returns the first available version of `base` ("base", "base-2", "base-3", …)
// that isn't taken by a different book. Exact lookup via the UNIQUE index —
// no probabilistic structure needed at this scale. `excludeId` lets a book
// keep its own slug when updating.
export function uniqueSlug(base, excludeId = null) {
  let candidate = slugify(base);
  let n = 2;
  for (;;) {
    const row = q.getBookBySlug.get(candidate);
    if (!row || (excludeId != null && row.id === excludeId)) return candidate;
    candidate = `${slugify(base)}-${n++}`;
  }
}

export function parseBook(row) {
  if (!row) return null;
  return { ...row, toc: JSON.parse(row.toc), exercises: JSON.parse(row.exercises) };
}

export function parseCommit(row) {
  if (!row) return null;
  return { ...row, pages: JSON.parse(row.pages || "{}"), read_pages: JSON.parse(row.read_pages || "[]") };
}

export function listBooks() {
  return q.listBooks.all();
}

export function getBook(id) {
  return q.getBook.get(id);
}

export function getBookBySlug(slug) {
  return q.getBookBySlug.get(slug);
}

export function getBookByFingerprint(fingerprint) {
  return q.getByFingerprint.get(fingerprint);
}

export function upsertBook(fingerprint, { title, author, pageCount, slug } = {}) {
  const existing = q.getByFingerprint.get(fingerprint);
  const nextSlug = (given) => (given ? uniqueSlug(slugify(given)) : uniqueSlug(title ?? "book"));
  if (existing) {
    if (!existing.slug) {
      // Backfill a slug for rows created before migration v3.
      const backfill = slug ? uniqueSlug(slugify(slug), existing.id) : uniqueSlug(title ?? existing.title, existing.id);
      q.updateBook.run(existing.title, existing.author, existing.edition, existing.page_count, existing.toc, existing.exercises, backfill, existing.id);
      return q.getBook.get(existing.id);
    }
    if (pageCount != null && existing.page_count == null) {
      q.updateBook.run(existing.title, existing.author, existing.edition, pageCount, existing.toc, existing.exercises, existing.slug, existing.id);
      return q.getBook.get(existing.id);
    }
    return existing;
  }
  const info = q.insertBook.run(
    fingerprint,
    title || "Untitled book",
    author || "Unknown",
    pageCount ?? null,
    nextSlug(slug),
    isoNow()
  );
  return q.getBook.get(info.lastInsertRowid);
}

export function updateBook(id, { title, author, edition, pageCount, toc, exercises, slug } = {}) {
  const existing = q.getBook.get(id);
  if (!existing) return null;
  const nextTitle = title ?? existing.title;
  const nextSlug =
    slug != null && slug !== ""
      ? uniqueSlug(slugify(slug), existing.id)
      : existing.slug || uniqueSlug(nextTitle, existing.id);
  q.updateBook.run(
    nextTitle,
    author ?? existing.author,
    edition ?? existing.edition,
    pageCount ?? existing.page_count,
    toc != null ? JSON.stringify(toc) : existing.toc,
    exercises != null ? JSON.stringify(exercises) : existing.exercises,
    nextSlug,
    id
  );
  return q.getBook.get(id);
}

export function deleteBook(id) {
  return q.deleteBook.run(id).changes > 0;
}

export function getUserById(id) {
  return q.getUserById.get(id) ?? null;
}

export function getOrCreateGithubUser({ githubId, displayName, avatarUrl, username, isAdmin }) {
  const existing = q.getUserByGithubId.get(githubId);
  if (existing) {
    q.updateGithubUser.run(
      displayName ?? existing.display_name,
      avatarUrl ?? existing.avatar_url,
      username ?? existing.username,
      isAdmin ? 1 : 0,
      existing.id
    );
    return q.getUserById.get(existing.id);
  }
  const info = q.insertGithubUser.run(
    randomUUID(),
    displayName ?? null,
    avatarUrl ?? null,
    username ?? null,
    githubId,
    isAdmin ? 1 : 0,
    isoNow()
  );
  return q.getUserById.get(info.lastInsertRowid);
}

export function insertCommit(bookId, { userId, sessionId, deviceId, startedAt, endedAt, minutes, pages, readPages }) {
  if (!userId) throw new Error("userId required");
  const id = q.insertCommit.run(
    bookId,
    userId,
    sessionId,
    deviceId,
    startedAt,
    endedAt,
    minutes,
    pages ?? "{}",
    readPages ?? "[]",
    isoNow()
  ).lastInsertRowid;
  return parseCommit(db.prepare("SELECT * FROM commits WHERE id = ?").get(id));
}

export function listCommits(bookId, userId) {
  if (!userId) return [];
  return q.listCommitsForUser.all(bookId, userId).map(parseCommit);
}

export function deleteBookCommits(bookId, userId) {
  if (!userId) return 0;
  return q.deleteCommitsForUser.run(bookId, userId).changes;
}