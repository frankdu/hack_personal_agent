import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

test("tool access is opt-in and SDK selection syntax cannot bypass the allowlist", () => {
  assert.deepEqual(readConfig({}).enabledTools, []);
  assert.deepEqual(readConfig({ ENABLED_TOOLS: "read, ls,read" }).enabledTools, ["read", "ls"]);
  for (const tool of ["*", "+bash", "mcp__*", "powershell", "unknown"]) {
    assert.throws(() => readConfig({ ENABLED_TOOLS: tool }), /Unsupported tool/);
  }
});

test("deployment configuration rejects invalid modes, ports, and partial model selection", () => {
  assert.equal(readConfig({ MODE: "PROD" }).mode, "PROD");
  assert.equal(readConfig({}).host, "127.0.0.1");
  assert.throws(() => readConfig({ MODE: "production" }), /MODE/);
  for (const port of ["0", "65536", "3101junk", "1.5", "Infinity"]) {
    assert.throws(() => readConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => readConfig({ MODEL_ID: "gemma" }), /supplied together/);
});
