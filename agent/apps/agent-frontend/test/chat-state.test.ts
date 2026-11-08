import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  conversationSchema,
  fleetNodeSchema,
  taskSchema,
} from "@agent/contracts";
import {
  eligibleNode,
  isTaskActive,
  pendingAssistantOutput,
  readyModelIds,
  selectedNodeProblem,
} from "../src/lib/chat-state.ts";
import {
  apiRequest,
  ApiRequestError,
  normalizeBackendUrl,
  submissionMayHaveSucceeded,
} from "../src/lib/api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const now = "2026-11-08T00:00:00.000Z";
const node = fleetNodeSchema.parse({
  protocolVersion: "1",
  nodeId: id,
  bootId: id,
  name: "test",
  hardware: {
    platform: "linux",
    arch: "x64",
    cpuModel: "CPU",
    cpuCores: 4,
    memoryBytes: 1,
    availableMemoryBytes: 1,
    unifiedMemory: false,
    gpus: [],
    docker: { available: false, scope: "unknown" },
  },
  enabledTools: ["read"],
  workspaceIds: ["default"],
  profiles: [
    {
      id: "gemma",
      modelId: "gemma",
      runtime: "native",
      state: "ready",
      contextWindow: 4096,
      concurrency: 1,
    },
  ],
  status: "online",
  lastSeenAt: now,
  activeAttempts: [],
  leaseExpiresAt: now,
});
const decision = {
  id,
  taskId: id,
  nodeId: id,
  profileId: "gemma",
  provider: "rules",
  modelRevision: null,
  promptRevision: "1",
  reasonCode: "only_candidate",
  reason: "Only eligible node",
  candidateNodeIds: [id],
  latencyMs: 0,
  createdAt: now,
};
const task = taskSchema.parse({
  id,
  conversationId: id,
  status: "running",
  attemptId: id,
  decision,
  output: "Hello",
  error: null,
  createdAt: now,
});

test("cumulative snapshots replace output and persisted assistant message prevents duplicates", () => {
  assert.equal(pendingAssistantOutput(undefined, task), "Hello");
  assert.equal(
    pendingAssistantOutput(undefined, { ...task, output: "Hello world" }),
    "Hello world",
  );
  const conversation = conversationSchema.parse({
    id,
    revision: 2,
    activeTaskId: null,
    messages: [
      {
        id,
        taskId: id,
        role: "assistant",
        text: "Hello world",
        createdAt: now,
      },
    ],
  });
  assert.equal(pendingAssistantOutput(conversation, task), null);
});
test("manual pin refuses offline, missing, unready, workspace or tool mismatches", () => {
  assert.equal(selectedNodeProblem([node], id, "default", ["read"]), null);
  for (const candidate of [
    { ...node, status: "offline" as const },
    { ...node, profiles: [] },
    { ...node, workspaceIds: ["other"] },
    { ...node, enabledTools: [] },
  ]) {
    assert.ok(selectedNodeProblem([candidate], id, "default", ["read"]));
    assert.equal(eligibleNode(candidate, "default", ["read"]), false);
  }
  assert.ok(selectedNodeProblem([], id, "default", []));
});
test("unknown execution is not retried as running", () => {
  assert.equal(isTaskActive("unknown"), false);
  assert.equal(isTaskActive("running"), true);
});
test("model choices deduplicate ready models on online nodes and model preferences constrain pins", () => {
  const qwen = {
    ...node,
    profiles: [{ ...node.profiles[0]!, modelId: "qwen3:8b" }],
  };
  assert.deepEqual(
    readyModelIds([
      node,
      node,
      qwen,
      {
        ...qwen,
        profiles: [
          { ...qwen.profiles[0]!, modelId: "inactive", state: "stopped" },
        ],
      },
      {
        ...qwen,
        status: "offline",
        profiles: [{ ...qwen.profiles[0]!, modelId: "offline" }],
      },
    ]),
    ["gemma", "qwen3:8b"],
  );
  assert.equal(eligibleNode(node, "default", [], "gemma"), true);
  assert.equal(eligibleNode(node, "default", [], "qwen3:8b"), false);
  assert.equal(selectedNodeProblem([node], id, "default", [], "gemma"), null);
  assert.match(
    selectedNodeProblem([node], id, "default", [], "qwen3:8b")!,
    /qwen3:8b active and ready/,
  );
  assert.equal(
    eligibleNode({ ...node, activeAttempts: [id] }, "default", [], "gemma"),
    false,
  );
  assert.match(
    selectedNodeProblem(
      [{ ...node, activeAttempts: [id] }],
      id,
      "default",
      [],
      "gemma",
    )!,
    /busy/,
  );
});
test("connection URL excludes credentials and unsupported schemes", () => {
  assert.equal(
    normalizeBackendUrl(" http://127.0.0.1:3100/ "),
    "http://127.0.0.1:3100",
  );
  for (const url of [
    "file:///tmp/backend",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
  ])
    assert.throws(() => normalizeBackendUrl(url));
});
test("transport and server failures retain idempotency key; definitive rejection permits correction", () => {
  assert.equal(submissionMayHaveSucceeded(new TypeError("fetch failed")), true);
  assert.equal(
    submissionMayHaveSucceeded(
      new ApiRequestError(503, "unavailable", "unavailable"),
    ),
    true,
  );
  assert.equal(
    submissionMayHaveSucceeded(
      new ApiRequestError(409, "revision_conflict", "conflict"),
    ),
    false,
  );
});

test("authenticated submission places the token only in a header and preserves idempotency", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    request = { url: String(url), init: init! };
    return new Response(JSON.stringify(task), { status: 200 });
  });
  const result = await apiRequest(
    { id, baseUrl: "https://backend.example", token: "test-operator-token" },
    "/v1/tasks/test",
    taskSchema,
    { method: "POST", body: { test: true }, idempotencyKey: id },
  );
  assert.equal(result.id, task.id);
  assert.equal(request?.url, "https://backend.example/v1/tasks/test");
  assert.equal(request?.init.credentials, "omit");
  const headers = new Headers(request?.init.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-operator-token");
  assert.equal(headers.get("Idempotency-Key"), id);
  assert.equal(request?.init.body, '{"test":true}');
});

test("invalid backend response is rejected instead of displayed as a task", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ status: "running", output: "untrusted response" }),
        { status: 200 },
      ),
  );
  await assert.rejects(
    apiRequest(
      { id, baseUrl: "https://backend.example", token: "test" },
      "/v1/tasks/test",
      taskSchema,
    ),
  );
});
