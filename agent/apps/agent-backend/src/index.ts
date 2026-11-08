import { readConfig } from "./config.js";
import { startBackend } from "./server.js";

try {
  const config = readConfig();
  const app = await startBackend(config, {
    migrate: process.env.AUTO_MIGRATE !== "false",
  });
  console.log(
    JSON.stringify({
      event: "backend_started",
      host: config.host,
      port: config.port,
      mode: config.mode,
    }),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 15_000);
    timeout.unref();
    void app.close().then(
      () => {
        clearTimeout(timeout);
        process.exitCode = 0;
      },
      () => {
        clearTimeout(timeout);
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch {
  console.error(
    "Backend startup failed. Check required environment variables and PostgreSQL connectivity.",
  );
  process.exitCode = 1;
}
