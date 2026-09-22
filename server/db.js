import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

// Direct libSQL driver. Locally it points at the on-disk DB (file: URL via the
// embedded engine); with TURSO_DATABASE_URL set it talks to a Turso (or any
// libsql-server) database. TURSO_AUTH_TOKEN only applies to remote URLs.
const dbUrl = process.env.TURSO_DATABASE_URL || `file:${path.join(dataDir, "reader.db")}`;
const client = createClient({
  url: dbUrl,
  ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
});

// ── tiny statement helpers ────────────────────────────────────────────────
// @libsql/client returns rows as plain objects on the embedded (file:) client
// and as arrays on the Hrana (remote) client. toObjs normalizes both.

function toObjs(res) {
  const cols = res.columns;
  return res.rows.map((row) => {
    if (row && !Array.isArray(row)) return row;
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = row[i];
    return o;
  });
}

async function _exec(exec, sql, args = []) {
  const res = await exec.execute({ sql, args });
  return {
    columns: res.columns ?? [],
    rows: res.rows ?? [],
    rowsAffected: Number(res.rowsAffected ?? 0),
    lastInsertRowid: res.lastInsertRowid == null ? 0 : Number(res.lastInsertRowid),
  };
}

// Accept either `fn(sql, a, b, c)` or `fn(sql, [a, b, c])` — better-sqlite3
// call sites used both, so normalize varargs to a flat parameter array.
function normalizeArgs(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

const get = (sql, ...args) => _exec(client, sql, normalizeArgs(args)).then((res) => toObjs(res)[0] ?? null);
const all = (sql, ...args) => _exec(client, sql, normalizeArgs(args)).then((res) => toObjs(res));
const run = (sql, ...args) => _exec(client, sql, normalizeArgs(args));

const execMulti = (sql) => client.executeMultiple(sql);

// Runs `sql` against `exec`, which is either `client` or an open transaction.
// Inside a transaction executeMultiple isn't available, so callers pass a
// single-statement SQL per _execFor when that matters. execMulti stays
// client-only for the big idempotent DDL blocks.
const _getFor = (exec, sql, args) => _exec(exec, sql, args).then((res) => toObjs(res)[0] ?? null);
const _allFor = (exec, sql, args) => _exec(exec, sql, args).then((res) => toObjs(res));
const _runFor = (exec, sql, args) => _exec(exec, sql, args);

// Best-effort connection pragmas. WAL/local options make no sense on a remote
// Turso DB and are ignored there; foreign_keys is enforced server-side on
// Turso, and locally these make the cascade deletes behave.
try {
  await client.execute({ sql: "PRAGMA journal_mode = WAL", args: [] });
} catch {}
try {
  await client.execute({ sql: "PRAGMA foreign_keys = ON", args: [] });
} catch {}

// Phase D (migration v5) schema: the flat `books` record became a three-level
// hierarchy — work → editions → fingerprints — where commits attach to the
// exact file (fingerprint) that was read.
await execMulti(`
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

async function tableInfo(table) {
  return all(`PRAGMA table_info(${table})`);
}

async function ensureColumn(table, column, ddl) {
  if (!(await tableExists(table))) return;
  const cols = (await tableInfo(table)).map((c) => c.name);
  if (!cols.includes(column)) await client.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${ddl}`, args: [] });
}

function tableExists(name) {
  return get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name).then((r) => r != null);
}

async function columnExists(table, column) {
  if (!(await tableExists(table))) return false;
  return (await tableInfo(table)).some((c) => c.name === column);
}

