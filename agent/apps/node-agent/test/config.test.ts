import assert from "node:assert/strict";
import { relative, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_CODING_TOOLS } from "@agent/contracts";
import { test } from "vitest";
import { readConfig } from "../src/config.js";

test("missing or blank project directories use a dedicated default chat workspace", () => {
  for (const value of [undefined, "", "   "]) {
    const config = readConfig({ AGENT_WORKSPACE_DIR: value });
    assert.equal(
      config.workspaceDir,
      join(process.cwd(), "default-chat-workspace"),
    );
    assert.equal(config.workspaceDirIsDefault, true);
  }
  const config = readConfig({ AGENT_WORKSPACE_DIR: "./project" });
  assert.equal(config.workspaceDir, resolve("project"));
  assert.equal(config.workspaceDirIsDefault, false);
});

test("coding tools default on, explicit restrictions work, SDK syntax cannot bypass the allowlist", () => {
  assert.deepEqual(readConfig({}).enabledTools, DEFAULT_CODING_TOOLS);
  assert.deepEqual(readConfig({ ENABLED_TOOLS: "" }).enabledTools, []);
  assert.deepEqual(readConfig({ ENABLED_TOOLS: "  " }).enabledTools, []);
  assert.deepEqual(
    readConfig({ ENABLED_TOOLS: "read, ls,read" }).enabledTools,
    ["read", "ls"],
  );
  for (const tool of ["*", "+bash", "mcp__*", "powershell", "unknown"]) {
    assert.throws(
      () => readConfig({ ENABLED_TOOLS: tool }),
      /Unsupported tool/,
    );
  }
});

test("default private state stays outside the default coding workspace", () => {
  const config = readConfig({});
  const stateWithinWorkspace = relative(config.workspaceDir, config.stateDir);
  assert.ok(
    stateWithinWorkspace.startsWith("..") || isAbsolute(stateWithinWorkspace),
  );
  assert.equal(
    readConfig({ NODE_STATE_DIR: "/private/custom-state" }).stateDir,
    "/private/custom-state",
  );
});

test("Ollama discovery defaults to local measurement and validates configuration", () => {
  assert.equal(readConfig({}).ollama.enabled, true);
  assert.equal(readConfig({}).ollama.minTokensPerSecond, 20);
  assert.equal(
    readConfig({ OLLAMA_AUTO_DISCOVER: "false" }).ollama.enabled,
    false,
  );
  assert.deepEqual(
    readConfig({ OLLAMA_MODEL_PRIORITY: "gemma4:31b,qwen3:8b,gemma4:31b" })
      .ollama.modelPriority,
    ["gemma4:31b", "qwen3:8b"],
  );
  for (const env of [
    { OLLAMA_AUTO_DISCOVER: "no" },
    { OLLAMA_MIN_TOKENS_PER_SECOND: "19" },
    { OLLAMA_BENCHMARK_TIMEOUT_MS: "NaN" },
    { OLLAMA_URL: "https://hosted.example" },
    { OLLAMA_URL: "http://localhost:11434/api" },
  ])
    assert.throws(() => readConfig(env));
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
