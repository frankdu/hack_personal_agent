import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  type ExecutionRequest,
  type Lease,
} from "@agent/contracts";
import { readConfig } from "../src/config.js";
import {
  ExecutionError,
  Executions,
  type Executor,
} from "../src/executions.js";
import { durableWrite } from "../src/storage.js";

function digest(
  input: Omit<ExecutionRequest, "inputDigest">,
): ExecutionRequest {
  return {
    ...input,
    inputDigest: createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex"),
  };
}
async function fixture(executor: Executor) {
  const dir = await mkdtemp(join(tmpdir(), "node-execution-"));
  const config = readConfig({
    NODE_STATE_DIR: dir,
    ENABLED_TOOLS: "read,write,bash",
  });
  let lease: Lease | undefined = {
    nodeId: randomUUID(),
    bootId: randomUUID(),
    generation: randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    heartbeatIntervalMs: 1000,
  };
  const request = digest({
    protocolVersion: "1",
    attemptId: randomUUID(),
    taskId: randomUUID(),
    conversationId: randomUUID(),
    nodeId: lease.nodeId,
    bootId: lease.bootId,
    generation: lease.generation,
    deadline: new Date(Date.now() + 30000).toISOString(),
    profileId: "gemma",
    workspaceId: "default",
    allowedTools: [],
    messages: [{ role: "user", text: "hello" }],
  });
  const executions = new Executions(
    config,
    lease.nodeId,
    lease.bootId,
    () => lease,
    () => "gemma",
    executor,
  );
  await executions.initialize();
  return {
    dir,
    config,
    request,
    executions,
    expire: () => {
      lease = undefined;
    },
    cleanup: async () => {
      await executions.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function settled(executions: Executions, id: string) {
  for (let index = 0; index < 200; index++) {
    const snapshot = executions.get(id);
    if (!["queued", "running"].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Execution did not settle");
}
test("truncated output is persisted as failed with an actionable error", async () => {
  const f = await fixture({
    run: async (_request, hooks) => {
      await hooks.output("Partial response");
      throw new ExecutionError("model_output_truncated");
    },
  });
  try {
    await f.executions.accept(f.request);
    const snapshot = await settled(f.executions, f.request.attemptId);
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.output, "Partial response");
    assert.equal(
      snapshot.error,
      "Model response reached its token limit and is incomplete.",
    );
    assert.equal(f.executions.ready(), true);
  } finally {
    await f.cleanup();
  }
});
test("durable acceptance, input digest deduplication, fencing, and single execution slot", async () => {
  let calls = 0;
  let unblock!: () => void;
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const f = await fixture({
    run: async () => {
      calls++;
      await wait;
      return "done";
    },
  });
  try {
    const accepted = await f.executions.accept(f.request);
    assert.equal(accepted.status, "queued");
    const disk = JSON.parse(
      await readFile(
        join(f.dir, "executions", `${f.request.attemptId}.json`),
        "utf8",
      ),
    );
    assert.equal(disk.request.inputDigest, f.request.inputDigest);
    await f.executions.accept(f.request);
    const { inputDigest: _, ...rest } = f.request;
    await assert.rejects(
      f.executions.accept(
        digest({ ...rest, messages: [{ role: "user", text: "different" }] }),
      ),
      /attempt_digest_mismatch/,
    );
    await assert.rejects(
      f.executions.accept(
        digest({ ...rest, attemptId: randomUUID(), generation: randomUUID() }),
      ),
      /stale_lease/,
    );
    await assert.rejects(
      f.executions.accept(digest({ ...rest, attemptId: randomUUID() })),
      /capacity_unavailable/,
    );
    unblock();
    assert.equal(
      (await settled(f.executions, f.request.attemptId)).status,
      "succeeded",
    );
    assert.equal(calls, 1);
  } finally {
    unblock();
    await f.cleanup();
  }
});
test("unfinished work becomes unknown after restart and is never replayed", async () => {
  const f = await fixture({
    run: async () => {
      throw new Error("Must never execute");
    },
  });
  try {
    await durableWrite(
      join(f.dir, "executions", `${f.request.attemptId}.json`),
      {
        request: f.request,
        snapshot: {
          attemptId: f.request.attemptId,
          inputDigest: f.request.inputDigest,
          status: "running",
          output: "partial",
          error: null,
          sequence: 1,
          updatedAt: new Date().toISOString(),
        },
        tools: {
          sideeffect: { name: "write", digest: "abc", status: "running" },
        },
      },
    );
    await f.executions.initialize();
    assert.equal((await f.executions.accept(f.request)).status, "unknown");
    assert.equal(f.executions.ready(), false);
    assert.deepEqual(f.executions.activeIds(), [f.request.attemptId]);
  } finally {
    await f.cleanup();
  }
});
test("partial side effect remains unknown even if the agent catches the tool error", async () => {
  let effects = 0;
  const f = await fixture({
    run: async (_request, hooks) => {
      try {
        await hooks.tool("write-1", "write", { path: "file" }, async () => {
          effects++;
          throw new Error("disk failed after mutation");
        });
      } catch {}
      return "pretend success";
    },
  });
  try {
    const { inputDigest: _, ...rest } = f.request;
    const request = digest({ ...rest, allowedTools: ["write"] });
    await f.executions.accept(request);
    const snapshot = await settled(f.executions, request.attemptId);
    assert.equal(snapshot.status, "unknown");
    assert.equal(f.executions.ready(), false);
    assert.equal((await f.executions.accept(request)).status, "unknown");
    assert.equal(effects, 1);
  } finally {
    await f.cleanup();
  }
});
test("completed command errors reach the agent without uncertainty or duplicate invocation replay", async () => {
  let calls = 0;
  const nonzero = {
    structuredContent: { exit_code: 1 },
    content: [{ type: "text", text: "One unit test failed" }],
  };
  const errorResult = {
    isError: true,
    content: [{ type: "text", text: "Command completed with an error" }],
  };
  const f = await fixture({
    run: async (_request, hooks, signal) => {
      assert.equal(
        await hooks.tool(
          "test-1",
          "bash",
          { command: "npm test" },
          async () => {
            calls++;
            return nonzero;
          },
        ),
        nonzero,
      );
      assert.equal(signal.aborted, false);
      await assert.rejects(
        hooks.tool("test-1", "bash", { command: "npm test" }, async () => {
          calls++;
          return nonzero;
        }),
        /already recorded/,
      );
      assert.equal(
        await hooks.tool(
          "test-2",
          "bash",
          { command: "other-check" },
          async () => {
            calls++;
            return errorResult;
          },
        ),
        errorResult,
      );
      assert.equal(signal.aborted, false);
      return "The checks completed; here are the failures to fix.";
    },
  });
  try {
    const { inputDigest: _, ...rest } = f.request;
    const request = digest({ ...rest, allowedTools: ["bash"] });
    await f.executions.accept(request);
    const snapshot = await settled(f.executions, request.attemptId);
    assert.equal(snapshot.status, "succeeded");
    assert.equal(f.executions.ready(), true);
    const journal = JSON.parse(
      await readFile(
        join(f.dir, "executions", `${request.attemptId}.json`),
        "utf8",
      ),
    );
    assert.equal(journal.tools["test-1"].status, "failed");
    assert.equal(journal.tools["test-2"].status, "failed");
    assert.equal((await f.executions.accept(request)).status, "succeeded");
    assert.equal(calls, 2);
  } finally {
    await f.cleanup();
  }
});
test("lease loss aborts model work and cancellation waits for actual settlement", async () => {
  let observedAbort = false;
  const f = await fixture({
    run: async (_request, _hooks, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            setTimeout(resolve, 20);
          },
          { once: true },
        ),
      );
      signal.throwIfAborted();
      return "";
    },
  });
  try {
    await f.executions.accept(f.request);
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.expire();
    assert.equal(
      (await settled(f.executions, f.request.attemptId)).status,
      "unknown",
    );
    assert.equal(observedAbort, true);
  } finally {
    await f.cleanup();
  }
});
