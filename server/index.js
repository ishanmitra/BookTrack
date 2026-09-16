import { randomBytes, randomUUID } from "node:crypto";
import "dotenv/config";
import cors from "cors";
import express from "express";
import * as db from "./db.js";
import * as auth from "./auth.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.API_KEY;
const GH_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GH_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const ADMIN_GITHUB_IDS = (process.env.GITHUB_ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REDIRECT_URL = process.env.REDIRECT_URL || "/";

const pendingStates = new Map();

app.use("/api", (req, res, next) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "invalid api key" });
  }
  next();
});

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
    const isAdmin =
      ADMIN_GITHUB_IDS.includes(String(me.id)) ||
      ADMIN_GITHUB_IDS.some((x) => x.toLowerCase() === (me.login || "").toLowerCase());
    const user = db.getOrCreateGithubUser({
      githubId: String(me.id),
      displayName: me.name || me.login,
      avatarUrl: me.avatar_url,
      isAdmin,
    });
    auth.startSession(res, user);
    res.redirect(REDIRECT_URL);
  } catch (err) {
    console.error("github callback error", err);
    res.status(500).send("authentication error");
  }
});

app.get("/api/auth/me", (req, res) => {
  const u = auth.currentUser(req);
  res.json({
    user: u ? { id: u.id, display_name: u.display_name, avatar_url: u.avatar_url, is_admin: u.is_admin } : null,
  });
});

app.post("/api/auth/logout", (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

// Books — catalog is shared; only deletion requires admin
app.get("/api/books", (_req, res) => {
  res.json(db.listBooks().map(db.parseBook));
});

app.get("/api/books/:id", (req, res) => {
  const book = db.parseBook(db.getBook(Number(req.params.id)));
  if (!book) return res.status(404).json({ error: "book not found" });
  res.json(book);
});

app.post("/api/books", (req, res) => {
  const { fingerprint, title, author, pageCount } = req.body ?? {};
  if (!fingerprint) return res.status(400).json({ error: "fingerprint required" });
  const book = db.parseBook(db.upsertBook(fingerprint, { title, author, pageCount }));
  res.json(book);
});

app.patch("/api/books/:id", (req, res) => {
  const { title, author, edition, pageCount, toc, exercises } = req.body ?? {};
  const book = db.parseBook(db.updateBook(Number(req.params.id), { title, author, edition, pageCount, toc, exercises }));
  if (!book) return res.status(404).json({ error: "book not found" });
  res.json(book);
});

app.delete("/api/books/:id", (req, res) => {
  const user = auth.currentUser(req);
  if (!user?.is_admin) return res.status(403).json({ error: "admin required" });
  if (!db.deleteBook(Number(req.params.id))) return res.status(404).json({ error: "book not found" });
  res.json({ ok: true });
});

// Commits — authenticated session required (no anonymous commits)
app.post("/api/books/:id/commits", auth.requireAuth, (req, res) => {
  const bookId = Number(req.params.id);
  const { sessionId, deviceId, startedAt, endedAt, secondsPerPage, readPages } = req.body ?? {};
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
  });
  res.status(201).json(commit);
});

app.get("/api/books/:id/commits", auth.requireAuth, (req, res) => {
  res.json(db.listCommits(Number(req.params.id), req.user.id));
});

app.delete("/api/books/:id/commits", auth.requireAuth, (req, res) => {
  db.deleteBookCommits(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`reader server on http://localhost:${port}`));