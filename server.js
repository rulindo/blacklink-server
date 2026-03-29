const WebSocket = require("ws");
const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const http      = require("http");

const PORT        = parseInt(process.env.PORT        || "3000", 10);
const SESSION_TTL = parseInt(process.env.SESSION_TTL || "120000", 10);
const RATE_LIMIT  = parseInt(process.env.RATE_LIMIT  || "20",     10);
const ORIGIN      = process.env.ALLOWED_ORIGIN || "*";

const sessions    = new Map();
const rateLimiter = new Map();

function secureID() { return crypto.randomBytes(16).toString("hex"); }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip) || { count: 0, resetTime: now + 60_000 };
  if (now > entry.resetTime) { rateLimiter.set(ip, { count: 1, resetTime: now + 60_000 }); return true; }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++; rateLimiter.set(ip, entry); return true;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function cleanupSession(id) {
  const s = sessions.get(id); if (!s) return;
  safeSend(s.receiver, { type: "canceled" }); sessions.delete(id);
}

const app = express();
app.use(cors({ origin: ORIGIN }));

app.get("/", (_req, res) => res.send("BLACKLINK v3 — OK"));

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.get("/health", (_req, res) => res.json({
  status: "healthy", activeSessions: sessions.size,
  connectedPeers: wss.clients.size, uptime: Math.floor(process.uptime()),
  memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024), version: "3.0.0"
}));

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let data; try { data = JSON.parse(raw); } catch { safeSend(ws, { type: "error", message: "Invalid JSON" }); return; }
    switch (data.type) {
      case "create": {
        if (!checkRateLimit(ip)) { safeSend(ws, { type: "error", message: "Rate limit exceeded." }); return; }
        if (!data.offer || typeof data.offer !== "object") { safeSend(ws, { type: "error", message: "Invalid offer" }); return; }
        const id = secureID();
        sessions.set(id, { offer: data.offer, metadata: data.metadata || {}, sender: ws, createdAt: Date.now() });
        safeSend(ws, { type: "created", sessionID: id, expiresIn: SESSION_TTL });
        console.log(`Session created: ${id}`); break;
      }
      case "join": {
        const s = sessions.get(data.sessionID);
        if (!s) { safeSend(ws, { type: "error", message: "Session not found." }); return; }
        if (s.receiver) { safeSend(ws, { type: "error", message: "Already has receiver." }); return; }
        s.receiver = ws;
        safeSend(ws, { type: "offer", offer: s.offer, metadata: s.metadata });
        safeSend(s.sender, { type: "peer_joined", sessionID: data.sessionID });
        console.log(`Peer joined: ${data.sessionID}`); break;
      }
      case "answer": {
        const s = sessions.get(data.sessionID);
        if (!s) { safeSend(ws, { type: "error", message: "Session not found." }); return; }
        safeSend(s.sender, { type: "answer", answer: data.answer });
        sessions.delete(data.sessionID); console.log(`Session answered: ${data.sessionID}`); break;
      }
      case "ice": {
        const s = sessions.get(data.sessionID); if (!s) return;
        const target = ws === s.sender ? s.receiver : s.sender;
        safeSend(target, { type: "ice", candidate: data.candidate }); break;
      }
      case "cancel": {
        const s = sessions.get(data.sessionID);
        if (s && s.sender === ws) { cleanupSession(data.sessionID); } break;
      }
      default: safeSend(ws, { type: "error", message: `Unknown: ${data.type}` });
    }
  });
  ws.on("close", () => {
    for (const [id, s] of sessions) {
      if (s.sender === ws) cleanupSession(id);
      else if (s.receiver === ws) { safeSend(s.sender, { type: "peer_disconnected" }); s.receiver = null; }
    }
  });
  ws.on("error", (e) => console.error(`[WS ERROR] ${ip}:`, e.message));
});

setInterval(() => { wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30_000);
setInterval(() => { const now = Date.now(); for (const [id, s] of sessions) { if (now - s.createdAt > SESSION_TTL) cleanupSession(id); } }, 15_000);

server.listen(PORT, () => console.log(`[BLACKLINK v3] Running on port ${PORT} (HTTP + WebSocket)`));
```

5. Scroll down → click **Commit changes**

---

**Step 2 — Railway redeploys automatically**

Watch the Railway dashboard — new build starts in ~10 seconds. This time the health check will pass because HTTP and WebSocket share the same port.

**Step 3 — Verify**

Once it goes green, open in your browser:
```
https://YOUR-APP-NAME.up.railway.app/health
