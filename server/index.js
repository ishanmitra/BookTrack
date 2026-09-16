import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import * as db from "./db.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

app.use("/api", (req, res, next) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "invalid api key" });
  }
  next();
});

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
  if (!ADMIN_TOKEN) return res.status(403).json({ error: "ADMIN_TOKEN not configured on server" });
  if (req.get("x-admin-key") !== ADMIN_TOKEN) return res.status(401).json({ error: "admin key required" });
  if (!db.deleteBook(Number(req.params.id))) return res.status(404).json({ error: "book not found" });
  res.json({ ok: true });
});

app.delete("/api/books/:id/commits", (req, res) => {
  const userId = req.query.userId || req.body?.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  db.deleteBookCommits(Number(req.params.id), userId);
  res.json({ ok: true });
});

app.post("/api/books/:id/commits", (req, res) => {
  const bookId = Number(req.params.id);
  const { sessionId, userId, deviceId, startedAt, endedAt, secondsPerPage, readPages } = req.body ?? {};
  if (!userId || !deviceId || !startedAt || !endedAt) return res.status(400).json({ error: "userId, deviceId, startedAt, endedAt required" });
  const seconds = Object.values(secondsPerPage ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const commit = db.insertCommit(bookId, {
    sessionId: sessionId || randomUUID(),
    userId,
    deviceId,
    startedAt,
    endedAt,
    minutes: Math.round((seconds / 60) * 10) / 10,
    pages: JSON.stringify(secondsPerPage ?? {}),
    readPages: JSON.stringify(readPages ?? []),
  });
  res.status(201).json(commit);
});

app.get("/api/books/:id/commits", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  res.json(db.listCommits(Number(req.params.id), userId));
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`reader server on http://localhost:${port}`));