import { randomBytes } from "node:crypto";
import * as db from "./db.js";

const COOKIE = "bt_session";
const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;

// Secure flag on by default; opt out with COOKIE_SECURE=0 only for plain-http
// localhost deployments (browsers treat localhost as a secure context, so dev
// still works with Secure set).
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "0";

const cookieOpts = () => ({ httpOnly: true, sameSite: "lax", path: "/", maxAge: TTL, secure: COOKIE_SECURE });

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Sessions live in the DB (survive restarts, indexed lookups, no process
// memory). The token only maps to a user id; the live user row is re-read on
// each request, so role changes take effect immediately and the session never
// caches stale privileges.
//
// Sliding renewal: active users never hit the 30-day wall. On every lookup, a
// session running low (<= 1/3 TTL left) is extended back to a full TTL and the
// cookie's maxAge is refreshed so the browser keeps it too. Nothing is revoked
// — only genuinely idle sessions age out (1/3-TTL window widens on activity).
export function currentUser(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = db.getSession(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.deleteSession(token);
    return null;
  }
  const remaining = s.expires_at - Date.now();
  if (remaining <= TTL / 3 && res) {
    db.extendSession(token, Date.now() + TTL);
    res.cookie(COOKIE, token, cookieOpts());
  }
  return db.getUserById(s.user_id) || null;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req, res);
  if (!user) return res.status(401).json({ error: "sign in required" });
  req.user = user;
  next();
}

export function startSession(res, user) {
  const token = randomBytes(24).toString("hex");
  db.createSession(token, user.id, Date.now() + TTL);
  res.cookie(COOKIE, token, cookieOpts());
}

export function endSession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.deleteSession(token);
  res.clearCookie(COOKIE, { path: "/", secure: COOKIE_SECURE });
}