#!/usr/bin/env node
/**
 * Docker HEALTHCHECK script
 * Pings the HTTP health endpoint and exits 0 (healthy) or 1 (unhealthy)
 */
const http = require("http");

const req = http.request(
  {
    hostname: "localhost",
    port: parseInt(process.env.HTTP_PORT || "3001", 10),
    path: "/health",
    method: "GET",
    timeout: 2000,
  },
  (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try {
        const data = JSON.parse(body);
        process.exit(data.status === "healthy" ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  }
);

req.on("error",   () => process.exit(1));
req.on("timeout", () => process.exit(1));
req.end();
