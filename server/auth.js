import { randomBytes } from "node:crypto";

const COOKIE = "bt_session";
const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;

// Secure flag on by default; opt out with COOKIE_SECURE=0 only for plain-http
// localhost deployments (browsers treat localhost as a secure context, so dev
// still works with Secure set).
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "0";

const cookieOpts = () => ({ httpOnly: true, sameSite: "lax", path: "/", maxAge: TTL / 1000, secure: COOKIE_SECURE });

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
  res.cookie(COOKIE, token, cookieOpts());
}

export function endSession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE, { path: "/", secure: COOKIE_SECURE });
}