const SCHEMA_VERSION = 6;
async function migrate() {
  const res = await _exec(client, "PRAGMA user_version", []);
  let version = Number(res.rows[0]?.[0] ?? res.rows[0]?.user_version ?? 0) || 0;
  if (version < 1) {
    await ensureColumn("commits", "user_id", "user_id INTEGER REFERENCES users(id)");
    if (await tableExists("commits")) {
      await execMulti("CREATE INDEX IF NOT EXISTS idx_commits_user ON commits(user_id)");
      if (await columnExists("commits", "book_id")) await execMulti("CREATE INDEX IF NOT EXISTS idx_commits_book ON commits(book_id)");
    }
    await execMulti(`PRAGMA user_version = 1`);
  }
  if (version < 2) {
    await ensureColumn("users", "username", "username TEXT");
    await execMulti(`PRAGMA user_version = 2`);
  }
  if (version < 3) {
    // SQLite can't ADD COLUMN with a UNIQUE constraint, so use a plain
    // column + a separate unique index.
    await ensureColumn("books", "slug", "slug TEXT");
    if (await tableExists("books")) await execMulti("CREATE UNIQUE INDEX IF NOT EXISTS idx_books_slug ON books(slug)");
    await execMulti(`PRAGMA user_version = 3`);
  }
  if (version < 4) {
    // Exercises never shipped; drop the dead column entirely.
    if (await tableExists("books")) {
      const cols = (await tableInfo("books")).map((c) => c.name);
      if (cols.includes("exercises")) await client.execute({ sql: "ALTER TABLE books DROP COLUMN exercises", args: [] });
    }
    await execMulti(`PRAGMA user_version = 4`);
  }
  if (version < 5) await migrationV5();
  if (version < 6) await migrationV6();
}
await migrate();

