const WebSocket = require("ws");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const http = require("http");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

// ============================================
// Configuration
// ============================================
const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_TTL = parseInt(process.env.SESSION_TTL || "120000", 10);
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "20", 10);
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_PAYLOAD = parseInt(process.env.MAX_PAYLOAD || "1048576", 10); // 1MB
const WS_HEARTBEAT = parseInt(process.env.WS_HEARTBEAT || "30000", 10);
const CLEANUP_INTERVAL = parseInt(process.env.CLEANUP_INTERVAL || "15000", 10);

// ============================================
// Data Stores
// ============================================
const sessions = new Map();
const rateLimiter = new Map();
const metrics = {
  totalConnections: 0,
  totalSessions: 0,
  startTime: Date.now(),
};

// ============================================
// Utility Functions
// ============================================
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
  if (!session) return false;

  safeSend(session.receiver, { type: "canceled", reason: "session_expired" });
  sessions.delete(id);
  metrics.totalSessions--;

  console.log(`[Cleanup] Session removed: ${id}`);
  return true;
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ============================================
// Express App Setup
// ============================================
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable if using inline scripts
  crossOriginEmbedderPolicy: false,
}));

// Compression for better performance
app.use(compression());

// CORS configuration
app.use(cors({
  origin: ORIGIN === "*" ? "*" : ORIGIN.split(","),
  credentials: true,
  optionsSuccessStatus: 200,
}));

// Rate limiting for HTTP endpoints
const httpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: "1mb" }));

// ============================================
// HTTP Endpoints
// ============================================
app.get("/", (_req, res) => {
  res.status(200).json({
    name: "BLACKLINK v3",
    status: "operational",
    version: "3.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  const memoryUsage = process.memoryUsage();

  res.status(200).json({
    status: "healthy",
    version: "3.0.0",
    uptime: {
      seconds: uptime,
      formatted: `${Math.floor(uptime / 3600)}h ${Math.floor(
        (uptime % 3600) / 60
      )}m ${uptime % 60}s`,
    },
    sessions: {
      active: sessions.size,
      total: metrics.totalSessions,
    },
    connections: {
      websocket: wss ? wss.clients.size : 0,
      total: metrics.totalConnections,
    },
    memory: {
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024),
    },
    limits: {
      sessionTTL: SESSION_TTL,
      rateLimit: RATE_LIMIT,
      maxPayload: MAX_PAYLOAD,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/metrics", httpRateLimiter, (_req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);

  res.status(200).json({
    sessions: sessions.size,
    connections: wss.clients.size,
    uptime: uptime,
    memory: process.memoryUsage().heapUsed,
  });
});

// ============================================
// WebSocket Server
// ============================================
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: "/ws",
  maxPayload: MAX_PAYLOAD,
  clientTracking: true,
});

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  const ip = getClientIp(req);
  metrics.totalConnections++;

  ws.isAlive = true;
  ws.ip = ip;
  ws.connectedAt = Date.now();

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

    // Validate message structure
    if (!data.type || typeof data.type !== "string") {
      safeSend(ws, { type: "error", message: "Missing message type" });
      return;
    }

    // Process based on message type
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

        metrics.totalSessions++;

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
          safeSend(ws, { type: "error", message: "Missing session ID or answer" });
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
        metrics.totalSessions--;

        console.log(`[Session] Completed: ${data.sessionID}`);
        break;
      }

      case "ice": {
        if (!data.sessionID || !data.candidate) {
          safeSend(ws, { type: "error", message: "Missing ICE candidate data" });
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
    metrics.totalConnections--;
    console.log(`[WS] Connection closed from ${ip} (Remaining: ${wss.clients.size})`);

    // Clean up sessions associated with this connection
    for (const [id, session] of sessions) {
      if (session.sender === ws) {
        cleanupSession(id);
      } else if (session.receiver === ws) {
        safeSend(session.sender, {
          type: "peer_disconnected",
          sessionID: id,
          reason: "peer_disconnected",
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

// ============================================
// Keep-Alive & Cleanup
// ============================================
// WebSocket heartbeat
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_HEARTBEAT);

// Session cleanup
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

  // Clean up rate limiter
  for (const [ip, entry] of rateLimiter) {
    if (Date.now() > entry.resetTime) {
      rateLimiter.delete(ip);
    }
  }
}, CLEANUP_INTERVAL);

// ============================================
// Server Startup
// ============================================
server.on("error", (error) => {
  console.error("[Fatal] Server error:", error);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("BLACKLINK v3 - Production Signaling Server");
  console.log("========================================");
  console.log(`HTTP Server: http://0.0.0.0:${PORT}`);
  console.log(`WebSocket: ws://0.0.0.0:${PORT}/ws`);
  console.log(`Health Check: http://0.0.0.0:${PORT}/health`);
  console.log(`Metrics: http://0.0.0.0:${PORT}/metrics`);
  console.log("----------------------------------------");
  console.log(`Session TTL: ${SESSION_TTL}ms`);
  console.log(`Rate Limit: ${RATE_LIMIT} requests/minute`);
  console.log(`Max Payload: ${MAX_PAYLOAD} bytes`);
  console.log(`Heartbeat: ${WS_HEARTBEAT}ms`);
  console.log("========================================");
  console.log("✅ Server is ready to accept connections");
});

// ============================================
// Graceful Shutdown
// ============================================
process.on("SIGTERM", () => {
  console.log("[Shutdown] SIGTERM received, initiating graceful shutdown...");

  clearInterval(pingInterval);
  clearInterval(cleanupInterval);

  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    safeSend(ws, { type: "shutdown", message: "Server is shutting down" });
    ws.close();
  });

  // Close HTTP server
  server.close(() => {
    console.log("[Shutdown] Server closed successfully");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("[Shutdown] Force exit after timeout");
    process.exit(1);
  }, 10000);
});

// Error handlers
process.on("uncaughtException", (error) => {
  console.error("[Fatal] Uncaught exception:", error);
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Fatal] Unhandled rejection at:", promise, "reason:", reason);
  setTimeout(() => process.exit(1), 1000);
});
