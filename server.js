require("dotenv").config();
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const { createAuth } = require("./auth");
const { sanitizeControl } = require("./control");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
if (process.env.TRUST_PROXY) app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", // join links contain a secret token
  });
  next();
});
app.use(express.json({ limit: "1kb" }));
// Flat layout: serve only these browser files explicitly (never the server code or .env).
for (const f of ["style.css", "join.js"]) {
  app.get("/" + f, (_req, res) => res.sendFile(path.join(__dirname, f)));
}

// ---- Administrator authentication ----
const adminUsername = process.env.ADMIN_USERNAME || "admin";
let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(12).toString("base64url");
  console.warn(`ADMIN_PASSWORD is not set. Temporary admin password for this run (username: ${adminUsername}): ${adminPassword}`);
}
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET is not set. Admin logins will be invalidated on every restart.");
}
const auth = createAuth({ username: adminUsername, password: adminPassword, secret: sessionSecret });

function requireAdmin(req, res, next) {
  if (auth.isAdminCookie(req.headers.cookie)) return next();
  if (req.accepts("html") && req.method === "GET" && !req.path.startsWith("/api/")) return res.redirect("/login");
  res.status(401).json({ error: "Administrator login required." });
}

app.post("/api/login", (req, res) => {
  const ip = req.ip;
  if (auth.isLimited(ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || !auth.checkCredentials(username, password)) {
    auth.recordFailure(ip);
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  auth.clearFailures(ip);
  res.set("Set-Cookie", auth.cookieHeader(auth.createToken(), req.secure));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.set("Set-Cookie", auth.clearCookieHeader(req.secure));
  res.json({ ok: true });
});

app.get("/login", (req, res) => {
  if (auth.isAdminCookie(req.headers.cookie)) return res.redirect("/admin");
  res.sendFile(path.join(__dirname, "login.html"));
});

const PORT = process.env.PORT || 3000;
const TTL = Math.max(1, Number(process.env.INVITE_TTL_MINUTES) || 20);
const invites = new Map(); // MVP only: use a database in production.
const sessions = new Map(); // room -> { admin, customer, label, startedAt }

function cleanExpired() {
  const now = Date.now();
  for (const [token, item] of invites) {
    if (item.expiresAt < now || item.used) invites.delete(token);
  }
}
setInterval(cleanExpired, 30_000).unref();

function waitingSessions() {
  return [...sessions]
    .filter(([, s]) => !s.admin)
    .map(([room, s]) => ({ room, label: s.label, agent: s.agent }));
}

function endSession(room, message) {
  if (!sessions.has(room)) return;
  sessions.delete(room);
  io.to(room).emit("session:ended", message);
  io.in(room).socketsLeave(room);
  io.to("admins").emit("session:gone", { room });
}

app.get("/", (_req, res) => res.redirect("/admin"));
app.get("/admin", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/admin.js", requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, "admin.js")));
app.get("/join/:token", (_req, res) => res.sendFile(path.join(__dirname, "join.html")));

app.post("/api/invites", requireAdmin, (req, res) => {
  cleanExpired();
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + TTL * 60_000;
  invites.set(token, { expiresAt, used: false });
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${origin}/join/${token}`, expiresAt });
});

app.get("/api/invites/:token", (req, res) => {
  cleanExpired();
  const item = invites.get(req.params.token);
  if (!item || item.used || item.expiresAt < Date.now()) {
    return res.status(410).json({ error: "This invitation has expired or was already used." });
  }
  res.json({ valid: true, expiresAt: item.expiresAt });
});

io.on("connection", (socket) => {
  socket.on("customer:join", ({ token, agent } = {}) => {
    if (socket.data.room) return; // already joined
    cleanExpired();
    const invite = invites.get(token);
    if (!invite || invite.used || invite.expiresAt < Date.now()) {
      socket.emit("invite:error", "This invitation has expired or was already used.");
      return;
    }
    invite.used = true;
    // Random room id: do not derive it from the secret invitation token.
    const room = `support-${crypto.randomUUID()}`;
    const label = String(token).slice(0, 8);
    sessions.set(room, { admin: null, customer: socket.id, label, agent: agent === true, controlAllowed: false, startedAt: Date.now() });
    socket.join(room);
    socket.data.room = room;
    socket.emit("customer:ready", { room });
    io.to("admins").emit("session:waiting", { room, label, agent: agent === true });
  });

  socket.on("admin:register", () => {
    // Requires the signed admin cookie and a same-origin handshake.
    const origin = socket.handshake.headers.origin;
    const sameOrigin = !origin || new URL(origin).host === socket.handshake.headers.host;
    if (!sameOrigin || !auth.isAdminCookie(socket.handshake.headers.cookie)) {
      return socket.emit("auth:required");
    }
    socket.data.isAdmin = true;
    socket.join("admins");
    socket.emit("session:list", waitingSessions());
  });

  socket.on("admin:join", ({ room } = {}) => {
    if (!socket.data.isAdmin) return;
    const session = sessions.get(room);
    if (!session) return socket.emit("session:error", "Session is no longer available.");
    if (session.admin && session.admin !== socket.id) {
      return socket.emit("session:error", "Session is already being viewed by another administrator.");
    }
    socket.join(room);
    session.admin = socket.id;
    socket.data.room = room;
    io.to(room).emit("session:admin-ready");
    socket.emit("session:control", { allowed: session.controlAllowed, agent: session.agent });
  });

  socket.on("signal", ({ room, data } = {}) => {
    // Only participants of the room may relay signalling data.
    if (!room || !data || !socket.rooms.has(room) || !sessions.has(room)) return;
    socket.to(room).emit("signal", data);
  });

  // The customer's desktop app grants or revokes remote control at any time.
  // Browser customers can never enable it (they cannot inject input anyway).
  socket.on("customer:control", ({ allowed } = {}) => {
    const room = socket.data.room;
    const session = room && sessions.get(room);
    if (!session || session.customer !== socket.id || !session.agent) return;
    session.controlAllowed = allowed === true;
    io.to(room).emit("session:control", { allowed: session.controlAllowed, agent: true });
  });

  // Administrator input -> customer's desktop app, only while the customer allows control.
  socket.on("control", ({ event } = {}) => {
    const room = socket.data.room;
    const session = room && sessions.get(room);
    if (!socket.data.isAdmin || !session || session.admin !== socket.id || !session.controlAllowed) return;
    const now = Date.now();
    const w = socket.data.ctl || (socket.data.ctl = { start: now, n: 0 });
    if (now - w.start > 1000) { w.start = now; w.n = 0; }
    if (++w.n > 400) return; // flood protection
    const clean = sanitizeControl(event);
    if (clean) io.to(session.customer).emit("control", clean);
  });

  socket.on("session:end", ({ room } = {}) => {
    if (!room || !socket.rooms.has(room)) return;
    endSession(room, "The support session has ended.");
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    const session = room && sessions.get(room);
    if (!session) return;
    if (session.customer === socket.id) {
      endSession(room, "The customer disconnected.");
    } else if (session.admin === socket.id) {
      session.admin = null;
      io.to(room).emit("session:admin-left");
      io.to("admins").emit("session:waiting", { room, label: session.label, agent: session.agent });
    }
  });
});

server.listen(PORT, () => console.log(`Computer Master running on http://localhost:${PORT}`));
