import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { startNode } from "../src/app.js";
import { readConfig } from "../src/config.js";

vi.mock("../src/hardware.js", () => ({
  inspectHardware: async () => ({
    platform: "linux",
    arch: "x64",
    cpuModel: "test",
    cpuCores: 1,
    memoryBytes: 1024 ** 3,
    availableMemoryBytes: 1024 ** 3,
    unifiedMemory: false,
    gpus: [],
    docker: { available: false, scope: "unknown" },
  }),
}));

function configAt(directory: string, workspace?: string) {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
  try {
    const config = readConfig({
      NODE_STATE_DIR: join(directory, "state"),
      AGENT_WORKSPACE_DIR: workspace,
      OLLAMA_AUTO_DISCOVER: "false",
    });
    config.port = 0;
    return config;
  } finally {
    cwd.mockRestore();
  }
}

test("startup creates the default chat workspace and preserves it across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-default-workspace-"));
  try {
    const config = configAt(root);
    const workspace = join(root, "default-chat-workspace");
    await assert.rejects(stat(workspace), { code: "ENOENT" });
    const node = await startNode(config);
    try {
      await node.started;
      assert.ok((await stat(workspace)).isDirectory());
      await writeFile(join(workspace, "notes.txt"), "keep this chat file");
    } finally {
      await node.close();
    }
    const restarted = await startNode(config);
    try {
      await restarted.started;
      assert.equal(
        await readFile(join(workspace, "notes.txt"), "utf8"),
        "keep this chat file",
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup still rejects an explicitly configured missing project directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-explicit-workspace-"));
  try {
    const project = join(root, "missing-project");
    await assert.rejects(startNode(configAt(root, project)), {
      code: "ENOENT",
    });
    await assert.rejects(stat(project), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
