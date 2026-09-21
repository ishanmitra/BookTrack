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
db.pragma("foreign_keys = ON");

// Phase D (migration v5) schema: the flat `books` record became a three-level
// hierarchy — work → editions → fingerprints — where commits attach to the
// exact file (fingerprint) that was read.
db.exec(`
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT,
  title TEXT NOT NULL DEFAULT 'Untitled book',
  author TEXT NOT NULL DEFAULT 'Unknown',
  retired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_works_slug ON works(slug);

CREATE TABLE IF NOT EXISTS editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '1',
  page_count INTEGER,
  toc TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(work_id, label)
);

CREATE INDEX IF NOT EXISTS idx_editions_work ON editions(work_id);

CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE NOT NULL,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fingerprints_edition ON fingerprints(edition_id);

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint_id INTEGER NOT NULL REFERENCES fingerprints(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  minutes REAL NOT NULL DEFAULT 0,
  pages TEXT NOT NULL DEFAULT '{}',
  read_pages TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commits_user ON commits(user_id);
-- idx_commits_fp is created in the migration: a pre-v5 DB still has the old
-- commits.book_id shape until migrationV5 rebuilds it.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  username TEXT,
  github_id TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

function ensureColumn(table, column, ddl) {
  if (!tableExists(table)) return;
  const cols = db.pragma(`table_info(${table})`).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function tableExists(name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db.pragma(`table_info(${table})`).some((c) => c.name === column);
}

const SCHEMA_VERSION = 6;
function migrate() {
  const version = db.pragma("user_version", { simple: true }) || 0;
  if (version < 1) {
    ensureColumn("commits", "user_id", "user_id INTEGER REFERENCES users(id)");
    if (tableExists("commits")) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_commits_user ON commits(user_id)");
      if (columnExists("commits", "book_id")) db.exec("CREATE INDEX IF NOT EXISTS idx_commits_book ON commits(book_id)");
    }
    db.pragma(`user_version = 1`, { simple: true });
  }
  if (version < 2) {
    ensureColumn("users", "username", "username TEXT");
    db.pragma(`user_version = 2`, { simple: true });
  }
  if (version < 3) {
    // SQLite can't ADD COLUMN with a UNIQUE constraint, so use a plain
    // column + a separate unique index.
    ensureColumn("books", "slug", "slug TEXT");
    if (tableExists("books")) db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_books_slug ON books(slug)");
    db.pragma(`user_version = 3`, { simple: true });
  }
  if (version < 4) {
    // Exercises never shipped; drop the dead column entirely.
    const cols = db.pragma(`table_info(books)`).map((c) => c.name);
    if (cols.includes("exercises")) db.exec("ALTER TABLE books DROP COLUMN exercises");
    db.pragma(`user_version = 4`, { simple: true });
  }
  if (version < 5) migrationV5();
  if (version < 6) migrationV6();
}
migrate();

// v6: persistent sessions. The auth Session Map moved to the DB so sessions
// survive server restarts. The base DDL already created the table; this sets
// the version marker and any indexes for DBs that predate it.
function migrationV6() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  db.pragma(`user_version = 6`, { simple: true });
}

// The Phase D restructure, run as one transaction on startup.
function migrationV5() {
  const tx = db.transaction(() => {
    // A pre-v5 DB has the old flat `books` table; a fresh DB never creates it
    // (the DDL above is already the hierarchy), so rename it aside only when
    // it actually exists.
    if (tableExists("books")) {
      db.exec("ALTER TABLE books RENAME TO _books_v4");
    }

    // 1. users.role replaces the is_admin boolean.
    ensureColumn("users", "role", "role TEXT NOT NULL DEFAULT 'member'");
    if (columnExists("users", "is_admin")) {
      db.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND role = 'member'");
    }

    // 2. Backfill works/editions/fingerprints from the pre-v5 books table.
    if (tableExists("_books_v4")) {
      db.exec("CREATE TEMPORARY TABLE _fingerprint_map (old_book_id INTEGER PRIMARY KEY, fp_id INTEGER NOT NULL)");
      const insertMap = db.prepare("INSERT INTO _fingerprint_map (old_book_id, fp_id) VALUES (?, ?)");
      const rows = db.prepare("SELECT * FROM _books_v4 ORDER BY id").all();
      for (const b of rows) {
        let work = b.slug ? db.prepare("SELECT * FROM works WHERE slug = ?").get(b.slug) : null;
        if (!work) {
          const info = db
            .prepare("INSERT INTO works (slug, title, author, retired, created_at) VALUES (?, ?, ?, 0, ?)")
            .run(b.slug || null, b.title || "Untitled book", b.author || "Unknown", b.created_at || new Date().toISOString());
          work = db.prepare("SELECT * FROM works WHERE id = ?").get(info.lastInsertRowid);
        }
        const label = String(b.edition ?? 1);
        let edition = db.prepare("SELECT * FROM editions WHERE work_id = ? AND label = ?").get(work.id, label);
        if (!edition) {
          const info = db
            .prepare("INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(work.id, label, b.page_count ?? null, b.toc ?? "[]", b.created_at || new Date().toISOString());
          edition = db.prepare("SELECT * FROM editions WHERE id = ?").get(info.lastInsertRowid);
        }
        const info = db
          .prepare("INSERT INTO fingerprints (hash, edition_id, pending, created_at) VALUES (?, ?, 0, ?)")
          .run(b.fingerprint, edition.id, b.created_at || new Date().toISOString());
        insertMap.run(b.id, Number(info.lastInsertRowid));
      }
      db.exec("DROP TABLE _books_v4");
    }

    // 3. Re-key commits: book_id (old) -> fingerprint_id.
    if (tableExists("commits") && columnExists("commits", "book_id")) {
      const hasMap = tableExists("_fingerprint_map");
      db.exec(`
        CREATE TABLE commits_v5 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fingerprint_id INTEGER NOT NULL REFERENCES fingerprints(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          minutes REAL NOT NULL DEFAULT 0,
          pages TEXT NOT NULL DEFAULT '{}',
          read_pages TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
        INSERT INTO commits_v5 (id, fingerprint_id, user_id, session_id, device_id, started_at, ended_at, minutes, pages, read_pages, created_at)
          SELECT c.id, COALESCE(m.fp_id, -1), c.user_id, c.session_id, c.device_id,
                 c.started_at, c.ended_at, c.minutes, c.pages, c.read_pages, c.created_at
          FROM commits c LEFT JOIN _fingerprint_map m ON m.old_book_id = c.book_id;
        DROP TABLE commits;
        ALTER TABLE commits_v5 RENAME TO commits;
      `);
      // Commits whose old book had no mapped fingerprint are orphaned — drop.
      db.exec("DELETE FROM commits WHERE fingerprint_id = -1");
      db.exec("CREATE INDEX IF NOT EXISTS idx_commits_user ON commits(user_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_commits_fp ON commits(fingerprint_id)");
      if (hasMap) db.exec("DROP TABLE _fingerprint_map");
    }

    // 4. Single super-admin invariant + drop the legacy boolean.
    db.exec("CREATE INDEX IF NOT EXISTS idx_commits_fp ON commits(fingerprint_id)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_super_admin ON users(role) WHERE role='super_admin'");
    if (columnExists("users", "is_admin")) {
      db.exec("ALTER TABLE users DROP COLUMN is_admin");
    }
    db.pragma(`user_version = 5`, { simple: true });
  });
  tx();
  bootstrapSuperAdmin(superAdminIds());
}

function superAdminIds() {
  return (process.env.GITHUB_SUPER_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// If no super admin exists yet, pin the env-listed account as one (self-heal).
// After a legit transfer the DB is authoritative, so env promotion only ever
// fills a vacancy — it never overrides an existing super admin.
export function bootstrapSuperAdmin(ids = superAdminIds()) {
  if (!ids.length) return;
  const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='super_admin'").get().n;
  if (count > 0) return;
  for (const ghId of ids) {
    const u = db.prepare("SELECT * FROM users WHERE github_id = ?").get(ghId);
    if (u) {
      db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(u.id);
      return;
    }
  }
}

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

// First available version of `base` ("base", "base-2", "base-3", …) that isn't
// taken by a different work. `excludeId` lets a work keep its own slug.
export function uniqueSlug(base, excludeId = null) {
  let candidate = slugify(base);
  let n = 2;
  for (;;) {
    const row = db.prepare("SELECT id FROM works WHERE slug = ?").get(candidate);
    if (!row || (excludeId != null && row.id === excludeId)) return candidate;
    candidate = `${slugify(base)}-${n++}`;
  }
}

export function parseBook(row) {
  if (!row) return null;
  return { ...row, toc: JSON.parse(row.toc || "[]") };
}

export function parseCommit(row) {
  if (!row) return null;
  return { ...row, pages: JSON.parse(row.pages || "{}"), read_pages: JSON.parse(row.read_pages || "[]") };
}

// ── assembly: a flat, client-compatible "book" row from the hierarchy ────────

function primaryEdition(workId) {
  return (
    db.prepare("SELECT * FROM editions WHERE work_id = ? ORDER BY id ASC LIMIT 1").get(workId) || null
  );
}

function primaryFingerprint(workId) {
  return (
    db
      .prepare(
        `SELECT fp.* FROM fingerprints fp
         JOIN editions e ON e.id = fp.edition_id
         WHERE e.work_id = ? ORDER BY e.id ASC, fp.id ASC LIMIT 1`
      )
      .get(workId) || null
  );
}

function fingerprintWorkId(fpId) {
  const row = db
    .prepare(
      `SELECT e.work_id AS work_id FROM fingerprints fp
       JOIN editions e ON e.id = fp.edition_id WHERE fp.id = ?`
    )
    .get(fpId);
  return row ? row.work_id : null;
}

function assembleBook(workId, fpId = null) {
  const work = db.prepare("SELECT * FROM works WHERE id = ?").get(workId);
  if (!work) return null;
  const ed = primaryEdition(workId);
  const fp = fpId != null ? db.prepare("SELECT * FROM fingerprints WHERE id = ?").get(fpId) : primaryFingerprint(workId);
  return {
    id: work.id,
    slug: work.slug,
    title: work.title,
    author: work.author,
    edition: ed ? ed.label : null,
    page_count: ed ? ed.page_count : null,
    toc: ed ? ed.toc : "[]",
    fingerprint: fp ? fp.hash : null,
    pending: fp ? fp.pending : 0,
    retired: work.retired,
    created_at: work.created_at,
  };
}

// ── catalog ──────────────────────────────────────────────────────────────────

export function listBooks() {
  const rows = db.prepare("SELECT * FROM works WHERE retired = 0 ORDER BY title").all();
  return rows.map((w) => assembleBook(w.id));
}

export function getBook(id) {
  const work = db.prepare("SELECT * FROM works WHERE id = ?").get(id);
  if (!work || work.retired) return null;
  return assembleBook(work.id);
}

export function getBookBySlug(slug) {
  const work = db.prepare("SELECT * FROM works WHERE slug = ?").get(slug);
  if (!work || work.retired) return null;
  return assembleBook(work.id);
}

export function getWorkById(id) {
  return db.prepare("SELECT * FROM works WHERE id = ?").get(id) || null;
}

// Register a local file (fingerprint) and bind it to the hierarchy.
// - unknown fingerprint → new work + edition, or joins an existing work/edition
// - role admin/super_admin → binds immediately (pending = 0)
// - member / anonymous → stays pending until an admin binds it
// - re-registering a fingerprint of a retired work → reactivates it
export function registerBook(fingerprint, { title, author, edition, pageCount, slug, toc } = {}, role = "member") {
  const effectiveAdmin = role === "admin" || role === "super_admin";
  const label = String(edition ?? 1);
  const tocJson = JSON.stringify(Array.isArray(toc) ? toc : []);
  const fp = db.prepare("SELECT * FROM fingerprints WHERE hash = ?").get(fingerprint);

  if (fp) {
    const workId = fingerprintWorkId(fp.id);
    if (workId != null) {
      if (effectiveAdmin && fp.pending) db.prepare("UPDATE fingerprints SET pending = 0 WHERE id = ?").run(fp.id);
      db.prepare("UPDATE works SET retired = 0 WHERE id = ? AND retired = 1").run(workId);
      return assembleBook(workId, fp.id);
    }
  }

  let work = null;
  if (slug) work = db.prepare("SELECT * FROM works WHERE slug = ?").get(slugify(slug));
  if (work && work.retired) work = null;
  if (!work && !slug) {
    work = db
      .prepare("SELECT * FROM works WHERE retired = 0 AND lower(title) = lower(?) AND lower(author) = lower(?) ORDER BY id LIMIT 1")
      .get(title ?? "", author ?? "Unknown");
  }

  let editionRow;
  if (work) {
    editionRow = db.prepare("SELECT * FROM editions WHERE work_id = ? AND label = ?").get(work.id, label);
    if (!editionRow) {
      const info = db
        .prepare("INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(work.id, label, pageCount ?? null, tocJson, isoNow());
      editionRow = db.prepare("SELECT * FROM editions WHERE id = ?").get(info.lastInsertRowid);
    }
  } else {
    const workSlug = uniqueSlug(slug ? slugify(slug) : title ?? "book");
    const info = db
      .prepare("INSERT INTO works (slug, title, author, retired, created_at) VALUES (?, ?, ?, 0, ?)")
      .run(workSlug, title || "Untitled book", author || "Unknown", isoNow());
    work = db.prepare("SELECT * FROM works WHERE id = ?").get(info.lastInsertRowid);
    const edInfo = db
      .prepare("INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(work.id, label, pageCount ?? null, tocJson, isoNow());
    editionRow = db.prepare("SELECT * FROM editions WHERE id = ?").get(edInfo.lastInsertRowid);
  }

  const fpInfo = db
    .prepare("INSERT INTO fingerprints (hash, edition_id, pending, created_at) VALUES (?, ?, ?, ?)")
    .run(fingerprint, editionRow.id, effectiveAdmin ? 0 : 1, isoNow());
  return assembleBook(work.id, Number(fpInfo.lastInsertRowid));
}

export function updateBook(id, { title, author, edition, pageCount, toc, slug } = {}) {
  const work = db.prepare("SELECT * FROM works WHERE id = ?").get(id);
  if (!work) return null;
  const nextTitle = title ?? work.title;
  const nextSlug =
    slug != null && slug !== ""
      ? uniqueSlug(slugify(slug), work.id)
      : work.slug || uniqueSlug(nextTitle, work.id);
  db.prepare("UPDATE works SET title = ?, author = ?, slug = ? WHERE id = ?").run(
    nextTitle,
    author ?? work.author,
    nextSlug,
    work.id
  );
  const ed = primaryEdition(work.id);
  const nextLabel = String(edition ?? ed?.label ?? 1);
  if (ed) {
    db.prepare("UPDATE editions SET label = ?, page_count = ?, toc = ? WHERE id = ?").run(
      nextLabel,
      pageCount ?? ed.page_count,
      toc != null ? JSON.stringify(toc) : ed.toc,
      ed.id
    );
  } else {
    db.prepare("INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)").run(
      work.id,
      nextLabel,
      pageCount ?? null,
      toc != null ? JSON.stringify(toc) : "[]",
      isoNow()
    );
  }
  return assembleBook(work.id);
}

// Delete semantics: a record with commits is RETIRED (history + slug kept);
// only a zero-commit record can be hard-deleted. Returns "retired" | "deleted".
export function deleteBook(id) {
  const work = db.prepare("SELECT * FROM works WHERE id = ?").get(id);
  if (!work) return null;
  const commits = db
    .prepare(
      `SELECT COUNT(*) AS n FROM commits c
       JOIN fingerprints fp ON fp.id = c.fingerprint_id
       JOIN editions e ON e.id = fp.edition_id
       WHERE e.work_id = ?`
    )
    .get(id).n;
  if (commits > 0) {
    db.prepare("UPDATE works SET retired = 1 WHERE id = ?").run(id);
    return "retired";
  }
  db.prepare("DELETE FROM works WHERE id = ?").run(id);
  return "deleted";
}

export function listPendingFingerprints() {
  return db
    .prepare(
      `SELECT fp.id AS fingerprint_id, fp.hash, fp.edition_id, fp.created_at,
              w.id AS work_id, w.slug, w.title, w.author,
              e.label AS edition, e.page_count, e.toc
       FROM fingerprints fp
       JOIN editions e ON e.id = fp.edition_id
       JOIN works w ON w.id = e.work_id
       WHERE fp.pending = 1
       ORDER BY fp.created_at ASC`
    )
    .all()
    .map((r) => ({ ...r, toc: JSON.parse(r.toc || "[]") }));
}

export function bindFingerprint(fingerprintId, { toc, pageCount, editionLabel } = {}) {
  const fp = db.prepare("SELECT * FROM fingerprints WHERE id = ?").get(fingerprintId);
  if (!fp) return null;
  if (toc != null || pageCount != null || editionLabel != null) {
    const ed = db.prepare("SELECT * FROM editions WHERE id = ?").get(fp.edition_id);
    if (ed) {
      db.prepare("UPDATE editions SET label = ?, page_count = ?, toc = ? WHERE id = ?").run(
        editionLabel != null ? String(editionLabel) : ed.label,
        pageCount ?? ed.page_count,
        toc != null ? JSON.stringify(toc) : ed.toc,
        ed.id
      );
    }
  }
  db.prepare("UPDATE fingerprints SET pending = 0 WHERE id = ?").run(fingerprintId);
  const workId = fingerprintWorkId(fingerprintId);
  return workId != null ? assembleBook(workId, fingerprintId) : null;
}

export function listRetiredWorks() {
  return db
    .prepare("SELECT * FROM works WHERE retired = 1 ORDER BY title")
    .all()
    .map((w) => assembleBook(w.id));
}

export function reactivateWork(id) {
  const work = db.prepare("SELECT * FROM works WHERE id = ?").get(id);
  if (!work) return null;
  db.prepare("UPDATE works SET retired = 0 WHERE id = ?").run(id);
  return assembleBook(id);
}

// ── users / roles ────────────────────────────────────────────────────────────

export function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null;
}

export function getUserByUsername(username) {
  if (!username) return null;
  return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) ?? null;
}

function resolveRoleForGithub(githubId, { adminIds = [], superAdminIds = [] }) {
  if (adminIds.includes(String(githubId))) return "admin";
  if (superAdminIds.includes(String(githubId))) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='super_admin'").get().n;
    if (count === 0) return "super_admin";
  }
  return "member";
}

export function getOrCreateGithubUser({ githubId, displayName, avatarUrl, username, adminIds = [], superAdminIds = [] }) {
  const existing = db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId);
  if (existing) {
    let role = existing.role;
    if (role === "member" && adminIds.includes(String(githubId))) role = "admin";
    else if (superAdminIds.includes(String(githubId))) {
      const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='super_admin'").get().n;
      if (count === 0) role = "super_admin";
    }
    db.prepare("UPDATE users SET display_name = ?, avatar_url = ?, username = ?, role = ? WHERE id = ?").run(
      displayName ?? existing.display_name,
      avatarUrl ?? existing.avatar_url,
      username ?? existing.username,
      role,
      existing.id
    );
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
  }
  const role = resolveRoleForGithub(githubId, { adminIds, superAdminIds });
  const info = db
    .prepare("INSERT INTO users (user_key, display_name, avatar_url, username, github_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), displayName ?? null, avatarUrl ?? null, username ?? null, githubId, role, isoNow());
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

export function listUsers() {
  return db
    .prepare(
      `SELECT u.id, u.display_name, u.username, u.avatar_url, u.role, u.created_at,
              (SELECT COUNT(*) FROM commits c WHERE c.user_id = u.id) AS commit_count
       FROM users u ORDER BY u.role = 'super_admin' DESC, u.created_at ASC`
    )
    .all();
}

// Assign/revoke admin among members. The super_admin role can only change via
// transferSuperAdmin — this exits early rather than touching it.
export function setUserRole(userId, role) {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!u) return null;
  if (u.role === "super_admin" || role === "super_admin") return null;
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role === "admin" ? "admin" : "member", userId);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

export function countSuperAdmins() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='super_admin'").get().n;
}

// Swap authority: successor becomes super_admin, incumbent demotes to admin,
// in a single transaction so the "exactly one super admin" invariant holds.
export function transferSuperAdmin(fromId, toId) {
  if (fromId == null || toId == null || fromId === toId) throw new Error("invalid transfer");
  const from = db.prepare("SELECT * FROM users WHERE id = ?").get(fromId);
  const to = db.prepare("SELECT * FROM users WHERE id = ?").get(toId);
  if (!from || !to) throw new Error("user not found");
  if (from.role !== "super_admin") throw new Error("only the super admin can transfer authority");
  const tx = db.transaction(() => {
    // Demote the incumbent first — the partial unique index on
    // role='super_admin' allows only one row, so a promotion can't coexist.
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(from.id);
    db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(to.id);
  });
  tx();
  return true;
}

export function deleteUser(userId) {
  return db.prepare("DELETE FROM users WHERE id = ?").run(userId).changes > 0;
}

// ── sessions ──────────────────────────────────────────────────────────────────

export function createSession(token, userId, expiresAtMs) {
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(token, userId, expiresAtMs, isoNow());
}

export function getSession(token) {
  return db.prepare("SELECT token, user_id, expires_at FROM sessions WHERE token = ?").get(token) || null;
}

export function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function extendSession(token, expiresAtMs) {
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(expiresAtMs, token);
}

export function deleteUserSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// Opportunistic sweep — run on boot and on an interval so expired rows don't
// accumulate. One indexed DELETE regardless of table size.
export function pruneExpiredSessions(nowMs = Date.now()) {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowMs);
}

// ── commits ──────────────────────────────────────────────────────────────────

function resolveFingerprintForWork(workId, fingerprintHash) {
  if (fingerprintHash) {
    const fp = db.prepare("SELECT * FROM fingerprints WHERE hash = ?").get(fingerprintHash);
    if (fp) {
      const workIdOfFp = fingerprintWorkId(fp.id);
      if (workIdOfFp != null && workIdOfFp === workId) return fp.id;
    }
  }
  const pfp = primaryFingerprint(workId);
  return pfp ? pfp.id : null;
}

export function insertCommit(workId, { userId, sessionId, deviceId, startedAt, endedAt, minutes, pages, readPages, fingerprint }) {
  if (!userId) throw new Error("userId required");
  const fingerprintId = resolveFingerprintForWork(workId, fingerprint);
  if (fingerprintId == null) throw new Error("book has no bound fingerprint");
  const id = db
    .prepare("INSERT INTO commits (fingerprint_id, user_id, session_id, device_id, started_at, ended_at, minutes, pages, read_pages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      fingerprintId,
      userId,
      sessionId || randomUUID(),
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

export function listCommits(workId, userId) {
  if (!userId) return [];
  return db
    .prepare(
      `SELECT c.* FROM commits c
       JOIN fingerprints fp ON fp.id = c.fingerprint_id
       JOIN editions e ON e.id = fp.edition_id
       WHERE e.work_id = ? AND c.user_id = ?
       ORDER BY c.ended_at`
    )
    .all(workId, userId)
    .map(parseCommit);
}

export function deleteBookCommits(workId, userId) {
  if (!userId) return 0;
  return db
    .prepare(
      `DELETE FROM commits WHERE user_id = ? AND fingerprint_id IN (
         SELECT fp.id FROM fingerprints fp JOIN editions e ON e.id = fp.edition_id WHERE e.work_id = ?
       )`
    )
    .run(userId, workId).changes;
}

function listUserCommits(userId) {
  return db
    .prepare(
      `SELECT c.*, w.id AS book_id, w.title AS book_title, w.slug AS book_slug,
              fp.hash AS book_fingerprint, e.toc AS book_toc
       FROM commits c
       JOIN fingerprints fp ON fp.id = c.fingerprint_id
       JOIN editions e ON e.id = fp.edition_id
       JOIN works w ON w.id = e.work_id
       WHERE c.user_id = ?
       ORDER BY c.ended_at DESC`
    )
    .all(userId);
}

function chapterIndexes(readPages, toc) {
  const starts = (toc || []).map((t) => Number(t.startPage) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  const idx = new Set();
  if (!starts.length) return idx;
  for (const p of readPages || []) {
    const n = Number(p) || 0;
    if (!n) continue;
    let i = starts.length - 1;
    while (i >= 0 && starts[i] > n) i--;
    if (i >= 0) idx.add(i);
  }
  return idx;
}

const parseToc = (raw) => {
  try {
    return JSON.parse(raw || "[]") || [];
  } catch {
    return [];
  }
};

export function getUserStats(userId) {
  if (!userId) return null;
  const rows = listUserCommits(userId);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  let today = { minutes: 0, pages: 0, chapters: 0 };
  let week = { minutes: 0, pages: 0, chapters: 0 };
  let totalMinutes = 0;
  let totalChapters = 0;
  const perBookChapters = new Map();
  const byBook = new Map();
  const sessions = [];
  for (const r of rows) {
    const c = parseCommit(r);
    const toc = parseToc(r.book_toc);
    const started = Date.parse(c.started_at) || now.getTime();
    const mins = Number(c.minutes) || 0;
    const pages = Array.isArray(c.read_pages) ? c.read_pages.length : 0;
    const chapterIdx = chapterIndexes(c.read_pages, toc);
    let bookChapters = perBookChapters.get(c.book_id);
    if (!bookChapters) { bookChapters = new Set(); perBookChapters.set(c.book_id, bookChapters); }
    for (const ci of chapterIdx) bookChapters.add(ci);
    totalMinutes += mins;
    if (started >= startOfToday) {
      today.minutes += mins;
      today.pages += pages;
      today.chapters += chapterIdx.size;
    }
    if (started >= startOfWeek) {
      week.minutes += mins;
      week.pages += pages;
      week.chapters += chapterIdx.size;
    }
    if (!byBook.has(c.book_id)) {
      byBook.set(c.book_id, { book_id: c.book_id, slug: r.book_slug ?? null, title: r.book_title ?? null, fingerprint: r.book_fingerprint ?? null, minutes: 0, sessions: 0, last_read_at: null });
    }
    const row = byBook.get(c.book_id);
    row.minutes += mins;
    row.sessions += 1;
    if (!row.last_read_at || c.ended_at > row.last_read_at) row.last_read_at = c.ended_at;
    const chapterEntries = [...chapterIdx]
      .sort((a, b) => a - b)
      .map((i) => ({
        i,
        title: (toc[i] && toc[i].title ? toc[i].title : `Chapter ${i + 1}`).replace(/^\s+/, "").trim(),
      }));
    sessions.push({
      id: c.id,
      book_id: c.book_id,
      slug: r.book_slug ?? null,
      title: r.book_title ?? null,
      fingerprint: r.book_fingerprint ?? null,
      started_at: c.started_at,
      ended_at: c.ended_at,
      minutes: mins,
      pages: pages,
      chapters: chapterIdx.size,
      chapterEntries,
      read_pages: c.read_pages || [],
    });
  }
  for (const s of perBookChapters.values()) totalChapters += s.size;
  const round = (n) => Math.round(n * 10) / 10;
  today.minutes = round(today.minutes);
  week.minutes = round(week.minutes);
  return {
    today,
    week,
    totalMinutes: round(totalMinutes),
    totalChapters,
    books: [...byBook.values()],
    sessions: sessions.slice(0, 1000),
  };
}