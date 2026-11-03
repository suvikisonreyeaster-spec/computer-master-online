// Validates and normalises remote-control events before they are forwarded to the customer's desktop app.
const num01 = (v) => typeof v === "number" && v >= 0 && v <= 1;

function sanitizeControl(e) {
  if (!e || typeof e !== "object") return null;
  switch (e.t) {
    case "move":
      return num01(e.x) && num01(e.y) ? { t: "move", x: e.x, y: e.y } : null;
    case "down":
    case "up":
      return num01(e.x) && num01(e.y) && [0, 1, 2].includes(e.b) ? { t: e.t, x: e.x, y: e.y, b: e.b } : null;
    case "wheel":
      return Number.isFinite(e.dy) && Math.abs(e.dy) <= 5000 ? { t: "wheel", dy: e.dy } : null;
    case "key":
      return typeof e.code === "string" && /^[A-Za-z0-9]{1,20}$/.test(e.code) && typeof e.down === "boolean"
        ? { t: "key", code: e.code, down: e.down } : null;
    default:
      return null;
  }
}

module.exports = { sanitizeControl };