// v6: persistent sessions. The auth Session Map moved to the DB so sessions
// survive server restarts. The base DDL already created the table; this sets
// the version marker and any indexes for DBs that predate it.
async function migrationV6() {
  await execMulti(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  await execMulti(`PRAGMA user_version = 6`);
}

// The Phase D restructure. Run on startup for pre-v5 DBs; a fresh DB already
// has the hierarchy, so the legacy backfill paths below are all no-ops.
async function migrationV5() {
  // A pre-v5 DB has the old flat `books` table; a fresh DB never creates it
  // (the DDL above is already the hierarchy), so rename it aside only when
  // it actually exists.
  if (await tableExists("books")) {
    await execMulti("ALTER TABLE books RENAME TO _books_v4");
  }

  // 1. users.role replaces the is_admin boolean.
  await ensureColumn("users", "role", "role TEXT NOT NULL DEFAULT 'member'");
  if (await columnExists("users", "is_admin")) {
    await client.execute({ sql: "UPDATE users SET role = 'admin' WHERE is_admin = 1 AND role = 'member'", args: [] });
  }

  // 2. Backfill works/editions/fingerprints from the pre-v5 books table.
  if (await tableExists("_books_v4")) {
    await execMulti("CREATE TEMPORARY TABLE _fingerprint_map (old_book_id INTEGER PRIMARY KEY, fp_id INTEGER NOT NULL)");
    const rows = await _allFor(client, "SELECT * FROM _books_v4 ORDER BY id", []);
    for (const b of rows) {
      let work = b.slug ? await _getFor(client, "SELECT * FROM works WHERE slug = ?", [b.slug]) : null;
      if (!work) {
        const info = await _runFor(client, "INSERT INTO works (slug, title, author, retired, created_at) VALUES (?, ?, ?, 0, ?)", [
          b.slug || null,
          b.title || "Untitled book",
          b.author || "Unknown",
          b.created_at || new Date().toISOString(),
        ]);
        work = await _getFor(client, "SELECT * FROM works WHERE id = ?", [info.lastInsertRowid]);
      }
      const label = String(b.edition ?? 1);
      let edition = await _getFor(client, "SELECT * FROM editions WHERE work_id = ? AND label = ?", [work.id, label]);
      if (!edition) {
        const info = await _runFor(client, "INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)", [
          work.id,
          label,
          b.page_count ?? null,
          b.toc ?? "[]",
          b.created_at || new Date().toISOString(),
        ]);
        edition = await _getFor(client, "SELECT * FROM editions WHERE id = ?", [info.lastInsertRowid]);
      }
      const info = await _runFor(client, "INSERT INTO fingerprints (hash, edition_id, pending, created_at) VALUES (?, ?, 0, ?)", [
        b.fingerprint,
        edition.id,
        b.created_at || new Date().toISOString(),
      ]);
      await _runFor(client, "INSERT INTO _fingerprint_map (old_book_id, fp_id) VALUES (?, ?)", [b.id, Number(info.lastInsertRowid)]);
    }
    await execMulti("DROP TABLE _books_v4");
  }

  // 3. Re-key commits: book_id (old) -> fingerprint_id.
  if ((await tableExists("commits")) && (await columnExists("commits", "book_id"))) {
    const hasMap = await tableExists("_fingerprint_map");
    await execMulti(`
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
    await client.execute({ sql: "DELETE FROM commits WHERE fingerprint_id = -1", args: [] });
    await execMulti("CREATE INDEX IF NOT EXISTS idx_commits_user ON commits(user_id)");
    await execMulti("CREATE INDEX IF NOT EXISTS idx_commits_fp ON commits(fingerprint_id)");
    if (hasMap) await execMulti("DROP TABLE _fingerprint_map");
  }

  // 4. Single super-admin invariant + drop the legacy boolean.
  await execMulti("CREATE INDEX IF NOT EXISTS idx_commits_fp ON commits(fingerprint_id)");
  await execMulti("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_super_admin ON users(role) WHERE role='super_admin'");
  if (await columnExists("users", "is_admin")) {
    await client.execute({ sql: "ALTER TABLE users DROP COLUMN is_admin", args: [] });
  }
  await execMulti(`PRAGMA user_version = 5`);
  await bootstrapSuperAdmin(superAdminIds());
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
export async function bootstrapSuperAdmin(ids = superAdminIds()) {
  if (!ids.length) return;
  const count = (await get("SELECT COUNT(*) AS n FROM users WHERE role='super_admin'")).n;
  if (count > 0) return;
  for (const ghId of ids) {
    const u = await get("SELECT * FROM users WHERE github_id = ?", ghId);
    if (u) {
      await run("UPDATE users SET role = 'super_admin' WHERE id = ?", u.id);
      return;
    }
  }
}

// Runs `fn(tx)` inside a write transaction when the connection supports it
// (remote Turso and the embedded client do; fall back to plain sequential
// execution otherwise). Commits on success, rolls back on throw.
async function withTx(fn) {
  let tx;
  try {
    tx = await client.transaction("write");
  } catch {
    return await fn(client);
  }
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {}
    throw err;
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
export async function uniqueSlug(base, excludeId = null) {
  let candidate = slugify(base);
  let n = 2;
  for (;;) {
    const row = await get("SELECT id FROM works WHERE slug = ?", candidate);
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
  return get("SELECT * FROM editions WHERE work_id = ? ORDER BY id ASC LIMIT 1", workId);
}

function primaryFingerprint(workId) {
  return get(
    `SELECT fp.* FROM fingerprints fp
     JOIN editions e ON e.id = fp.edition_id
     WHERE e.work_id = ? ORDER BY e.id ASC, fp.id ASC LIMIT 1`,
    workId
  );
}

function fingerprintWorkId(fpId) {
  return get(
    `SELECT e.work_id AS work_id FROM fingerprints fp
     JOIN editions e ON e.id = fp.edition_id WHERE fp.id = ?`,
    fpId
  );
}

async function assembleBook(workId, fpId = null) {
  const work = await get("SELECT * FROM works WHERE id = ?", workId);
  if (!work) return null;
  const ed = await primaryEdition(workId);
  const fp = fpId != null ? await get("SELECT * FROM fingerprints WHERE id = ?", fpId) : await primaryFingerprint(workId);
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

export async function listBooks() {
  const rows = await all("SELECT * FROM works WHERE retired = 0 ORDER BY title");
  const out = [];
  for (const w of rows) out.push(await assembleBook(w.id));
  return out;
}

export async function getBook(id) {
  const work = await get("SELECT * FROM works WHERE id = ?", id);
  if (!work || work.retired) return null;
  return assembleBook(work.id);
}

export async function getBookBySlug(slug) {
  const work = await get("SELECT * FROM works WHERE slug = ?", slug);
  if (!work || work.retired) return null;
  return assembleBook(work.id);
}

export async function getWorkById(id) {
  return (await get("SELECT * FROM works WHERE id = ?", id)) || null;
}

// Register a local file (fingerprint) and bind it to the hierarchy.
// - unknown fingerprint → new work + edition, or joins an existing work/edition
// - role admin/super_admin → binds immediately (pending = 0)
// - member / anonymous → stays pending until an admin binds it
// - re-registering a fingerprint of a retired work → reactivates it
export async function registerBook(fingerprint, { title, author, edition, pageCount, slug, toc } = {}, role = "member") {
  const effectiveAdmin = role === "admin" || role === "super_admin";
  const label = String(edition ?? 1);
  const tocJson = JSON.stringify(Array.isArray(toc) ? toc : []);
  const fp = await get("SELECT * FROM fingerprints WHERE hash = ?", fingerprint);

  if (fp) {
    const workId = (await fingerprintWorkId(fp.id))?.work_id;
    if (workId != null) {
      if (effectiveAdmin && fp.pending) await run("UPDATE fingerprints SET pending = 0 WHERE id = ?", fp.id);
      await run("UPDATE works SET retired = 0 WHERE id = ? AND retired = 1", workId);
      return assembleBook(workId, fp.id);
    }
  }

  let work = null;
  if (slug) work = await get("SELECT * FROM works WHERE slug = ?", slugify(slug));
  if (work && work.retired) work = null;
  if (!work && !slug) {
    work = await get(
      "SELECT * FROM works WHERE retired = 0 AND lower(title) = lower(?) AND lower(author) = lower(?) ORDER BY id LIMIT 1",
      title ?? "",
      author ?? "Unknown"
    );
  }

  let editionRow;
  if (work) {
    editionRow = await get("SELECT * FROM editions WHERE work_id = ? AND label = ?", work.id, label);
    if (!editionRow) {
      const info = await run("INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)", [
        work.id,
        label,
        pageCount ?? null,
        tocJson,
        isoNow(),
      ]);
      editionRow = await get("SELECT * FROM editions WHERE id = ?", info.lastInsertRowid);
    }
  } else {
    const workSlug = await uniqueSlug(slug ? slugify(slug) : title ?? "book");
    const info = await run("INSERT INTO works (slug, title, author, retired, created_at) VALUES (?, ?, ?, 0, ?)", [
      workSlug,
      title || "Untitled book",
      author || "Unknown",
      isoNow(),
    ]);
    work = await get("SELECT * FROM works WHERE id = ?", info.lastInsertRowid);
    const edInfo = await run("INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)", [
      work.id,
      label,
      pageCount ?? null,
      tocJson,
      isoNow(),
    ]);
    editionRow = await get("SELECT * FROM editions WHERE id = ?", edInfo.lastInsertRowid);
  }

  const fpInfo = await run("INSERT INTO fingerprints (hash, edition_id, pending, created_at) VALUES (?, ?, ?, ?)", [
    fingerprint,
    editionRow.id,
    effectiveAdmin ? 0 : 1,
    isoNow(),
  ]);
  return assembleBook(work.id, Number(fpInfo.lastInsertRowid));
}

export async function updateBook(id, { title, author, edition, pageCount, toc, slug } = {}) {
  const work = await get("SELECT * FROM works WHERE id = ?", id);
  if (!work) return null;
  const nextTitle = title ?? work.title;
  const nextSlug =
    slug != null && slug !== ""
      ? await uniqueSlug(slugify(slug), work.id)
      : work.slug || (await uniqueSlug(nextTitle, work.id));
  await run("UPDATE works SET title = ?, author = ?, slug = ? WHERE id = ?", [nextTitle, author ?? work.author, nextSlug, work.id]);
  const ed = await primaryEdition(work.id);
  const nextLabel = String(edition ?? ed?.label ?? 1);
  if (ed) {
    await run("UPDATE editions SET label = ?, page_count = ?, toc = ? WHERE id = ?", [
      nextLabel,
      pageCount ?? ed.page_count,
      toc != null ? JSON.stringify(toc) : ed.toc,
      ed.id,
    ]);
  } else {
    await run("INSERT INTO editions (work_id, label, page_count, toc, created_at) VALUES (?, ?, ?, ?, ?)", [
      work.id,
      nextLabel,
      pageCount ?? null,
      toc != null ? JSON.stringify(toc) : "[]",
      isoNow(),
    ]);
  }
  return assembleBook(work.id);
}

// Delete semantics: a record with commits is RETIRED (history + slug kept);
// only a zero-commit record can be hard-deleted. Returns "retired" | "deleted".
export async function deleteBook(id) {
  const work = await get("SELECT * FROM works WHERE id = ?", id);
  if (!work) return null;
  const row = await get(
    `SELECT COUNT(*) AS n FROM commits c
     JOIN fingerprints fp ON fp.id = c.fingerprint_id
     JOIN editions e ON e.id = fp.edition_id
     WHERE e.work_id = ?`,
    id
  );
  if (row.n > 0) {
    await run("UPDATE works SET retired = 1 WHERE id = ?", id);
    return "retired";
  }
  await run("DELETE FROM works WHERE id = ?", id);
  return "deleted";
}

export async function listPendingFingerprints() {
  const rows = await all(
    `SELECT fp.id AS fingerprint_id, fp.hash, fp.edition_id, fp.created_at,
            w.id AS work_id, w.slug, w.title, w.author,
            e.label AS edition, e.page_count, e.toc
     FROM fingerprints fp
     JOIN editions e ON e.id = fp.edition_id
     JOIN works w ON w.id = e.work_id
     WHERE fp.pending = 1
     ORDER BY fp.created_at ASC`
  );
  return rows.map((r) => ({ ...r, toc: JSON.parse(r.toc || "[]") }));
}

export async function bindFingerprint(fingerprintId, { toc, pageCount, editionLabel } = {}) {
  const fp = await get("SELECT * FROM fingerprints WHERE id = ?", fingerprintId);
  if (!fp) return null;
  if (toc != null || pageCount != null || editionLabel != null) {
    const ed = await get("SELECT * FROM editions WHERE id = ?", fp.edition_id);
    if (ed) {
      await run("UPDATE editions SET label = ?, page_count = ?, toc = ? WHERE id = ?", [
        editionLabel != null ? String(editionLabel) : ed.label,
        pageCount ?? ed.page_count,
        toc != null ? JSON.stringify(toc) : ed.toc,
        ed.id,
      ]);
    }
  }
  await run("UPDATE fingerprints SET pending = 0 WHERE id = ?", fingerprintId);
  const workId = (await fingerprintWorkId(fingerprintId))?.work_id;
  return workId != null ? assembleBook(workId, fingerprintId) : null;
}

export async function listRetiredWorks() {
  const rows = await all("SELECT * FROM works WHERE retired = 1 ORDER BY title");
  const out = [];
  for (const w of rows) out.push(await assembleBook(w.id));
  return out;
}

export async function reactivateWork(id) {
  const work = await get("SELECT * FROM works WHERE id = ?", id);
  if (!work) return null;
  await run("UPDATE works SET retired = 0 WHERE id = ?", id);
  return assembleBook(id);
}

// ── users / roles ────────────────────────────────────────────────────────────

export async function getUserById(id) {
  return (await get("SELECT * FROM users WHERE id = ?", id)) ?? null;
}

export async function getUserByUsername(username) {
  if (!username) return null;
  return (await get("SELECT * FROM users WHERE username = ? COLLATE NOCASE", username)) ?? null;
}

async function superAdminCount() {
  return (await get("SELECT COUNT(*) AS n FROM users WHERE role='super_admin'")).n;
}

async function resolveRoleForGithub(githubId, { adminIds = [], superAdminIds = [] }) {
  if (adminIds.includes(String(githubId))) return "admin";
  if (superAdminIds.includes(String(githubId))) {
    const count = await superAdminCount();
    if (count === 0) return "super_admin";
  }
  return "member";
}

export async function getOrCreateGithubUser({ githubId, displayName, avatarUrl, username, adminIds = [], superAdminIds = [] }) {
  const existing = await get("SELECT * FROM users WHERE github_id = ?", githubId);
  if (existing) {
    let role = existing.role;
    if (role === "member" && adminIds.includes(String(githubId))) role = "admin";
    else if (superAdminIds.includes(String(githubId))) {
      const count = await superAdminCount();
      if (count === 0) role = "super_admin";
    }
    await run("UPDATE users SET display_name = ?, avatar_url = ?, username = ?, role = ? WHERE id = ?", [
      displayName ?? existing.display_name,
      avatarUrl ?? existing.avatar_url,
      username ?? existing.username,
      role,
      existing.id,
    ]);
    return get("SELECT * FROM users WHERE id = ?", existing.id);
  }
  const role = await resolveRoleForGithub(githubId, { adminIds, superAdminIds });
  const info = await run("INSERT INTO users (user_key, display_name, avatar_url, username, github_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    randomUUID(),
    displayName ?? null,
    avatarUrl ?? null,
    username ?? null,
    githubId,
    role,
    isoNow(),
  ]);
  return get("SELECT * FROM users WHERE id = ?", info.lastInsertRowid);
}

export async function listUsers() {
  return all(
    `SELECT u.id, u.display_name, u.username, u.avatar_url, u.role, u.created_at,
            (SELECT COUNT(*) FROM commits c WHERE c.user_id = u.id) AS commit_count
     FROM users u ORDER BY u.role = 'super_admin' DESC, u.created_at ASC`
  );
}

// Assign/revoke admin among members. The super_admin role can only change via
// transferSuperAdmin — this exits early rather than touching it.
export async function setUserRole(userId, role) {
  const u = await get("SELECT * FROM users WHERE id = ?", userId);
  if (!u) return null;
  if (u.role === "super_admin" || role === "super_admin") return null;
  await run("UPDATE users SET role = ? WHERE id = ?", [role === "admin" ? "admin" : "member", userId]);
  return get("SELECT * FROM users WHERE id = ?", userId);
}

export async function countSuperAdmins() {
  return superAdminCount();
}

// Swap authority: successor becomes super_admin, incumbent demotes to admin,
// in a single transaction so the "exactly one super admin" invariant holds.
export async function transferSuperAdmin(fromId, toId) {
  if (fromId == null || toId == null || fromId === toId) throw new Error("invalid transfer");
  const from = await get("SELECT * FROM users WHERE id = ?", fromId);
  const to = await get("SELECT * FROM users WHERE id = ?", toId);
  if (!from || !to) throw new Error("user not found");
  if (from.role !== "super_admin") throw new Error("only the super admin can transfer authority");
  await withTx(async (tx) => {
    // Demote the incumbent first — the partial unique index on
    // role='super_admin' allows only one row, so a promotion can't coexist.
    await _runFor(tx, "UPDATE users SET role = 'admin' WHERE id = ?", [from.id]);
    await _runFor(tx, "UPDATE users SET role = 'super_admin' WHERE id = ?", [to.id]);
  });
  return true;
}

export async function deleteUser(userId) {
  // Explicit dependency cleanup so account removal never relies on the FK
  // cascade (which isn't guaranteed to be live on every remote driver).
  await run("DELETE FROM commits WHERE user_id = ?", userId);
  await run("DELETE FROM sessions WHERE user_id = ?", userId);
  return (await run("DELETE FROM users WHERE id = ?", userId)).rowsAffected > 0;
}

// ── sessions ──────────────────────────────────────────────────────────────────

export async function createSession(token, userId, expiresAtMs) {
  await run("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [
    token,
    userId,
    expiresAtMs,
    isoNow(),
  ]);
}

export async function getSession(token) {
  return (await get("SELECT token, user_id, expires_at FROM sessions WHERE token = ?", token)) || null;
}

export async function deleteSession(token) {
  await run("DELETE FROM sessions WHERE token = ?", token);
}

export async function extendSession(token, expiresAtMs) {
  await run("UPDATE sessions SET expires_at = ? WHERE token = ?", [expiresAtMs, token]);
}

export async function deleteUserSessions(userId) {
  await run("DELETE FROM sessions WHERE user_id = ?", userId);
}

// Opportunistic sweep — run on boot and on an interval so expired rows don't
// accumulate. One indexed DELETE regardless of table size.
export async function pruneExpiredSessions(nowMs = Date.now()) {
  await run("DELETE FROM sessions WHERE expires_at < ?", nowMs);
}

// ── commits ──────────────────────────────────────────────────────────────────

async function resolveFingerprintForWork(workId, fingerprintHash) {
  if (fingerprintHash) {
    const fp = await get("SELECT * FROM fingerprints WHERE hash = ?", fingerprintHash);
    if (fp) {
      const workIdOfFp = (await fingerprintWorkId(fp.id))?.work_id;
      if (workIdOfFp != null && workIdOfFp === workId) return fp.id;
    }
  }
  const pfp = await primaryFingerprint(workId);
  return pfp ? pfp.id : null;
}

export async function insertCommit(workId, { userId, sessionId, deviceId, startedAt, endedAt, minutes, pages, readPages, fingerprint }) {
  if (!userId) throw new Error("userId required");
  const fingerprintId = await resolveFingerprintForWork(workId, fingerprint);
  if (fingerprintId == null) throw new Error("book has no bound fingerprint");
  const info = await run(
    "INSERT INTO commits (fingerprint_id, user_id, session_id, device_id, started_at, ended_at, minutes, pages, read_pages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      fingerprintId,
      userId,
      sessionId || randomUUID(),
      deviceId,
      startedAt,
      endedAt,
      minutes,
      pages ?? "{}",
      readPages ?? "[]",
      isoNow(),
    ]
  );
  return parseCommit(await get("SELECT * FROM commits WHERE id = ?", info.lastInsertRowid));
}

export async function listCommits(workId, userId) {
  if (!userId) return [];
  const rows = await all(
    `SELECT c.* FROM commits c
     JOIN fingerprints fp ON fp.id = c.fingerprint_id
     JOIN editions e ON e.id = fp.edition_id
     WHERE e.work_id = ? AND c.user_id = ?
     ORDER BY c.ended_at`,
    workId,
    userId
  );
  return rows.map(parseCommit);
}

export async function deleteBookCommits(workId, userId) {
  if (!userId) return 0;
  return (
    await run(
      `DELETE FROM commits WHERE user_id = ? AND fingerprint_id IN (
         SELECT fp.id FROM fingerprints fp JOIN editions e ON e.id = fp.edition_id WHERE e.work_id = ?
       )`,
      [userId, workId]
    )
  ).rowsAffected;
}

async function listUserCommits(userId) {
  return all(
    `SELECT c.*, w.id AS book_id, w.title AS book_title, w.slug AS book_slug,
            fp.hash AS book_fingerprint, e.toc AS book_toc
     FROM commits c
     JOIN fingerprints fp ON fp.id = c.fingerprint_id
     JOIN editions e ON e.id = fp.edition_id
     JOIN works w ON w.id = e.work_id
     WHERE c.user_id = ?
     ORDER BY c.ended_at DESC`,
    userId
  );
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

export async function getUserStats(userId) {
  if (!userId) return null;
  const rows = await listUserCommits(userId);
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