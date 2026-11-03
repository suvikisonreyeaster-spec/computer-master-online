const socket = io();
const createBtn = document.getElementById("create");
const inviteBox = document.getElementById("invite");
const sessionsBox = document.getElementById("sessions");
const video = document.getElementById("screen");
const endBtn = document.getElementById("end");
const statusEl = document.getElementById("status");
let currentRoom = null;
let pc = null;
let pendingCandidates = [];
const waiting = new Map(); // room -> { label, agent }
const controlBtn = document.getElementById("control");
let controlAllowed = false, controlOn = false, lastMove = 0, lastPoint = null;
const pressedKeys = new Set(), buttonsDown = new Set();

socket.on("connect", () => socket.emit("admin:register"));
socket.on("auth:required", () => { location.href = "/login"; });
document.getElementById("logout").onclick = async () => {
  try { await fetch("/api/logout", { method: "POST" }); } finally { location.href = "/login"; }
};

createBtn.onclick = async () => {
  createBtn.disabled = true;
  try {
    const res = await fetch("/api/invites", { method: "POST" });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) throw new Error("request failed");
    const data = await res.json();
    inviteBox.classList.remove("hidden");
    inviteBox.innerHTML = `<strong>One-time support link</strong><p><a id="link" target="_blank" rel="noopener"></a></p><button id="copy">Copy link</button> <a id="wa" target="_blank" rel="noopener">Share on WhatsApp</a> · <a id="mail">Share by Gmail</a><p class="muted">Expires: ${new Date(data.expiresAt).toLocaleString()}</p>`;
    const link = document.getElementById("link");
    link.href = data.url; link.textContent = data.url;
    document.getElementById("copy").onclick = async () => {
      try { await navigator.clipboard.writeText(data.url); } catch { alert("Could not copy. Please copy the link manually."); }
    };
    document.getElementById("wa").href = `https://wa.me/?text=${encodeURIComponent("Please open this secure support invitation: " + data.url)}`;
    document.getElementById("mail").href = `mailto:?subject=${encodeURIComponent("Computer support invitation")}&body=${encodeURIComponent("Please open this support invitation: " + data.url)}`;
  } catch { alert("Could not create invitation."); }
  finally { createBtn.disabled = false; }
};

function renderWaiting() {
  sessionsBox.replaceChildren();
  if (!waiting.size) { sessionsBox.textContent = "Waiting for a customer to connect…"; return; }
  for (const [room, info] of waiting) {
    const row = document.createElement("div");
    const text = document.createElement("p");
    text.append("Customer connected and waiting for admin: ");
    const b = document.createElement("b");
    b.textContent = `${info.label}…`;
    text.append(b, info.agent ? " (desktop app — remote control available)" : " (browser — view only)");
    const btn = document.createElement("button");
    btn.textContent = "View customer screen";
    btn.onclick = () => connectTo(room);
    row.append(text, btn);
    sessionsBox.append(row);
  }
}

function connectTo(room) {
  if (currentRoom) { alert("End the current session first."); return; }
  currentRoom = room;
  waiting.delete(room);
  renderWaiting();
  socket.emit("admin:join", { room });
  statusEl.textContent = "Connecting to customer…";
  endBtn.disabled = false;
}

socket.on("session:list", list => {
  waiting.clear();
  list.forEach(s => waiting.set(s.room, { label: s.label, agent: s.agent }));
  renderWaiting();
});
socket.on("session:waiting", ({ room, label, agent }) => {
  if (room === currentRoom) return;
  waiting.set(room, { label, agent });
  renderWaiting();
});
socket.on("session:gone", ({ room }) => { waiting.delete(room); renderWaiting(); });
socket.on("session:error", msg => { statusEl.textContent = msg; cleanup(); });

async function addCandidate(c) {
  try { await pc.addIceCandidate(c); } catch { /* ignore stale candidates */ }
}

socket.on("signal", async data => {
  if (!pc || !data) return;
  const activePc = pc;
  try {
    if (data.type === "offer") {
      await activePc.setRemoteDescription(data);
      for (const c of pendingCandidates) await addCandidate(c);
      pendingCandidates = [];
      const answer = await activePc.createAnswer();
      await activePc.setLocalDescription(answer);
      if (pc === activePc) socket.emit("signal", { room: currentRoom, data: activePc.localDescription.toJSON() });
    } else if (data.candidate) {
      if (activePc.remoteDescription) await addCandidate(data);
      else pendingCandidates.push(data); // offer not processed yet
    }
  } catch (err) {
    statusEl.textContent = `Connection error: ${err.message}`;
  }
});

