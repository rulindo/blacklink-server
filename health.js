#!/usr/bin/env node
/**
 * Docker HEALTHCHECK script
 * Pings the HTTP health endpoint and exits 0 (healthy) or 1 (unhealthy)
 */
const http = require("http");

const PORT = parseInt(process.env.PORT || "3000", 10);
const TIMEOUT = parseInt(process.env.HEALTH_TIMEOUT || "3000", 10);

const options = {
  hostname: "localhost",
  port: PORT,
  path: "/health",
  method: "GET",
  timeout: TIMEOUT,
};

const req = http.request(options, (res) => {
  let body = "";

  res.on("data", (chunk) => {
    body += chunk;
  });

  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.error(`Health check failed: HTTP ${res.statusCode}`);
      process.exit(1);
    }

    try {
      const data = JSON.parse(body);
      if (data.status === "healthy") {
        console.log(`Health check passed: ${data.activeSessions} active sessions`);
        process.exit(0);
      } else {
        console.error(`Health check failed: status = ${data.status}`);
        process.exit(1);
      }
    } catch (error) {
      console.log("Health check passed");
      process.exit(0);
    }
  });
});

req.on("error", (error) => {
  console.error(`Health check failed: ${error.message}`);
  process.exit(1);
});

req.on("timeout", () => {
  console.error(`Health check failed: timeout after ${TIMEOUT}ms`);
  req.destroy();
  process.exit(1);
});

req.end();
