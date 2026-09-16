import { useCallback, useEffect, useRef, useState } from "react";
import api from "./api";
import * as storage from "./storage";

const SAMPLE_BYTES = 1024 * 1024;

export const STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  WIZARD: "wizard",
  MISSING: "missing",
  PERMISSION: "permission",
  UNSUPPORTED: "unsupported",
  ERROR: "error",
};

function baseName(name = "") {
  return name.replace(/\.[^.]+$/, "") || "Untitled book";
}

export async function fingerprintFile(file) {
  const slice = file.slice(0, SAMPLE_BYTES);
  const buf = await slice.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fileKeyOf(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function hasFileSystemAccess() {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

async function pickHandle() {
  const [handle] = await window.showOpenFilePicker({
    types: [{ description: "PDF book", accept: { "application/pdf": [".pdf"] } }],
    multiple: false,
  });
  return handle;
}

async function openHandle(handle, request) {
  let permission = "granted";
  try {
    permission = await handle.queryPermission({ mode: "read" });
  } catch {
    permission = "prompt";
  }
  if (permission === "prompt" && request) {
    try {
      const result = await handle.requestPermission({ mode: "read" });
      if (result === "prompt") return { status: STATUS.PERMISSION };
    } catch {
      return { status: STATUS.PERMISSION };
    }
  }
  try {
    return { status: STATUS.READY, file: await handle.getFile() };
  } catch (err) {
    if (err.name === "NotFoundError" || err.name === "AbortError") return { status: STATUS.MISSING };
    return { status: STATUS.ERROR, error: String(err) };
  }
}

// The canonical book identity is its server slug. Everything local (handles,
// thumbnails, meta, the saved list, the /book/:slug URL, active state) is
// keyed by that slug — there is no separate client-side UUID.
export function useLocalBook() {
  const [saved, setSaved] = useState([]);
  const [active, setActive] = useState({ bookId: null, status: STATUS.IDLE, book: null, file: null, error: null });
  const activeRef = useRef(null);

  // Registers the file on the server (fingerprint-deduped) and returns the
  // catalog record — no local state is written here.
  const ensureRegistered = useCallback(async (file) => {
    const fingerprint = await fingerprintFile(file);
    const book = await api.upsertBook({ fingerprint, title: baseName(file.name) });
    return { book, fingerprint };
  }, []);

  const register = useCallback(
    async (file, bookId) => {
      const { book, fingerprint } = await ensureRegistered(file);
      const nextId = book.slug;
      if (nextId !== bookId) await storage.rekeyBook(bookId, nextId);
      storage.saveMetaFor(nextId, { title: book.title, fingerprint, fileKey: fileKeyOf(file), serverId: book.id, slug: book.slug });
      return { book, bookId: nextId };
    },
    [ensureRegistered]
  );

  const setSavedEntry = useCallback((bookId, patch) => {
    setSaved((list) => {
      const idx = list.findIndex((s) => s.bookId === bookId);
      if (idx >= 0) {
        return list.map((s) => (s.bookId === bookId ? { ...s, ...patch } : s));
      }
      const meta = storage.loadSavedMeta()[bookId] || {};
      return [...list, { bookId, meta, status: STATUS.IDLE, ...patch }];
    });
  }, []);

  const removeSavedEntry = useCallback((bookId) => {
    setSaved((list) => list.filter((s) => s.bookId !== bookId));
  }, []);

  const persistSavedMeta = useCallback(
    (bookId, patch) => {
      storage.saveMetaFor(bookId, patch);
      setSavedEntry(bookId, { meta: storage.loadSavedMeta()[bookId] || {} });
    },
    [setSavedEntry]
  );

  // Move a book (handle, thumbnail, meta, saved-list entry, active state) to
  // a new slug after the user edits it.
  const renameBook = useCallback(
    async (oldId, newId) => {
      if (!oldId || !newId || oldId === newId) return;
      await storage.rekeyBook(oldId, newId);
      setSaved((list) =>
        list.map((s) => (s.bookId === oldId ? { ...s, bookId: newId, meta: storage.loadSavedMeta()[newId] || s.meta } : s))
      );
      setActive((a) => (a.bookId === oldId ? { ...a, bookId: newId } : a));
      if (activeRef.current === oldId) activeRef.current = newId;
    },
    []
  );

  const refreshSaved = useCallback(async () => {
    // The handle store is the source of truth for "what's in my library" —
    // Remove Book deletes only the handle while meta stays, and must not
    // resurrect the book on refresh.
    const ids = await storage.listSavedBookIds();
    const meta = storage.loadSavedMeta();
    setSaved(ids.map((bookId) => ({ bookId, meta: meta[bookId] || {}, status: STATUS.LOADING })));
  }, []);

  const restore = useCallback(
    async (bookId) => {
      const handle = await storage.getBookHandle(bookId);
      const meta = storage.loadSavedMeta()[bookId] || {};
      if (!handle) {
        setSavedEntry(bookId, { meta, status: STATUS.MISSING });
        return;
      }
      const result = await openHandle(handle, false);
      setSavedEntry(bookId, { meta, status: result.status, error: result.error });
      if (result.status !== STATUS.READY) return;
      try {
        const { book, bookId: nextId } = await register(result.file, bookId);
        if (nextId !== bookId) removeSavedEntry(bookId);
        setSavedEntry(nextId, { meta: storage.loadSavedMeta()[nextId] || {}, status: STATUS.READY });
        if (activeRef.current === bookId) {
          activeRef.current = nextId;
          setActive({ bookId: nextId, status: STATUS.READY, book, file: result.file, error: null });
        }
      } catch (err) {
        setSavedEntry(bookId, { meta, status: STATUS.ERROR, error: String(err) });
      }
    },
    [register, setSavedEntry, removeSavedEntry]
  );

  const restoreOnBoot = useRef(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      // Upgrade legacy UUID-keyed books to slug keys before anything reads state.
      await storage.migrateLegacyBookKeys();
      if (!alive) return;
      await refreshSaved();
      if (!alive) return;
      const ids = await storage.listSavedBookIds();
      for (const bookId of ids) {
        if (!restoreOnBoot.current.has(bookId)) {
          restoreOnBoot.current.add(bookId);
          restore(bookId).catch(() => {});
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshSaved, restore]);

  const pick = useCallback(
    async (existingBookId) => {
      activeRef.current = existingBookId || null;
      setActive({ bookId: existingBookId || null, status: STATUS.LOADING, book: null, file: null, error: null });
      if (!hasFileSystemAccess()) {
        setActive({ bookId: existingBookId || null, status: STATUS.UNSUPPORTED, book: null, file: null, error: "File System Access API not supported here (try Chrome/Edge/Safari)." });
        return;
      }
      try {
        const handle = await pickHandle();
        const file = await handle.getFile();
        // Register first so we know the slug to key local state under.
        const { book, fingerprint } = await ensureRegistered(file);
        const bookId = book.slug;
        activeRef.current = bookId;
        await storage.saveBookHandle(bookId, handle);
        storage.saveMetaFor(bookId, { title: book.title, fingerprint, fileKey: fileKeyOf(file), serverId: book.id, slug: book.slug });
        if (existingBookId && existingBookId !== bookId) removeSavedEntry(existingBookId);
        setSavedEntry(bookId, { meta: storage.loadSavedMeta()[bookId] || {}, status: STATUS.READY });
        if (existingBookId) {
          setActive({ bookId, status: STATUS.READY, book, file, error: null });
        } else {
          setActive({ bookId, status: STATUS.WIZARD, book, file, error: null });
        }
      } catch (err) {
        if (err?.name === "AbortError") {
          setActive((a) => ({ ...a, status: STATUS.IDLE, error: null }));
          return;
        }
        setActive((a) => ({ ...a, status: STATUS.ERROR, error: String(err) }));
      }
    },
    [ensureRegistered, setSavedEntry, removeSavedEntry]
  );

  const reconnect = useCallback(
    async (bookId) => {
      activeRef.current = bookId;
      setActive({ bookId, status: STATUS.LOADING, book: null, file: null, error: null });
      const handle = await storage.getBookHandle(bookId);
      if (!handle) return pick(bookId);
      const result = await openHandle(handle, true);
      if (result.status !== STATUS.READY) {
        setActive({ bookId, status: result.status, book: null, file: null, error: result.error });
        setSavedEntry(bookId, { status: result.status, error: result.error });
        return;
      }
      try {
        const { book, bookId: nextId } = await register(result.file, bookId);
        if (nextId !== bookId) {
          removeSavedEntry(bookId);
          setSavedEntry(nextId, { meta: storage.loadSavedMeta()[nextId] || {}, status: STATUS.READY });
          activeRef.current = nextId;
        } else {
          setSavedEntry(bookId, { status: STATUS.READY });
        }
        setActive({ bookId: nextId, status: STATUS.READY, book, file: result.file, error: null });
      } catch (err) {
        setActive({ bookId, status: STATUS.ERROR, book: null, file: null, error: String(err) });
      }
    },
    [pick, register, setSavedEntry, removeSavedEntry]
  );

  const stopTracking = useCallback(async (bookId) => {
    await storage.deleteBookHandle(bookId);
    setSaved((list) => list.filter((s) => s.bookId !== bookId));
    setActive((a) => (a.bookId === bookId ? { bookId: null, status: STATUS.IDLE, book: null, file: null, error: null } : a));
  }, []);

  const forget = useCallback(async (bookId) => {
    const meta = storage.loadSavedMeta()[bookId] || {};
    const serverId = meta.serverId;
    if (serverId) await api.deleteBook(serverId).catch(() => {});
    await storage.deleteBookHandle(bookId);
    storage.deleteSavedMeta(bookId);
    storage.deleteThumbnail(bookId).catch(() => {});
    if (meta.fingerprint) storage.deleteLastPage(meta.fingerprint);
    storage.clearSession().catch(() => {});
    if (serverId) await storage.clearQueuedForBook(serverId, bookId);
    setSaved((list) => list.filter((s) => s.bookId !== bookId));
    setActive((a) => (a.bookId === bookId ? { bookId: null, status: STATUS.IDLE, book: null, file: null, error: null } : a));
  }, []);

  const removeStats = useCallback(async (bookId) => {
    const meta = storage.loadSavedMeta()[bookId] || {};
    const serverId = meta.serverId;
    try {
      if (serverId) await api.deleteBookCommits(serverId);
    } catch {}
    await storage.clearQueuedForBook(serverId, bookId);
    storage.clearSession().catch(() => {});
  }, []);

  const close = useCallback(() => {
    activeRef.current = null;
    setActive({ bookId: null, status: STATUS.IDLE, book: null, file: null, error: null });
  }, []);

  const beginReading = useCallback(() => {
    setActive((a) => (a.bookId ? { ...a, status: STATUS.READY, error: null } : a));
  }, []);

  const supportsFileSystem = hasFileSystemAccess();

  return { saved, active, pick, reconnect, stopTracking, forget, removeStats, close, beginReading, persistSavedMeta, renameBook, supportsFileSystem };
}