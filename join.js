const socket = io();
const token = location.pathname.split("/").pop();
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const preview = document.getElementById("preview");
let stream = null, pc = null, room = null;
let validated = false, joined = false, adminReady = false, finished = false;
let pendingCandidates = [];

// Validate first, then join: joining consumes the one-use invitation, so doing both
// at once made the validation request fail with "already used".
fetch(`/api/invites/${encodeURIComponent(token)}`)
  .then(r => { if (!r.ok) throw new Error("This invitation has expired or was already used."); return r.json(); })
  .then(() => { validated = true; statusEl.textContent = "Connecting…"; tryJoin(); })
  .catch(e => { statusEl.textContent = e.message; });

function tryJoin() {
  if (validated && socket.connected && !joined) {
    joined = true;
    socket.emit("customer:join", { token });
  }
}

socket.on("connect", tryJoin);
socket.on("invite:error", msg => { statusEl.textContent = msg; startBtn.disabled = true; });
socket.on("customer:ready", data => {
  room = data.room;
  startBtn.disabled = false;
  statusEl.textContent = "Invitation valid. Start only if you trust the support administrator.";
});
socket.on("disconnect", () => finish("Connection lost. Please ask for a new link.", false));

// Admin is ready to receive; send the offer (now, or as soon as sharing starts).
socket.on("session:admin-ready", () => {
  adminReady = true;
  if (stream) { statusEl.textContent = "Technician connected. You are sharing your screen."; maybeStartCall(); }
});
socket.on("session:admin-left", () => {
  adminReady = false;
  closePc();
  if (stream) statusEl.textContent = "The technician disconnected. Still sharing; waiting for them to reconnect…";
});

startBtn.onclick = async () => {
  if (!room || finished) return;
  try {
    // The browser/OS displays a permission chooser. Nothing is captured before approval.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    statusEl.textContent = e.name === "NotAllowedError" ? "Screen sharing was not approved. You can try again." : `Unable to share screen: ${e.message}`;
    return; // keep the button enabled so the customer can retry
  }
  preview.srcObject = stream;
  startBtn.disabled = true; stopBtn.disabled = false;
  stream.getVideoTracks()[0].addEventListener("ended", () => finish("Screen sharing stopped. You may close this page.", true));
  statusEl.textContent = adminReady
    ? "You are sharing your screen. You can stop at any time."
    : "Screen selected. Waiting for the technician to connect…";
  maybeStartCall();
};

// Fetched once and cached; kicked off immediately so it's usually already
// resolved by the time a call needs to start (right after page load).
let iceServersPromise = null;
function getIceServers() {
  if (!iceServersPromise) {
    iceServersPromise = fetch("/api/ice-servers")
      .then(r => r.json())
      .then(d => d.iceServers || [{ urls: "stun:stun.l.google.com:19302" }])
      .catch(() => [{ urls: "stun:stun.l.google.com:19302" }]); // fall back if the request fails
  }
  return iceServersPromise;
}
getIceServers();

let startingCall = false;
async function maybeStartCall() {
  if (!stream || !adminReady || pc || !room || finished || startingCall) return;
  startingCall = true;
  try {
    const iceServers = await getIceServers();
    if (pc || finished) return; // superseded while we were awaiting
    const myPc = new RTCPeerConnection({ iceServers });
    pc = myPc;
    pendingCandidates = [];
    stream.getTracks().forEach(track => myPc.addTrack(track, stream));
    myPc.onicecandidate = e => { if (e.candidate) socket.emit("signal", { room, data: e.candidate.toJSON() }); };
    const offer = await myPc.createOffer();
    await myPc.setLocalDescription(offer);
    if (pc === myPc) socket.emit("signal", { room, data: myPc.localDescription.toJSON() });
  } catch (e) {
    statusEl.textContent = `Unable to start the connection: ${e.message}`;
  } finally {
    startingCall = false;
  }
}

async function addCandidate(c) {
  try { await pc.addIceCandidate(c); } catch { /* ignore stale candidates */ }
}

socket.on("signal", async data => {
  if (!pc || !data) return;
  try {
    if (data.type === "answer") {
      await pc.setRemoteDescription(data);
      for (const c of pendingCandidates) await addCandidate(c);
      pendingCandidates = [];
    } else if (data.candidate) {
      if (pc.remoteDescription) await addCandidate(data);
      else pendingCandidates.push(data);
    }
  } catch (e) {
    statusEl.textContent = `Connection error: ${e.message}`;
  }
});

socket.on("session:ended", msg => finish(msg, false));
stopBtn.onclick = () => finish("Screen sharing stopped. You may close this page.", true);

function closePc() {
  if (pc) pc.close();
  pc = null; pendingCandidates = [];
}

function finish(message, notifyServer) {
  if (finished) return;
  finished = true;
  if (notifyServer && room) socket.emit("session:end", { room });
  if (stream) stream.getTracks().forEach(t => t.stop());
  closePc();
  stream = null; preview.srcObject = null;
  startBtn.disabled = true; stopBtn.disabled = true;
  statusEl.textContent = message;
}
