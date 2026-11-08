import { startNode } from "./app.js";
import { readConfig } from "./config.js";
async function main() {
  const config = readConfig();
  const node = await startNode(config);
  console.info(
    JSON.stringify({
      event: "node_agent_listening",
      mode: config.mode,
      host: config.host,
      port: config.port,
      nodeId: node.nodeId,
      bootId: node.bootId,
    }),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    try {
      await node.close();
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
main().catch(() => {
  console.error(
    "Node agent startup failed; verify configuration, state ownership, workspace, and runtime manifest.",
  );
  process.exitCode = 1;
});
