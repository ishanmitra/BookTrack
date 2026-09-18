import { randomBytes, randomUUID } from "node:crypto";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import cors from "cors";
import express from "express";
import * as db from "./db.js";
import * as auth from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_ORIGIN =
  (process.env.CLIENT_ORIGIN || "http://localhost:5173,http://localhost:4000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const app = express();
app.set("trust proxy", 1);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || CLIENT_ORIGIN.includes(origin)) return cb(null, true);
      cb(null, false); // no ACAO header → the cross-origin caller can't read responses
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

// Hardening headers. CSP only lands on the app shell (never /api JSON, and
// never in dev where the page is served by the Vite dev server on :5173).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (!req.path.startsWith("/api")) {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://avatars.githubusercontent.com",
        "worker-src 'self' blob:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; ")
    );
  }
  next();
});

const API_KEY = process.env.API_KEY;
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const ADMIN_GITHUB_IDS = (process.env.GITHUB_ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SUPER_ADMIN_GITHUB_IDS = (process.env.GITHUB_SUPER_ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REDIRECT_URL = process.env.REDIRECT_URL || "/";

// Phase D roles: super_admin > admin > member. The env-pinned account fills
// the super-admin vacancy at boot (self-heal); see db.bootstrapSuperAdmin.
db.bootstrapSuperAdmin(SUPER_ADMIN_GITHUB_IDS);

const pendingStates = new Map();

app.use("/api", (req, res, next) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "invalid api key" });
  }
  next();
});

function isAdmin(user) {
  return user?.role === "admin" || user?.role === "super_admin";
}

// The session caches a user snapshot; roles can change (transfer, demote,
// grant), so role-sensitive paths always re-read the live row from the DB.
function freshUser(req) {
  const s = auth.currentUser(req);
  if (!s) return null;
  return db.getUserById(s.id) || null;
}

function requireAuth(req, res, next) {
  const user = freshUser(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = freshUser(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  if (!isAdmin(user)) return res.status(403).json({ error: "admin required" });
  req.user = user;
  next();
}

function requireSuperAdmin(req, res, next) {
  const user = freshUser(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  if (user.role !== "super_admin") return res.status(403).json({ error: "super admin required" });
  req.user = user;
  next();
}

app.get("/api/auth/github", (req, res) => {
  if (!GH_CLIENT_ID) return res.status(503).json({ error: "GITHUB_CLIENT_ID not configured" });
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, { createdAt: Date.now() });
  const redirectUri = `${req.protocol}://${req.get("host")}/api/auth/github/callback`;
  const params = new URLSearchParams({ client_id: GH_CLIENT_ID, redirect_uri: redirectUri, scope: "read:user", state });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/api/auth/github/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const st = pendingStates.get(state);
  pendingStates.delete(state);
  if (error || !code || !st) return res.status(400).send("authorization failed");
  if (Date.now() - st.createdAt > 10 * 60 * 1000) return res.status(400).send("state expired");
  try {
    const redirectUri = `${req.protocol}://${req.get("host")}/api/auth/github/callback`;
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: GH_CLIENT_ID, client_secret: GH_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    });
    const tok = await tokenRes.json();
    if (tok.error) return res.status(400).send("token exchange failed");
    const meRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "book-tracker", Accept: "application/vnd.github+json" },
    });
    const me = await meRes.json();
    if (!me.id) return res.status(400).send("github user lookup failed");
    const user = db.getOrCreateGithubUser({
      githubId: String(me.id),
      displayName: me.name || me.login,
      avatarUrl: me.avatar_url,
      username: me.login,
      adminIds: ADMIN_GITHUB_IDS,
      superAdminIds: SUPER_ADMIN_GITHUB_IDS,
    });
    auth.startSession(res, user);
    res.redirect(REDIRECT_URL);
  } catch (err) {
    console.error("github callback error", err);
    res.status(500).send("authentication error");
  }
});

app.get("/api/auth/me", (req, res) => {
  const u = freshUser(req);
  res.json({
    user: u
      ? { id: u.id, display_name: u.display_name, username: u.username, avatar_url: u.avatar_url, role: u.role, is_admin: u.role !== "member", created_at: u.created_at }
      : null,
  });
});

