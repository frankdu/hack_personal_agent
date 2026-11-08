import { createServer } from "node:http";
import type { NodeConfig } from "./config.js";
import { inspectHardware } from "./hardware.js";

export function createNodeServer(config: NodeConfig) {
  let draining = false;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health/live") {
      response.writeHead(draining ? 503 : 200);
      response.end(JSON.stringify({ status: draining ? "draining" : "alive", mode: config.mode }));
    } else if (pathname === "/health/ready") {
      // A responsive process is not proof of a warm model or an accepted backend lease.
      response.writeHead(503);
      response.end(JSON.stringify({ status: "not_ready", reason: draining ? "draining" : "execution_not_implemented" }));
    } else if (pathname === "/v1/node/status") {
      response.writeHead(200);
      response.end(JSON.stringify({
        name: config.name,
        mode: config.mode,
        enabledTools: config.enabledTools,
        hardware: inspectHardware(),
        executionReady: false,
        backendRegistration: "not_implemented",
        modelSupervisor: "not_implemented",
      }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not_found" }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return {
    server,
    drain: () => { draining = true; },
  };
}
