import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import api from "./api";
import { STATUS, useLocalBook } from "./useLocalBook";
import * as storage from "./storage";
import PdfReader from "./PdfReader";
import Heatmap from "./Heatmap";
import PageHeatmap from "./PageHeatmap";
import TocTable from "./TocTable";
import ChapterProgress from "./ChapterProgress";
import BookWizard from "./BookWizard";
import BookInfo from "./BookInfo";

const STATUS_LABEL = {
  [STATUS.READY]: "✔ connected",
  [STATUS.MISSING]: "✖ file missing",
  [STATUS.PERMISSION]: "◔ needs permission",
  [STATUS.ERROR]: "⛔ error",
  [STATUS.LOADING]: "… checking",
};

function statusForMeta(s) {
  return s?.status || STATUS.IDLE;
}

function fmtClock(totalSeconds) {
  totalSeconds = Math.floor(totalSeconds || 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    saved, active, pick, reconnect, stopTracking, forget, removeStats,
    close, beginReading, persistSavedMeta, renameBook, supportsFileSystem,
  } = useLocalBook();

  const [commits, setCommits] = useState([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [meta, setMeta] = useState(null);
  const [metaBase, setMetaBase] = useState(null);
  const [toc, setToc] = useState([]);
  const [tocDirty, setTocDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedDay, setSelectedDay] = useState(null);
  const [pageCount, setPageCount] = useState(null);
  const [panel, setPanel] = useState(null);
  const [drawerLeaving, setDrawerLeaving] = useState(false);
  const drawerTimerRef = useRef(null);
  const [pausedSession, setPausedSession] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const [thumbData, setThumbData] = useState(null);
  const [user, setUser] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const activeBookIdRef = useRef(null);
  const readerRef = useRef(null);
  const reconnectTriggeredRef = useRef(null);

  // ── route derivation ──────────────────────────────────────────────
  const profileUsername = location.pathname.match(/^\/user\/([^/]+)/)?.[1] || null;
  const isProfile = profileUsername != null;
  const ownUsername = user?.username || user?.display_name || "";
  const isOwnProfile = isProfile && !!user && profileUsername.toLowerCase() === ownUsername.toLowerCase();
  const infoKey = location.pathname.match(/^\/book\/([^/]+)/)?.[1] || null;
  const readKey = location.pathname.match(/^\/read\/([^/]+)/)?.[1] || null;
  const showLibrary = !isProfile && !infoKey && !readKey;
  const bookOpen = !!readKey && active.file != null;
  const readerOpen = active.status === STATUS.READY && active.file != null;

  // ── auto-reconnect when URL lands on /read/:slug ────────────────
  useEffect(() => {
    if (!readKey) return;
    if (active.bookId === readKey) return;
    if (reconnectTriggeredRef.current === readKey) return;
    reconnectTriggeredRef.current = readKey;
    reconnect(readKey).catch(() => {});
  }, [readKey, active.bookId, reconnect]);

  // ── clear active book when navigating away from /read/:slug ─────
  useEffect(() => {
    if (!readKey && reconnectTriggeredRef.current) {
      reconnectTriggeredRef.current = null;
      close();
    }
  }, [readKey, close]);

  // ── boot ──────────────────────────────────────────────────────────
  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => {});
  }, []);

  useEffect(() => {
    storage
      .getThumbnails()
      .then((list) => {
        const m = {};
        for (const t of list) if (t?.key) m[t.key] = t.dataUrl;
        setThumbs(m);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onPointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // ── commits / queue ───────────────────────────────────────────────
  const loadCommits = useCallback(async (bookId) => {
    if (!user) { setCommits([]); return; }
    if (!bookId) return;
    setCommitsLoading(true);
    try {
      setCommits(await api.getCommits(bookId));
    } catch (err) {
      setNotice(`Couldn't load commit history: ${err.message}`);
    } finally {
      setCommitsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (active.book?.id) {
      activeBookIdRef.current = active.book.id;
      setMeta({ title: active.book.title, author: active.book.author, edition: active.book.edition, slug: active.book.slug });
      setMetaBase({ title: active.book.title, author: active.book.author, edition: active.book.edition, slug: active.book.slug });
      setToc(Array.isArray(active.book.toc) ? active.book.toc : []);
      setTocDirty(false);
      setPageCount(null);
      setSelectedDay(null);
      clearTimeout(drawerTimerRef.current);
      setDrawerLeaving(false);
      setPanel(null);
      setThumbData(null);
      loadCommits(active.book.id);
    } else {
      activeBookIdRef.current = null;
    }
  }, [active.book?.id, loadCommits]);

  const flushQueue = useCallback(async () => {
    const queued = await storage.listQueuedCommits();
    for (const q of queued) {
      try {
        await api.pushCommit(q.bookId, q);
        await storage.removeQueuedCommit(q.sessionId);
      } catch {
        break;
      }
    }
    const currentBookId = activeBookIdRef.current;
    if (currentBookId) loadCommits(currentBookId);
  }, [loadCommits]);

  useEffect(() => {
    flushQueue();
    const onOnline = () => flushQueue();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushQueue]);

  const handleSessionEnd = useCallback(
    async (payload) => {
      const bookId = activeBookIdRef.current;
      if (!bookId) {
        setNotice("Session skipped — book isn't registered with the server yet. Add/register the book first.");
        return;
      }
      await storage.enqueueCommit({ ...payload, bookId });
      await flushQueue();
    },
    [flushQueue]
  );

  // ── panels ────────────────────────────────────────────────────────
  const openPanel = useCallback((p) => {
    clearTimeout(drawerTimerRef.current);
    setDrawerLeaving(false);
    setPanel(p);
  }, []);

  const closePanel = useCallback(() => {
    clearTimeout(drawerTimerRef.current);
    setDrawerLeaving(true);
    drawerTimerRef.current = setTimeout(() => {
      setPanel(null);
      setDrawerLeaving(false);
    }, 210);
  }, []);

  // ── metadata / TOC ────────────────────────────────────────────────
  const saveMeta = async (patch) => {
    const clientId = active.bookId;
    const serverId = active.book?.id;
    if (!clientId || !serverId) return;
    try {
      const updated = await api.updateBook(serverId, { ...meta, ...patch, toc });
      const nextSlug = updated.slug;
      const prevSlug = metaBase?.slug;
      let targetId = clientId;
      if (nextSlug && prevSlug && nextSlug !== prevSlug) {
        // The book was renamed: re-key all local state under the new slug and
        // follow the new URL (after PATCH, active/bookId may be stale).
        await renameBook(prevSlug, nextSlug);
        targetId = nextSlug;
        setThumbs((m) => {
          if (!m[prevSlug]) return m;
          const n = { ...m };
          delete n[prevSlug];
          n[nextSlug] = m[prevSlug];
          return n;
        });
        navigate("/book/" + nextSlug);
      }
      setMeta({ title: updated.title, author: updated.author, edition: updated.edition, slug: nextSlug });
      setMetaBase({ title: updated.title, author: updated.author, edition: updated.edition, slug: nextSlug });
      setToc(updated.toc);
      setTocDirty(false);
      persistSavedMeta(targetId, { title: updated.title, author: updated.author, edition: updated.edition, slug: nextSlug });
      return updated;
    } catch (err) {
      setNotice(`Save failed: ${err.message}`);
    }
  };

  const addChapter = () => { setToc((t) => [...t, { title: "New chapter", startPage: 1 }]); setTocDirty(true); };
  const insertChapter = (i) => {
    setToc((t) => {
      const start = t[i] ? Number(t[i].startPage) || 1 : t.length ? Number(t[t.length - 1].startPage) || 1 : 1;
      return [...t.slice(0, i), { title: "New chapter", startPage: start }, ...t.slice(i)];
    });
    setTocDirty(true);
  };
  const importOutline = async () => {
    try {
      const rows = await readerRef.current?.getOutline?.();
      if (!rows || rows.length === 0) { setNotice("No embedded outline found in this PDF."); return; }
      setToc(rows.map(({ title, startPage }) => ({ title, startPage })));
      setTocDirty(true);
      setNotice(`Imported ${rows.length} entries from the PDF outline. Review, edit, then Save TOC.`);
    } catch (err) { setNotice(`Couldn't import outline: ${err.message}`); }
  };
  const updateChapter = (i, patch) => { setToc((t) => t.map((c, j) => (j === i ? { ...c, ...patch } : c))); setTocDirty(true); };
  const removeChapter = (i) => { setToc((t) => t.filter((_, j) => j !== i)); setTocDirty(true); };

  const chapterRows = useMemo(() => {
    const visited = new Set();
    for (const c of commits) {
      const readPages = typeof c.read_pages === "string" ? JSON.parse(c.read_pages) : c.read_pages || [];
      for (const p of readPages) if (Number.isFinite(Number(p))) visited.add(Number(p));
    }
    const pc = pageCount ?? active.book?.page_count ?? null;
    return toc.map((c, i) => {
      const start = Number(c.startPage) || 1;
      const nextStart = toc[i + 1] ? Number(toc[i + 1].startPage) || 1 : null;
      const end = nextStart != null ? nextStart - 1 : pc != null ? pc : null;
      let span = 0, vis = 0;
      if (end != null && end >= start) { span = end - start + 1; for (let p = start; p <= end; p++) if (visited.has(p)) vis++; }
      return { ...c, startPage: start, span, visited: vis };
    });
  }, [commits, toc, pageCount, active.book?.page_count]);

  const visibleCommits = useMemo(
    () => (selectedDay ? commits.filter((c) => String(c.started_at || "").startsWith(selectedDay)) : commits),
    [commits, selectedDay]
  );

  // ── paused session badge ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    storage.getPendingSession()
      .then((s) => { if (alive) setPausedSession(s && s.paused && s.bookKey ? s : null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [bookOpen]);

  const pausedSeconds = pausedSession ? Object.values(pausedSession.secondsPerPage || {}).reduce((a, b) => a + b, 0) : 0;

  // ── wizard ────────────────────────────────────────────────────────
  const handleWizardSave = async () => {
    const bookId = active.bookId;
    if (!bookId) return;
    const updated = await saveMeta({});
    const finalSlug = updated?.slug || bookId;
    if (thumbData) {
      try { await storage.saveThumbnail(finalSlug, thumbData); setThumbs((m) => ({ ...m, [finalSlug]: thumbData })); }
      catch { console.error("thumbnail save failed"); }
    }
    beginReading();
    navigate("/book/" + finalSlug);
  };

  // ── navigation helpers ────────────────────────────────────────────
  const openBook = (s) => {
    reconnectTriggeredRef.current = s.bookId;
    if (statusForMeta(s) === STATUS.MISSING) pick(s.bookId);
    else reconnect(s.bookId);
    navigate("/read/" + s.bookId);
  };

  const goToProfile = () => { navigate("/user/" + ownUsername); setMenuOpen(false); };
  const signOut = async () => { await api.logout(); setUser(null); setMenuOpen(false); navigate("/"); };
  const goToLibrary = () => navigate("/");

  const handleStopTracking = async (bookId) => { await stopTracking(bookId); navigate("/"); };
  const handleForget = async (bookId) => {
    if (!window.confirm("Forget this book? Its stats, commits, and local data will be permanently deleted.")) return;
    await forget(bookId);
    navigate("/");
  };

  const metaDirty =
    (meta?.title ?? "") !== (metaBase?.title ?? "") ||
    (meta?.author ?? "") !== (metaBase?.author ?? "") ||
    (meta?.slug ?? "") !== (metaBase?.slug ?? "") ||
    Number(meta?.edition ?? null) !== Number(metaBase?.edition ?? null);
  const bookTitle =
    meta?.title || active.book?.title || (storage.loadSavedMeta()[active.bookId] || {}).title || "Book";

  // ── render ────────────────────────────────────────────────────────
  return (
    <div className="app">
      {notice && (
        <div className="notice" onClick={() => setNotice("")}>{notice}</div>
      )}

      {isProfile && !user && <Navigate to="/" replace />}
      {isProfile && !!user && !isOwnProfile && <Navigate to="/" replace />}

      {isProfile && isOwnProfile ? (
        /* ── Profile page ──────────────────────────────────────────── */
        <section className="profile">
          <div className="profile-card">
            <button className="ghost" onClick={goToLibrary}>← Library</button>
            {user.avatar_url && <img className="profile-avatar" src={user.avatar_url} alt="" />}
            <h1 className="profile-name">{user.display_name}</h1>
            <p className="profile-username">@{ownUsername}</p>
            {user.is_admin ? <span className="badge">admin</span> : null}
            <button className="ghost" onClick={signOut}>Sign out</button>
          </div>
        </section>
      ) : showLibrary ? (
        /* ── Library / home ────────────────────────────────────────── */
        <section className="library">
          <header className="library-top">
            <div>
              <h1>📚 BookTrack</h1>
              <span className="tagline">git-style reading progress for technical books</span>
            </div>
            <div className="library-user">
              <button className="primary" onClick={() => pick()} disabled={active.status === STATUS.WIZARD}>+ Add a book</button>
              {user ? (
                <div className="user-menu" ref={menuRef}>
                  <button className="user-menu-toggle" onClick={() => setMenuOpen((v) => !v)} aria-label="Account menu">
                    {user.avatar_url && <img className="user-avatar" src={user.avatar_url} alt="" />}
                  </button>
                  {menuOpen && (
                    <div className="user-menu-pop">
                      <button className="user-menu-name" onClick={goToProfile}>{user.display_name}</button>
                      <button className="user-menu-item" onClick={signOut}>Sign out</button>
                    </div>
                  )}
                </div>
              ) : (
                <button className="primary" onClick={() => api.signIn()}>Sign in with GitHub</button>
              )}
            </div>
          </header>

          {supportsFileSystem === false && (
            <p className="hint">Your browser lacks the File System Access API — use Chrome/Edge/Safari.</p>
          )}
          {saved.length === 0 && (
            <p className="hint">No books attached yet. Pick a local PDF — the file never leaves your device.</p>
          )}
          <ul className="book-list library-list">
            {saved.map((s) => (
              <li key={s.bookId} className="book-item library-item" onClick={() => openBook(s)}>
                {thumbs[s.bookId] && <img className="book-thumb" src={thumbs[s.bookId]} alt="" />}
                <div className="book-item-body">
                  <div className="book-item-main">
                    <strong className="book-title">{s.meta?.title || "Book"}</strong>
                    <div className="book-item-tags">
                      <span className={`status status-${statusForMeta(s)}`}>{STATUS_LABEL[statusForMeta(s)] || "idle"}</span>
                      {pausedSession?.bookKey === s.meta?.fingerprint && (
                        <span className="paused-badge">⏸ paused · {fmtClock(pausedSeconds)}</span>
                      )}
                    </div>
                  </div>
                  <div className="book-item-actions">
                    {statusForMeta(s) === STATUS.MISSING ? (
                      <button onClick={(e) => { e.stopPropagation(); pick(s.bookId); }}>Locate file</button>
                    ) : statusForMeta(s) === STATUS.PERMISSION || statusForMeta(s) === STATUS.ERROR ? (
                      <button onClick={(e) => { e.stopPropagation(); reconnect(s.bookId); }}>Reconnect</button>
                    ) : (
                      <>
                        <button className="ghost" onClick={(e) => { e.stopPropagation(); navigate("/book/" + s.bookId); }}>Info</button>
                        <button className="primary" onClick={(e) => { e.stopPropagation(); reconnect(s.bookId); navigate("/read/" + s.bookId); }}>Open</button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : infoKey && !readKey ? (
        /* ── Book info page (/book/:slug) ──────────────────────────── */
        <BookInfo slug={infoKey} thumb={thumbs[infoKey]} />
      ) : (
        /* ── Reader view (/read/:slug) ─────────────────────────────── */
        <div className="viewer-scene">
          <div className="reader-top" id="reader-toolbar-slot" />
          <div className="viewer-main">
          {readerOpen ? (
            <PdfReader
              ref={readerRef}
              file={active.file}
              book={{ ...active.book, toc }}
              onSessionEnd={handleSessionEnd}
              onPagesKnown={setPageCount}
              onClose={() => { close(); navigate("/"); }}
              signedIn={!!user}
              onNotice={setNotice}
            />
          ) : (
            <div className="reader error-backdrop">
              {active.status === STATUS.IDLE && (
                <div className="empty-state">
                  <h3>No file connected</h3>
                  <p>Select a PDF to start reading.</p>
                  <button className="primary" onClick={() => reconnect(readKey)}>Locate file…</button>
                </div>
              )}
              {active.status === STATUS.LOADING && (
                <p className="muted">Loading…</p>
              )}
              {active.status === STATUS.MISSING && (
                <div className="empty-state">
                  <h3>The book file is missing</h3>
                  <p>The file you connected was moved or renamed. Locate the new path to continue tracking.</p>
                  <button className="primary" onClick={() => pick(active.bookId)}>Locate file…</button>
                </div>
              )}
              {active.status === STATUS.PERMISSION && (
                <div className="empty-state">
                  <h3>Reading permission required</h3>
                  <button className="primary" onClick={() => reconnect(active.bookId)}>Reconnect</button>
                </div>
              )}
              {active.status === STATUS.UNSUPPORTED && (
                <div className="empty-state">
                  <h3>Browser not supported</h3>
                  <p>{active.error}</p>
                </div>
              )}
              {active.status === STATUS.ERROR && (
                <div className="empty-state">
                  <h3>Something went wrong</h3>
                  <p>{active.error}</p>
                </div>
              )}
            </div>
          )}

          {panel && (
            <aside className={`drawer${drawerLeaving ? " drawer-leaving" : ""}`}>
              {panel === "info" ? (
                <>
                <div className="drawer-header">
                  <strong>Reading activity</strong>
                  <button onClick={closePanel}>✕</button>
                </div>
                <div className="drawer-body">
                  {!user && (
                    <div className="activity-nudge">
                      <p>Sign in with your GitHub account to start tracking reading sessions and commit progress.</p>
                      <button className="primary" onClick={() => api.signIn()}>Sign in with GitHub</button>
                    </div>
                  )}
                  <div className="book-overview">
                    <div className="meta-line"><span>Title</span><b>{meta?.title || "—"}</b></div>
                    <div className="meta-line"><span>Author</span><b>{meta?.author || "—"}</b></div>
                    <div className="meta-line"><span>Edition</span><b>{meta?.edition ?? "—"}</b></div>
                    <div className="meta-line"><span>Fingerprint</span><b className="fprint">{active.book?.fingerprint?.slice(0, 16) || "—"}…</b></div>
                  </div>
                  {commitsLoading ? (
                    <p className="muted">Loading…</p>
                  ) : (
                    <div className="activity-block">
                      <Heatmap commits={commits} onSelectDay={setSelectedDay} selectedDay={selectedDay} />
                    </div>
                  )}
                  <div className="activity-block">
                    <PageHeatmap pageCount={pageCount ?? active.book?.page_count ?? null} commits={visibleCommits} />
                  </div>
                  <div className="activity-block">
                    <ChapterProgress rows={chapterRows} />
                  </div>
                </div>
                </>
              ) : (
                <>
                <div className="drawer-header">
                  <strong>Book settings</strong>
                  <button onClick={closePanel}>✕</button>
                </div>
                <div className="drawer-body">
                  {user?.is_admin && (
                  <section className="panel settings-section">
                    <h2>Book metadata</h2>
                    <div className="meta-grid">
                      <label>Title
                        <input value={meta?.title || ""} onChange={(e) => setMeta((m) => ({ ...m, title: e.target.value }))} />
                      </label>
                      <label>Author
                        <input value={meta?.author || ""} onChange={(e) => setMeta((m) => ({ ...m, author: e.target.value }))} />
                      </label>
                      <label>Edition
                        <input type="number" min={1} value={meta?.edition ?? ""} onChange={(e) => setMeta((m) => ({ ...m, edition: Number(e.target.value) }))} />
                      </label>
                      <label>Slug
                        <input value={meta?.slug ?? ""} onChange={(e) => setMeta((m) => ({ ...m, slug: e.target.value }))} />
                      </label>
                    </div>
                    <div className="meta-actions">
                      <button onClick={() => saveMeta({})} disabled={!metaDirty}>Save</button>
                    </div>
                  </section>
                  )}

                  {user?.is_admin && (
                  <section className="panel settings-section toc-panel">
                    <h2>Table of contents <span className="muted">(edit chapter start pages)</span></h2>
                    <TocTable rows={chapterRows} onChange={updateChapter} onRemove={removeChapter} onAdd={addChapter} onInsert={insertChapter} />
                    <div className="meta-actions">
                      <button onClick={importOutline}>Import from PDF outline</button>
                      {tocDirty && <button onClick={() => saveMeta({})}>Save TOC</button>}
                    </div>
                  </section>
                  )}

                  <section className="panel settings-section danger-zone">
                    <h2>Danger zone</h2>
                    <div className="danger-row">
                      <span>Remove Book — detach this file; stats stay on the server.</span>
                      <button className="danger" onClick={() => handleStopTracking(active.bookId)}>Remove Book</button>
                    </div>
                    <div className="danger-row">
                      <span>Remove Stats — delete all reading progress for this book.</span>
                      <button
                        className="danger"
                        onClick={() => {
                          if (window.confirm("Remove all stats for this book? The book itself stays.")) {
                            readerRef.current?.resetSession();
                            removeStats(active.bookId).then(() => {
                              const sid = (storage.loadSavedMeta()[active.bookId] || {}).serverId;
                              if (sid) loadCommits(sid);
                            });
                          }
                        }}
                      >Remove Stats</button>
                    </div>
                    {user?.is_admin && (
                    <div className="danger-row">
                      <span>Forget Book — permanently delete the book and all progress.</span>
                      <button className="danger" onClick={() => handleForget(active.bookId)}>Forget Book</button>
                    </div>
                    )}
                  </section>
                </div>
                </>
              )}
            </aside>
          )}
          </div>

          <div className="viewer-top">
            <button className="ghost" onClick={() => { readerRef.current?.pause(); close(); navigate("/"); }}>← Library</button>
            <strong className="viewer-title" title={bookTitle}>
              {bookTitle}
              {meta?.author ? <span className="viewer-author"> — {meta.author}</span> : null}
            </strong>
            <div className="viewer-top-actions">
              <button className={panel === "info" ? "active" : ""} onClick={() => (panel === "info" ? closePanel() : openPanel("info"))}>Activity</button>
              <button className={panel === "settings" ? "active" : ""} onClick={() => (panel === "settings" ? closePanel() : openPanel("settings"))}>Settings</button>
            </div>
          </div>
        </div>
      )}

      {active.status === STATUS.WIZARD && (
        <BookWizard
          file={active.file}
          bookId={active.bookId}
          meta={meta}
          onMetaChange={(patch) => setMeta((m) => ({ ...m, ...patch }))}
          toc={toc}
          tocDirty={tocDirty}
          onAddChapter={addChapter}
          onInsertChapter={insertChapter}
          onUpdateChapter={updateChapter}
          onRemoveChapter={removeChapter}
          onImportToc={(rows) => { setToc(rows); setTocDirty(true); }}
          onThumbnail={setThumbData}
          onSave={handleWizardSave}
          onCancel={close}
        />
      )}
    </div>
  );
}