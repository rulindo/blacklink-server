const WebSocket = require("ws");
const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const http      = require("http");

const PORT        = parseInt(process.env.PORT || "3000", 10);
const SESSION_TTL = parseInt(process.env.SESSION_TTL || "120000", 10);
const RATE_LIMIT  = parseInt(process.env.RATE_LIMIT || "20", 10);
const ORIGIN      = process.env.ALLOWED_ORIGIN || "*";

const sessions    = new Map();
const rateLimiter = new Map();

function secureID() { 
  return crypto.randomBytes(16).toString("hex"); 
}

function checkRateLimit(ip) {
  const now = Date.now();
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
  
  safeSend(s.receiver, { type: "canceled" });
  sessions.delete(id);
  console.log(`[Cleanup] Session removed: ${id}`);
}

const app = express();

// Middleware
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());

// Root endpoint
app.get("/", (_req, res) => {
  res.status(200).send("BLACKLINK v3 — OK");
});

// Health check endpoint
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    activeSessions: sessions.size,
    connectedPeers: wss ? wss.clients.size : 0,
    uptime: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    port: PORT,
    version: "3.0.0",
    timestamp: new Date().toISOString()
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: "/ws"
});

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || 
             req.socket.remoteAddress || 
             "unknown";
  
  console.log(`[WS] New connection from ${ip}`);
  
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  
  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      safeSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }
    
    switch (data.type) {
      case "create": {
        if (!checkRateLimit(ip)) {
          safeSend(ws, { type: "error", message: "Rate limit exceeded." });
          return;
        }
        
        if (!data.offer || typeof data.offer !== "object") {
          safeSend(ws, { type: "error", message: "Invalid offer" });
          return;
        }
        
        const id = secureID();
        sessions.set(id, { 
          offer: data.offer, 
          metadata: data.metadata || {}, 
          sender: ws, 
          createdAt: Date.now() 
        });
        
        safeSend(ws, { 
          type: "created", 
          sessionID: id, 
          expiresIn: SESSION_TTL 
        });
        
        console.log(`[Session] Created: ${id} from ${ip}`);
        break;
      }
      
      case "join": {
        const s = sessions.get(data.sessionID);
        
        if (!s) {
          safeSend(ws, { type: "error", message: "Session not found." });
          return;
        }
        
        if (s.receiver) {
          safeSend(ws, { type: "error", message: "Already has receiver." });
          return;
        }
        
        s.receiver = ws;
        safeSend(ws, { 
          type: "offer", 
          offer: s.offer, 
          metadata: s.metadata 
        });
        safeSend(s.sender, { 
          type: "peer_joined", 
          sessionID: data.sessionID 
        });
        
        console.log(`[Session] Peer joined: ${data.sessionID}`);
        break;
      }
      
      case "answer": {
        const s = sessions.get(data.sessionID);
        
        if (!s) {
          safeSend(ws, { type: "error", message: "Session not found." });
          return;
        }
        
        safeSend(s.sender, { 
          type: "answer", 
          answer: data.answer 
        });
        sessions.delete(data.sessionID);
        
        console.log(`[Session] Completed: ${data.sessionID}`);
        break;
      }
      
      case "ice": {
        const s = sessions.get(data.sessionID);
        if (!s) return;
        
        const target = ws === s.sender ? s.receiver : s.sender;
        if (target) {
          safeSend(target, { 
            type: "ice", 
            candidate: data.candidate 
          });
        }
        break;
      }
      
      case "cancel": {
        const s = sessions.get(data.sessionID);
        if (s && s.sender === ws) {
          cleanupSession(data.sessionID);
        }
        break;
      }
      
      default:
        safeSend(ws, { 
          type: "error", 
          message: `Unknown type: ${data.type}` 
        });
    }
  });
  
  ws.on("close", () => {
    console.log(`[WS] Connection closed from ${ip}`);
    
    for (const [id, s] of sessions) {
      if (s.sender === ws) {
        cleanupSession(id);
      } else if (s.receiver === ws) {
        safeSend(s.sender, { type: "peer_disconnected" });
        s.receiver = null;
        console.log(`[Session] Receiver disconnected: ${id}`);
      }
    }
  });
  
  ws.on("error", (e) => {
    console.error(`[WS ERROR] ${ip}:`, e.message);
  });
});

// Heartbeat interval
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

// Session cleanup interval
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) {
      cleanupSession(id);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[Cleanup] Removed ${cleaned} expired sessions`);
  }
}, 15000);

// Server startup
server.on('error', (error) => {
  console.error('[FATAL] Server failed to start:', error);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('=================================');
  console.log('[BLACKLINK v3] Server started successfully');
  console.log(`[HTTP] Listening on port ${PORT}`);
  console.log(`[WebSocket] Endpoint: ws://0.0.0.0:${PORT}/ws`);
  console.log(`[Health] http://0.0.0.0:${PORT}/health`);
  console.log('[Status] Ready to accept connections');
  console.log('=================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received, cleaning up...');
  clearInterval(pingInterval);
  clearInterval(cleanupInterval);
  
  wss.clients.forEach((ws) => {
    ws.close();
  });
  
  server.close(() => {
    console.log('[Shutdown] Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
