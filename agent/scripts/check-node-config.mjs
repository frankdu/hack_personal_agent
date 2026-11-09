// Deliberately report setting names only, never credentials or configuration values.
import { readConfig } from "../apps/node-agent/dist/config.js";

const missing = ["BACKEND_URL", "NODE_ENDPOINT", "NODE_SHARED_TOKEN"].filter(
  (key) => !process.env[key]?.trim(),
);
if (missing.length) {
  console.error(
    `Node configuration incomplete: set ${missing.join(", ")} in .env.node.`,
  );
  process.exit(1);
}
try {
  const config = readConfig();
  if (
    config.sharedToken.includes("REPLACE_") ||
    config.endpoint.includes("PRIVATE_IP") ||
    config.backendUrl.includes("PRIVATE_IP")
  ) {
    throw new Error("Replace enrollment placeholders in .env.node");
  }
} catch {
  console.error(
    "Invalid node configuration. Check URLs, token length (32+), port and runtime settings in .env.node.",
  );
  process.exit(1);
}
console.info(
  "Node configuration valid (connectivity and token agreement are not checked).",
);
