const DB_NAME = "book-tracker";
const DB_VERSION = 2;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const store of ["handles", "queue", "sessions", "thumbnails"]) {
        if (!d.objectStoreNames.contains(store)) d.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function op(store, mode, fn) {
  const db = await open();
  return reqAsPromise(fn(db.transaction(store, mode).objectStore(store)));
}

export const idbPut = (store, key, value) => op(store, "readwrite", (s) => s.put(value, key));
export const idbGet = (store, key) => op(store, "readonly", (s) => s.get(key));
export const idbGetAll = (store) => op(store, "readonly", (s) => s.getAll());
export const idbGetAllKeys = (store) => op(store, "readonly", (s) => s.getAllKeys());
export const idbDelete = (store, key) => op(store, "readwrite", (s) => s.delete(key));

export async function saveBookHandle(bookId, handle) {
  await idbPut("handles", bookId, handle);
}
export function getBookHandle(bookId) {
  return idbGet("handles", bookId);
}
export async function listSavedBookIds() {
  return idbGetAllKeys("handles");
}
export function deleteBookHandle(bookId) {
  return idbDelete("handles", bookId);
}

export async function enqueueCommit(commit) {
  const key = `${commit.sessionId}`;
  await idbPut("queue", key, commit);
}
export function listQueuedCommits() {
  return idbGetAll("queue");
}
export function removeQueuedCommit(sessionId) {
  return idbDelete("queue", sessionId);
}

const CURRENT_SESSION_KEY = "current";
export function saveSession(session) {
  return idbPut("sessions", CURRENT_SESSION_KEY, session);
}
export function getPendingSession() {
  return idbGet("sessions", CURRENT_SESSION_KEY);
}
export function clearSession() {
  return idbDelete("sessions", CURRENT_SESSION_KEY);
}

export async function saveThumbnail(bookId, dataUrl) {
  await idbPut("thumbnails", bookId, { bookId, dataUrl });
}
export async function getThumbnails() {
  return (await idbGetAll("thumbnails")) || [];
}
export function deleteThumbnail(bookId) {
  return idbDelete("thumbnails", bookId);
}

const META_KEY = "book-tracker:meta";

export function loadSavedMeta() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "{}");
  } catch {
    return {};
  }
}

export function saveMetaFor(bookId, meta) {
  const all = loadSavedMeta();
  all[bookId] = { ...(all[bookId] || {}), ...meta };
  localStorage.setItem(META_KEY, JSON.stringify(all));
}

export function deleteSavedMeta(bookId) {
  const all = loadSavedMeta();
  delete all[bookId];
  localStorage.setItem(META_KEY, JSON.stringify(all));
}

export async function clearQueuedForBook(...ids) {
  const queued = await idbGetAll("queue");
  for (const c of queued) {
    if (ids.includes(c.bookId)) await idbDelete("queue", c.sessionId);
  }
}

export function getDeviceId() {
  let id = localStorage.getItem("book-tracker:device");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("book-tracker:device", id);
  }
  return id;
}

const LAST_PAGE_KEY = "book-tracker:lastpage";

export function getLastPage(fingerprint) {
  try {
    return JSON.parse(localStorage.getItem(LAST_PAGE_KEY) || "{}")[fingerprint] || 1;
  } catch {
    return 1;
  }
}

export function saveLastPage(fingerprint, page) {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_PAGE_KEY) || "{}");
    map[fingerprint] = page;
    localStorage.setItem(LAST_PAGE_KEY, JSON.stringify(map));
  } catch {}
}

export function deleteLastPage(fingerprint) {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_PAGE_KEY) || "{}");
    delete map[fingerprint];
    localStorage.setItem(LAST_PAGE_KEY, JSON.stringify(map));
  } catch {}
}