import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import * as db from "./db.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

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
  if (!db.deleteBook(Number(req.params.id))) return res.status(404).json({ error: "book not found" });
  res.json({ ok: true });
});

app.delete("/api/books/:id/commits", (req, res) => {
  db.deleteBookCommits(Number(req.params.id));
  res.json({ ok: true });
});

app.post("/api/books/:id/commits", (req, res) => {
  const bookId = Number(req.params.id);
  const { sessionId, deviceId, startedAt, endedAt, secondsPerPage, readPages } = req.body ?? {};
  if (!deviceId || !startedAt || !endedAt) return res.status(400).json({ error: "deviceId, startedAt, endedAt required" });
  const seconds = Object.values(secondsPerPage ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const commit = db.insertCommit(bookId, {
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

app.get("/api/books/:id/commits", (req, res) => {
  res.json(db.listCommits(Number(req.params.id)));
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`reader server on http://localhost:${port}`));