import { getUserId } from "./storage";

const API_KEY = import.meta.env?.VITE_API_KEY || "";
const ADMIN_TOKEN = import.meta.env?.VITE_ADMIN_TOKEN || "";
const userIdParam = () => `userId=${encodeURIComponent(getUserId())}`;

async function request(path, opts = {}) {
  const { admin, ...rest } = opts;
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  if (admin && ADMIN_TOKEN) headers["x-admin-key"] = ADMIN_TOKEN;
  const res = await fetch(path, {
    ...rest,
    headers: { ...headers, ...(rest.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`);
  }
  return res.json();
}

const api = {
  listBooks: () => request("/api/books"),
  upsertBook: (b) => request("/api/books", { method: "POST", body: JSON.stringify(b) }),
  getBook: (id) => request(`/api/books/${id}`),
  updateBook: (id, patch) => request(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBook: (id) => request(`/api/books/${id}`, { method: "DELETE", admin: true }),
  deleteBookCommits: (id) => request(`/api/books/${id}/commits?${userIdParam()}`, { method: "DELETE" }),
  getCommits: (id) => request(`/api/books/${id}/commits?${userIdParam()}`),
  pushCommit: (id, commit) =>
    request(`/api/books/${id}/commits`, { method: "POST", body: JSON.stringify({ ...commit, userId: getUserId() }) }),
};

export default api;