import { stat } from "node:fs/promises";
import { readConfig } from "./config.js";
import { PiSessions } from "./pi-session.js";
import { createNodeServer } from "./server.js";

async function main() {
  const config = readConfig();
  if (!(await stat(config.workspaceDir)).isDirectory()) throw new Error("AGENT_WORKSPACE_DIR must be a directory");
  const sessions = new PiSessions(config);
  const { server, drain } = createNodeServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.info(JSON.stringify({ event: "node_agent_listening", mode: config.mode, host: config.host, port: config.port, enabledTools: config.enabledTools }));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    drain();
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    await Promise.all([
      sessions.close(),
      new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); }),
    ]);
    clearTimeout(deadline);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

main().catch(() => {
  // Configuration/SDK errors can contain paths or credentials; do not print raw errors.
  console.error("Node agent failed to start. Check MODE, PORT, and AGENT_WORKSPACE_DIR configuration.");
  process.exitCode = 1;
});