socket.on("session:admin-ready", () => {
  if (!currentRoom) return;
  if (pc) pc.close();
  pendingCandidates = [];
  pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  pc.ontrack = e => { video.srcObject = e.streams[0]; statusEl.textContent = "Live screen sharing"; };
  pc.onicecandidate = e => { if (e.candidate) socket.emit("signal", { room: currentRoom, data: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === "failed") statusEl.textContent = "Connection failed. A TURN server may be required.";
  };
  statusEl.textContent = "Waiting for customer to start screen sharing…";
});

endBtn.onclick = () => {
  if (currentRoom) socket.emit("session:end", { room: currentRoom });
  cleanup();
};
socket.on("session:ended", msg => { statusEl.textContent = msg; cleanup(); });
function cleanup() {
  releaseControl(); controlAllowed = false; controlBtn.disabled = true;
  if (pc) pc.close();
  pc = null; pendingCandidates = []; currentRoom = null; video.srcObject = null; endBtn.disabled = true;
}

// ---- Remote control (desktop app only; the customer must allow it) ----
socket.on("session:control", ({ allowed, agent }) => {
  controlAllowed = !!(allowed && agent);
  controlBtn.disabled = !controlAllowed;
  if (!controlAllowed) releaseControl();
  if (agent) statusEl.textContent = controlAllowed
    ? "Customer allowed remote control. Click “Take control”."
    : "Remote control is off (the customer has not allowed it, or paused it).";
});
controlBtn.onclick = () => (controlOn ? releaseControl() : takeControl());

function takeControl() {
  if (!controlAllowed || !currentRoom) return;
  controlOn = true;
  controlBtn.textContent = "Release control";
  video.classList.add("controlling");
  video.focus();
}
function releaseControl() {
  if (controlOn) {
    for (const code of pressedKeys) sendControl({ t: "key", code, down: false });
    if (lastPoint) for (const b of buttonsDown) sendControl({ t: "up", ...lastPoint, b });
  }
  pressedKeys.clear(); buttonsDown.clear();
  controlOn = false;
  controlBtn.textContent = "Take control";
  video.classList.remove("controlling");
}
function sendControl(event) { if (currentRoom) socket.emit("control", { event }); }

// Map a mouse position to 0..1 coordinates of the shared screen (accounts for letterboxing).
function videoPoint(e) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const r = video.getBoundingClientRect();
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  const x = (e.clientX - (r.left + (r.width - w) / 2)) / w;
  const y = (e.clientY - (r.top + (r.height - h) / 2)) / h;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

video.addEventListener("mousemove", e => {
  if (!controlOn) return;
  const now = performance.now();
  if (now - lastMove < 16) return;
  lastMove = now;
  const p = videoPoint(e);
  if (p) { lastPoint = p; sendControl({ t: "move", ...p }); }
});
video.addEventListener("mousedown", e => {
  if (!controlOn) return;
  e.preventDefault(); video.focus();
  const p = videoPoint(e);
  if (p && e.button <= 2) { lastPoint = p; buttonsDown.add(e.button); sendControl({ t: "down", ...p, b: e.button }); }
});
window.addEventListener("mouseup", e => {
  if (!controlOn || !buttonsDown.has(e.button)) return;
  buttonsDown.delete(e.button);
  const p = videoPoint(e) || lastPoint;
  if (p) sendControl({ t: "up", ...p, b: e.button });
});
video.addEventListener("contextmenu", e => { if (controlOn) e.preventDefault(); });
video.addEventListener("wheel", e => { if (!controlOn) return; e.preventDefault(); sendControl({ t: "wheel", dy: e.deltaY }); }, { passive: false });
video.addEventListener("keydown", e => {
  if (!controlOn) return;
  e.preventDefault(); pressedKeys.add(e.code); sendControl({ t: "key", code: e.code, down: true });
});
video.addEventListener("keyup", e => {
  if (!controlOn) return;
  e.preventDefault(); pressedKeys.delete(e.code); sendControl({ t: "key", code: e.code, down: false });
});
video.addEventListener("blur", () => {
  for (const code of pressedKeys) sendControl({ t: "key", code, down: false });
  pressedKeys.clear();
});
