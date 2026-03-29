const WebSocket = require("ws");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const http = require("http");

const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_TTL = parseInt(process.env.SESSION_TTL || "120000", 10);
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "20", 10);
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const sessions = new Map();
const rateLimiter = new Map();

function secureID() {
  return crypto.randomBytes(16).toString("hex");
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip) || { count: 0, resetTime: now + 60000 };

  if (now > entry.resetTime) {
    rateLimiter.set(ip, { count: 1, resetTime: now + 60000 });
    return true;
  }

  if (entry.count >= RATE_LIMIT) return false;

  entry.count++;
  rateLimiter.set(ip, entry);
  return true;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.error("[Send Error]", error.message);
      return false;
    }
  }
  return false;
}

function cleanupSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  safeSend(session.receiver, { type: "canceled" });
  sessions.delete(id);
  console.log(`[Cleanup] Session removed: ${id}`);
}

const app = express();
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).json({
    name: "BLACKLINK v3",
    status: "operational",
    version: "3.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    activeSessions: sessions.size,
    connectedPeers: wss ? wss.clients.size : 0,
    uptime: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    port: PORT,
    version: "3.0.0",
    timestamp: new Date().toISOString(),
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: "/ws",
});

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  console.log(`[WS] New connection from ${ip} (Total: ${wss.clients.size})`);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      safeSend(ws, { type: "error", message: "Invalid JSON format" });
      return;
    }

    if (!data.type || typeof data.type !== "string") {
      safeSend(ws, { type: "error", message: "Missing message type" });
      return;
    }

    switch (data.type) {
      case "create": {
        if (!checkRateLimit(ip)) {
          safeSend(ws, {
            type: "error",
            message: "Rate limit exceeded. Please wait.",
          });
          return;
        }

        if (!data.offer || typeof data.offer !== "object") {
          safeSend(ws, { type: "error", message: "Invalid offer data" });
          return;
        }

        const id = secureID();
        sessions.set(id, {
          offer: data.offer,
          metadata: data.metadata || {},
          sender: ws,
          createdAt: Date.now(),
        });

        safeSend(ws, {
          type: "created",
          sessionID: id,
          expiresIn: SESSION_TTL,
          timestamp: Date.now(),
        });

        console.log(`[Session] Created: ${id} from ${ip}`);
        break;
      }

      case "join": {
        if (!data.sessionID || typeof data.sessionID !== "string") {
          safeSend(ws, { type: "error", message: "Invalid session ID" });
          return;
        }

        const session = sessions.get(data.sessionID);

        if (!session) {
          safeSend(ws, { type: "error", message: "Session not found" });
          return;
        }

        if (session.receiver) {
          safeSend(ws, { type: "error", message: "Session already has a peer" });
          return;
        }

        session.receiver = ws;
        safeSend(ws, {
          type: "offer",
          offer: session.offer,
          metadata: session.metadata,
          sessionID: data.sessionID,
        });

        safeSend(session.sender, {
          type: "peer_joined",
          sessionID: data.sessionID,
          timestamp: Date.now(),
        });

        console.log(`[Session] Peer joined: ${data.sessionID}`);
        break;
      }

      case "answer": {
        if (!data.sessionID || !data.answer) {
          safeSend(ws, {
            type: "error",
            message: "Missing session ID or answer",
          });
          return;
        }

        const session = sessions.get(data.sessionID);

        if (!session) {
          safeSend(ws, { type: "error", message: "Session not found" });
          return;
        }

        safeSend(session.sender, {
          type: "answer",
          answer: data.answer,
          sessionID: data.sessionID,
        });

        sessions.delete(data.sessionID);

        console.log(`[Session] Completed: ${data.sessionID}`);
        break;
      }

      case "ice": {
        if (!data.sessionID || !data.candidate) {
          return;
        }

        const session = sessions.get(data.sessionID);
        if (!session) return;

        const target = ws === session.sender ? session.receiver : session.sender;
        if (target) {
          safeSend(target, {
            type: "ice",
            candidate: data.candidate,
            sessionID: data.sessionID,
          });
        }
        break;
      }

      case "cancel": {
        if (!data.sessionID) {
          safeSend(ws, { type: "error", message: "Missing session ID" });
          return;
        }

        const session = sessions.get(data.sessionID);
        if (session && session.sender === ws) {
          cleanupSession(data.sessionID);
        }
        break;
      }

      default:
        safeSend(ws, {
          type: "error",
          message: `Unknown message type: ${data.type}`,
        });
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Connection closed from ${ip} (Remaining: ${wss.clients.size})`);

    for (const [id, session] of sessions) {
      if (session.sender === ws) {
        cleanupSession(id);
      } else if (session.receiver === ws) {
        safeSend(session.sender, {
          type: "peer_disconnected",
          sessionID: id,
        });
        session.receiver = null;
        console.log(`[Session] Peer disconnected: ${id}`);
      }
    }
  });

  ws.on("error", (error) => {
    console.error(`[WS Error] ${ip}:`, error.message);
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) {
      cleanupSession(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[Cleanup] Removed ${cleaned} expired sessions`);
  }

  for (const [ip, entry] of rateLimiter) {
    if (Date.now() > entry.resetTime) {
      rateLimiter.delete(ip);
    }
  }
}, 15000);

server.on("error", (error) => {
  console.error("[Fatal] Server error:", error);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("BLACKLINK v3 - Signaling Server");
  console.log("========================================");
  console.log(`HTTP Server: http://0.0.0.0:${PORT}`);
  console.log(`WebSocket: ws://0.0.0.0:${PORT}/ws`);
  console.log(`Health Check: http://0.0.0.0:${PORT}/health`);
  console.log("----------------------------------------");
  console.log(`Session TTL: ${SESSION_TTL}ms`);
  console.log(`Rate Limit: ${RATE_LIMIT} requests/minute`);
  console.log("========================================");
  console.log("✅ Server is ready");
});

process.on("SIGTERM", () => {
  console.log("[Shutdown] SIGTERM received, cleaning up...");
  clearInterval(pingInterval);
  clearInterval(cleanupInterval);

  wss.clients.forEach((ws) => {
    safeSend(ws, { type: "shutdown", message: "Server is shutting down" });
    ws.close();
  });

  server.close(() => {
    console.log("[Shutdown] Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[Shutdown] Force exit");
    process.exit(1);
  }, 10000);
});

process.on("uncaughtException", (error) => {
  console.error("[Fatal] Uncaught exception:", error);
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Fatal] Unhandled rejection at:", promise, "reason:", reason);
  setTimeout(() => process.exit(1), 1000);
});
