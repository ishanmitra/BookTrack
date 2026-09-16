import { randomBytes } from "node:crypto";

const COOKIE = "bt_session";
const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;

const sessions = new Map();

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s.user;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  req.user = user;
  next();
}

export function startSession(res, user) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, { user, expires: Date.now() + TTL });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: TTL / 1000 });
}

export function endSession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE, { path: "/" });
}