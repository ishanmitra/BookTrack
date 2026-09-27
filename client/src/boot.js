// Server-resolved session, inlined into the app shell as a
// `type="application/json"` data block (see server/index.js sendShell).
//
// The `bt_session` cookie is httpOnly, so identity cannot be cached in
// localStorage or read by JS — the only way to know the user before the first
// paint is for the server to tell us. This runs at module load, before React
// renders, so the first commit already has the right view.
//
// `type="application/json"` is a data block, not an executable script, so it is
// unaffected by `script-src 'self'` and needs no CSP nonce.

function readSession() {
  if (typeof document === "undefined") return { resolved: false, user: null };
  const el = document.getElementById("bt-session");
  if (!el) return { resolved: false, user: null };
  try {
    const parsed = JSON.parse(el.textContent || "null");
    if (!parsed || typeof parsed !== "object") return { resolved: false, user: null };
    return { resolved: true, user: parsed.user ?? null };
  } catch {
    return { resolved: false, user: null };
  }
}

export const boot = readSession();
