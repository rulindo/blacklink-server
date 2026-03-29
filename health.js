#!/usr/bin/env node
/**
 * Docker HEALTHCHECK script
 * Pings the HTTP health endpoint and exits 0 (healthy) or 1 (unhealthy)
 */
const http = require("http");

const PORT = parseInt(process.env.PORT || "3000", 10);

const req = http.request(
  {
    hostname: "localhost",
    port: PORT,
    path: "/health",
    method: "GET",
    timeout: 3000,
  },
  (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      // Accept both 200 status and healthy JSON response
      if (res.statusCode === 200) {
        try {
          const data = JSON.parse(body);
          process.exit(data.status === "healthy" ? 0 : 1);
        } catch {
          // If JSON parse fails but status is 200, consider it healthy
          process.exit(0);
        }
      } else {
        process.exit(1);
      }
    });
  }
);

req.on("error", () => {
  console.error("Health check failed: connection error");
  process.exit(1);
});

req.on("timeout", () => {
  console.error("Health check failed: timeout");
  req.destroy();
  process.exit(1);
});

req.end();
