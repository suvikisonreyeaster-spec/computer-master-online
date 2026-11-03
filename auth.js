const crypto = require("crypto");

const COOKIE = "admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

function createAuth({ username, password, secret }) {
  const failures = new Map(); // ip -> { count, resetAt }

  const sign = (value) => crypto.createHmac("sha256", secret).update(value).digest("base64url");

  function checkCredentials(inputUser, inputPass) {
    // Hash both sides so comparisons are constant-time regardless of length.
    // Both are always evaluated so timing does not reveal which one was wrong.
    const userOk = crypto.timingSafeEqual(sha(inputUser), sha(username));
    const passOk = crypto.timingSafeEqual(sha(inputPass), sha(password));
    return userOk && passOk;
  }

  function createToken(now = Date.now()) {
    const exp = String(now + SESSION_TTL_MS);
    return `${exp}.${sign(exp)}`;
  }

  function verifyToken(token, now = Date.now()) {
    if (typeof token !== "string") return false;
    const [exp, sig] = token.split(".");
    if (!exp || !sig || !/^\d+$/.test(exp)) return false;
    const expected = sign(exp);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Number(exp) > now;
  }

  function parseCookies(header = "") {
    const out = {};
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  const isAdminCookie = (header) => verifyToken(parseCookies(header)[COOKIE]);

  function isLimited(ip, now = Date.now()) {
    const f = failures.get(ip);
    if (!f) return false;
    if (f.resetAt < now) { failures.delete(ip); return false; }
    return f.count >= MAX_FAILURES;
  }
  function recordFailure(ip, now = Date.now()) {
    const f = failures.get(ip);
    if (!f || f.resetAt < now) failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    else f.count++;
  }
  const clearFailures = (ip) => failures.delete(ip);

  const cookieHeader = (token, secure) =>
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
  const clearCookieHeader = (secure) =>
    `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;

  return { checkCredentials, createToken, verifyToken, parseCookies, isAdminCookie,
           isLimited, recordFailure, clearFailures, cookieHeader, clearCookieHeader };
}

module.exports = { createAuth };
