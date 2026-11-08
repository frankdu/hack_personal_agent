import assert from "node:assert/strict";
import { test } from "vitest";
import { readConfig } from "../src/config.js";
import { createNodeServer } from "../src/server.js";

test("health distinguishes liveness from execution readiness and rejects task submission", async () => {
  const { server, drain } = createNodeServer(readConfig({}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/health/live`)).status, 200);
    assert.equal((await fetch(`${origin}/health/ready`)).status, 503);
    const status = await fetch(`${origin}/v1/node/status`).then((response) =>
      response.json(),
    );
    assert.equal(status.executionReady, false);
    assert.deepEqual(status.enabledTools, []);
    assert.equal(
      (await fetch(`${origin}/v1/tasks`, { method: "POST" })).status,
      401,
    );
    drain();
    assert.equal((await fetch(`${origin}/health/live`)).status, 503);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