app.post("/api/auth/logout", (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

// ── catalog ──────────────────────────────────────────────────────────────────
// The catalog is a three-level hierarchy (work → editions → fingerprints).
// Registration is shared: members/anonymous land in a pending state for
// admin confirmation; admins/super admins bind immediately.

app.get("/api/books", (_req, res) => {
  res.json(db.listBooks().map(db.parseBook));
});

app.get("/api/books/pending", requireAdmin, (_req, res) => {
  res.json(db.listPendingFingerprints());
});

app.get("/api/books/retired", requireAdmin, (_req, res) => {
  res.json(db.listRetiredWorks().map(db.parseBook));
});

app.get("/api/books/:id", (req, res) => {
  const book = db.parseBook(db.getBook(Number(req.params.id)));
  if (!book) return res.status(404).json({ error: "book not found" });
  res.json(book);
});

app.get("/api/book/:slug", (req, res) => {
  const book = db.parseBook(db.getBookBySlug(req.params.slug));
  if (!book) return res.status(404).json({ error: "book not found" });
  res.json(book);
});

app.post("/api/books", (req, res) => {
  const { fingerprint, title, author, edition, pageCount, slug, toc } = req.body ?? {};
  if (!fingerprint) return res.status(400).json({ error: "fingerprint required" });
  const role = freshUser(req)?.role || "member";
  const book = db.parseBook(db.registerBook(fingerprint, { title, author, edition, pageCount, slug, toc }, role));
  res.json(book);
});

app.patch("/api/books/:id", requireAdmin, (req, res) => {
  const { title, author, edition, pageCount, toc, slug } = req.body ?? {};
  const book = db.parseBook(db.updateBook(Number(req.params.id), { title, author, edition, pageCount, toc, slug }));
  if (!book) return res.status(404).json({ error: "book not found" });
  res.json(book);
});

app.delete("/api/books/:id", requireAdmin, (req, res) => {
  const result = db.deleteBook(Number(req.params.id));
  if (!result) return res.status(404).json({ error: "book not found" });
  res.json({
    ok: true,
    action: result, // "retired" (history + slug kept) or "deleted" (zero-commit hard delete)
    message:
      result === "retired"
        ? "This book has reading history, so it was retired instead of deleted. History and slug are kept; it's hidden from listings until reactivated."
        : "Book deleted.",
  });
});

// Bind a pending fingerprint (member/anonymous uploads) — admin confirmation.
// Optional body updates the work's edition before approval.
app.post("/api/books/bind/:fingerprintId", requireAdmin, (req, res) => {
  const { toc, pageCount, edition } = req.body ?? {};
  const book = db.parseBook(db.bindFingerprint(Number(req.params.fingerprintId), { toc, pageCount, editionLabel: edition }));
  if (!book) return res.status(404).json({ error: "fingerprint not found" });
  res.json(book);
});

app.post("/api/books/reactivate/:id", requireAdmin, (req, res) => {
  const book = db.parseBook(db.reactivateWork(Number(req.params.id)));
  if (!book) return res.status(404).json({ error: "work not found" });
  res.json(book);
});

// ── commits — authenticated session required (no anonymous commits) ──────────
// Commits attach to the exact fingerprint read (optional in the payload so
// existing clients keep working against the work's primary fingerprint).
app.post("/api/books/:id/commits", requireAuth, (req, res) => {
  const bookId = Number(req.params.id);
  const { sessionId, deviceId, startedAt, endedAt, secondsPerPage, readPages, fingerprint } = req.body ?? {};
  if (!deviceId || !startedAt || !endedAt) return res.status(400).json({ error: "deviceId, startedAt, endedAt required" });
  const seconds = Object.values(secondsPerPage ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const commit = db.insertCommit(bookId, {
    userId: req.user.id,
    sessionId: sessionId || randomUUID(),
    deviceId,
    startedAt,
    endedAt,
    minutes: Math.round((seconds / 60) * 10) / 10,
    pages: JSON.stringify(secondsPerPage ?? {}),
    readPages: JSON.stringify(readPages ?? []),
    fingerprint: fingerprint || null,
  });
  res.status(201).json(commit);
});

// Stats across the signed-in user's own commits
app.get("/api/me/stats", requireAuth, (req, res) => {
  res.json(db.getUserStats(req.user.id));
});

// Public profile — anyone (signed in or not) can view a user's reading stats.
// Only a boolean admin flag is exposed: super_admin renders as "admin".
app.get("/api/users/:username", (req, res) => {
  const u = db.getUserByUsername(req.params.username);
  if (!u) return res.status(404).json({ error: "user not found" });
  res.json({
    user: { id: u.id, display_name: u.display_name, username: u.username, avatar_url: u.avatar_url, is_admin: u.role !== "member", created_at: u.created_at },
    stats: db.getUserStats(u.id),
  });
});

app.get("/api/books/:id/commits", requireAuth, (req, res) => {
  res.json(db.listCommits(Number(req.params.id), req.user.id));
});

app.delete("/api/books/:id/commits", requireAuth, (req, res) => {
  db.deleteBookCommits(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ── role management (super admin only) ───────────────────────────────────────
app.get("/api/admin/role", requireAdmin, (req, res) => {
  // The signed-in admin's own role, so the admin console can branch super-only
  // features. /api/auth/me and public profiles stay boolean-only per contract.
  res.json({ role: req.user.role });
});

app.get("/api/admin/users", requireSuperAdmin, (_req, res) => {
  res.json(db.listUsers());
});

app.patch("/api/admin/users/:id/role", requireSuperAdmin, (req, res) => {
  const role = req.body?.role;
  if (role !== "admin" && role !== "member") return res.status(400).json({ error: "role must be 'admin' or 'member'" });
  const user = db.setUserRole(Number(req.params.id), role);
  if (!user) return res.status(400).json({ error: "cannot change that user's role" });
  res.json({ ok: true, user: { id: user.id, role: user.role } });
});

// Swap authority: the incumbent super admin designates a successor, then
// demotes to admin — in a single transaction (see db.transferSuperAdmin).
app.post("/api/admin/transfer", requireSuperAdmin, (req, res) => {
  const userId = Number(req.body?.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId required" });
  try {
    db.transferSuperAdmin(req.user.id, userId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ ok: true });
});

// ── account deletion ─────────────────────────────────────────────────────────
// Self-service account removal. The super admin must swap authority first —
// the server refuses until the role has been transferred.
app.delete("/api/me", requireAuth, (req, res) => {
  if (req.user.role === "super_admin") {
    return res.status(400).json({ error: "transfer the super admin role to another user before removing your account" });
  }
  const sessionUser = db.getUserById(req.user.id);
  if (sessionUser) db.deleteUser(sessionUser.id);
  auth.endSession(req, res);
  res.json({ ok: true, deleted: true });
});

// SPA fallback — serve the built client for non-API routes so browser
// refresh works on client-side routes (/user/:username, /book/:key, /admin).
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "not found" });
  res.sendFile(path.join(clientDist, "index.html"));
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`reader server on http://localhost:${port}`));

export { app };