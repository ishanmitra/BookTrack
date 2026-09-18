const API_KEY = import.meta.env?.VITE_API_KEY || "";

async function request(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(path, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const j = JSON.parse(text);
      if (j && j.error) detail = j.error;
    } catch {}
    const err = new Error(detail || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const api = {
  me: () => request("/api/auth/me"),
  signIn: () => {
    window.location.href = "/api/auth/github";
  },
  logout: () => request("/api/auth/logout", { method: "POST" }),
  listBooks: () => request("/api/books"),
  upsertBook: (b) => request("/api/books", { method: "POST", body: JSON.stringify(b) }),
  getBook: (id) => request(`/api/books/${id}`),
  getBookBySlug: (slug) => request(`/api/book/${slug}`),
  updateBook: (id, patch) => request(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBook: (id) => request(`/api/books/${id}`, { method: "DELETE" }),
  deleteBookCommits: (id) => request(`/api/books/${id}/commits`, { method: "DELETE" }),
  getCommits: (id) => request(`/api/books/${id}/commits`),
  meStats: () => request("/api/me/stats"),
  getProfile: async (username) => {
    const r = await fetch("/api/users/" + encodeURIComponent(username));
    if (r.status === 404) return { notFound: true };
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  },
  pushCommit: (id, commit) => request(`/api/books/${id}/commits`, { method: "POST", body: JSON.stringify(commit) }),
  pendingBooks: () => request("/api/books/pending"),
  retiredBooks: () => request("/api/books/retired"),
  adminRole: () => request("/api/admin/role"),
  bindBook: (fingerprintId, patch = {}) => request(`/api/books/bind/${fingerprintId}`, { method: "POST", body: JSON.stringify(patch) }),
  reactivateBook: (id) => request(`/api/books/reactivate/${id}`, { method: "POST" }),
  adminUsers: () => request("/api/admin/users"),
  setUserRole: (id, role) => request(`/api/admin/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
  transferSuperAdmin: (userId) => request("/api/admin/transfer", { method: "POST", body: JSON.stringify({ userId }) }),
  deleteMe: () => request("/api/me", { method: "DELETE" }),
};

export default api;