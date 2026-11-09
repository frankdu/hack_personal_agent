import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { startNode } from "../src/app.js";
import { readConfig } from "../src/config.js";
import {
  projectsResponseSchema,
  projectTreeResponseSchema,
} from "@agent/contracts";

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
      NODE_SHARED_TOKEN: "project-test-token",
    });
    if (config.workspaceDirIsDefault)
      config.workspaceDir = join(directory, "chat_sessions");
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
    const workspace = join(root, "chat_sessions");
    await assert.rejects(stat(workspace), { code: "ENOENT" });
    const node = await startNode(config);
    try {
      await node.started;
      assert.ok((await stat(workspace)).isDirectory());
      await writeFile(join(workspace, "notes.txt"), "keep this chat file");
      const address = node.server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}/v1/node/projects`;
      assert.equal((await fetch(url)).status, 401);
      // Project discovery is operator-authenticated even without an inference runtime.
      const headers = { authorization: `Bearer ${config.sharedToken}` };
      const roots = projectsResponseSchema.parse(
        await (await fetch(url, { headers })).json(),
      );
      assert.equal(roots.projects[0]!.name, "chat_sessions");
      const listing = projectTreeResponseSchema.parse(
        await (
          await fetch(`${url}/${roots.projects[0]!.id}/tree`, { headers })
        ).json(),
      );
      assert.equal(listing.entries[0]!.name, "notes.txt");
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
