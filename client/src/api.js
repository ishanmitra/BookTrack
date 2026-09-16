const API_KEY = import.meta.env?.VITE_API_KEY || "";

async function request(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(path, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`);
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
  updateBook: (id, patch) => request(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBook: (id) => request(`/api/books/${id}`, { method: "DELETE" }),
  deleteBookCommits: (id) => request(`/api/books/${id}/commits`, { method: "DELETE" }),
  getCommits: (id) => request(`/api/books/${id}/commits`),
  pushCommit: (id, commit) => request(`/api/books/${id}/commits`, { method: "POST", body: JSON.stringify(commit) }),
};

export default api;