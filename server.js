/**
 * BLACKLINK v3 — Production Signaling Server
 * Handles WebRTC session negotiation only.
 * No file data ever passes through this server.
 */

const WebSocket = require("ws");
const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const http      = require("http");

// ─── Config ────────────────────────────────────────────────────────────────
const WS_PORT       = parseInt(process.env.PORT   || "3000", 10);
const HTTP_PORT     = parseInt(process.env.HTTP_PORT || "3001", 10);
const SESSION_TTL   = parseInt(process.env.SESSION_TTL || "120000", 10); // 2 min
const RATE_LIMIT    = parseInt(process.env.RATE_LIMIT  || "20",     10); // per min
const ORIGIN        = process.env.ALLOWED_ORIGIN || "*";

// ─── State ─────────────────────────────────────────────────────────────────
/** @type {Map<string, {offer, metadata, sender: WebSocket, receiver?: WebSocket, createdAt: number}>} */
const sessions    = new Map();
/** @type {Map<string, {count: number, resetTime: number}>} */
const rateLimiter = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────
function secureID() {
  return crypto.randomBytes(16).toString("hex");
}

function checkRateLimit(ip) {
  const now  = Date.now();
  const entry = rateLimiter.get(ip) || { count: 0, resetTime: now + 60_000 };
  if (now > entry.resetTime) {
    rateLimiter.set(ip, { count: 1, resetTime: now + 60_000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  rateLimiter.set(ip, entry);
  return true;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function cleanupSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  safeSend(s.receiver, { type: "canceled", reason: "session_cleaned" });
  sessions.delete(id);
}

// ─── WebSocket Server ──────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  const clientIP =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      safeSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (data.type) {

      // ── Sender creates a session ──────────────────────────────────────
      case "create": {
        if (!checkRateLimit(clientIP)) {
          safeSend(ws, { type: "error", message: "Rate limit exceeded. Try again later." });
          return;
        }
        if (!data.offer || typeof data.offer !== "object") {
          safeSend(ws, { type: "error", message: "Invalid offer" });
          return;
        }

        const id = secureID();
        sessions.set(id, {
          offer:     data.offer,
          metadata:  data.metadata || {},
          sender:    ws,
          createdAt: Date.now(),
        });

        safeSend(ws, {
          type:      "created",
          sessionID: id,
          expiresIn: SESSION_TTL,
        });

        console.log(`[${new Date().toISOString()}] Session created: ${id} (${clientIP})`);
        break;
      }

      // ── Receiver joins a session ──────────────────────────────────────
      case "join": {
        const session = sessions.get(data.sessionID);
        if (!session) {
          safeSend(ws, { type: "error", message: "Session not found or expired." });
          return;
        }
        if (session.receiver) {
          safeSend(ws, { type: "error", message: "Session already has a receiver." });
          return;
        }

        session.receiver = ws;
        safeSend(ws, {
          type:     "offer",
          offer:    session.offer,
          metadata: session.metadata,
        });

        // Notify sender that someone joined
        safeSend(session.sender, { type: "peer_joined", sessionID: data.sessionID });

        console.log(`[${new Date().toISOString()}] Peer joined session: ${data.sessionID}`);
        break;
      }

      // ── Receiver sends answer back to sender ──────────────────────────
      case "answer": {
        const session = sessions.get(data.sessionID);
        if (!session) {
          safeSend(ws, { type: "error", message: "Session not found." });
          return;
        }
        if (!data.answer || typeof data.answer !== "object") {
          safeSend(ws, { type: "error", message: "Invalid answer" });
          return;
        }

        safeSend(session.sender, { type: "answer", answer: data.answer });

        // Signaling done — delete session record
        sessions.delete(data.sessionID);
        console.log(`[${new Date().toISOString()}] Session answered + removed: ${data.sessionID}`);
        break;
      }

      // ── ICE candidate relay ───────────────────────────────────────────
      case "ice": {
        const session = sessions.get(data.sessionID);
        if (!session) return;

        const target = ws === session.sender ? session.receiver : session.sender;
        safeSend(target, { type: "ice", candidate: data.candidate });
        break;
      }

      // ── Sender cancels session ────────────────────────────────────────
      case "cancel": {
        const session = sessions.get(data.sessionID);
        if (session && session.sender === ws) {
          cleanupSession(data.sessionID);
          console.log(`[${new Date().toISOString()}] Session canceled: ${data.sessionID}`);
        }
        break;
      }

      default:
        safeSend(ws, { type: "error", message: `Unknown message type: ${data.type}` });
    }
  });

  ws.on("close", () => {
    // Clean up any sessions owned by this socket
    for (const [id, session] of sessions) {
      if (session.sender === ws) {
        cleanupSession(id);
      } else if (session.receiver === ws) {
        safeSend(session.sender, { type: "peer_disconnected" });
        session.receiver = null;
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[WS ERROR] ${clientIP}:`, err.message);
  });
});

// ─── Heartbeat (detect stale connections) ─────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("close", () => clearInterval(heartbeat));

// ─── Session TTL cleanup ───────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) {
      console.log(`[${new Date().toISOString()}] Session expired: ${id}`);
      cleanupSession(id);
    }
  }
}, 15_000);

// ─── HTTP Health / Stats ───────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: ORIGIN }));

app.get("/health", (_req, res) => {
  res.json({
    status:         "healthy",
    activeSessions: sessions.size,
    connectedPeers: wss.clients.size,
    uptime:         Math.floor(process.uptime()),
    memoryMB:       Math.round(process.memoryUsage().rss / 1024 / 1024),
    version:        "3.0.0",
  });
});

app.get("/", (_req, res) => {
  res.send("BLACKLINK v3 Signaling Server — OK");
});

app.listen(HTTP_PORT, () => {
  console.log(`[BLACKLINK v3] HTTP health server on port ${HTTP_PORT}`);
});

console.log(`[BLACKLINK v3] WebSocket signaling server on port ${WS_PORT}`);
console.log(`[BLACKLINK v3] Session TTL: ${SESSION_TTL}ms | Rate limit: ${RATE_LIMIT}/min`);
