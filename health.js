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
  headers: {
    "User-Agent": "BLACKLINK-HealthCheck/3.0",
  },
};

const req = http.request(options, (res) => {
  let body = "";

  res.on("data", (chunk) => {
    body += chunk;
  });

  res.on("end", () => {
    // Check status code
    if (res.statusCode !== 200) {
      console.error(`Health check failed: HTTP ${res.statusCode}`);
      process.exit(1);
    }

    // Try to parse and validate JSON response
    try {
      const data = JSON.parse(body);

      // Check if status is "healthy"
      if (data.status === "healthy") {
        console.log(`Health check passed: ${data.sessions.active} sessions active`);
        process.exit(0);
      } else {
        console.error(`Health check failed: status = ${data.status}`);
        process.exit(1);
      }
    } catch (error) {
      // If response is not JSON but status is 200, consider it healthy
      console.log("Health check passed (non-JSON response)");
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
