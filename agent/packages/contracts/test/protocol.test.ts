import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canonicalJson,
  DEFAULT_CODING_TOOLS,
  executionRequestSchema,
  registrationSchema,
  submitMessageSchema,
} from "../src/index.js";

const uuid = "b29ff712-41d7-4289-8774-dc7e8f15a35a";
test("registration fixture round-trips; protocol mismatches and secret fields fail closed", () => {
  const fixture = {
    protocolVersion: "1",
    nodeId: uuid,
    bootId: uuid,
    name: "Mac",
    endpoint: "http://127.0.0.1:3101",
    hardware: {
      platform: "darwin",
      arch: "arm64",
      cpuModel: "Apple",
      cpuCores: 8,
      memoryBytes: 16e9,
      availableMemoryBytes: 8e9,
      unifiedMemory: true,
      gpus: [{ name: "Apple", vendor: "apple", memoryBytes: null }],
      docker: { available: false, scope: "unknown" },
    },
    enabledTools: ["read"],
    workspaceIds: ["default"],
    profiles: [
      {
        id: "gemma",
        modelId: "gemma-4-e2b",
        runtime: "native",
        state: "ready",
        contextWindow: 8192,
        concurrency: 1,
      },
    ],
  };
  assert.deepEqual(
    registrationSchema.parse(JSON.parse(JSON.stringify(fixture))),
    fixture,
  );
  assert.equal(
    registrationSchema.safeParse({ ...fixture, protocolVersion: "2" }).success,
    false,
  );
  assert.equal(
    registrationSchema.safeParse({ ...fixture, token: "do-not-forward" })
      .success,
    false,
  );
});
test("coding tools default on, explicit restrictions are retained, unknown tools rejected", () => {
  const input = { protocolVersion: "1", text: "hello", expectedRevision: 0 };
  for (const policy of [undefined, {}, { workspaceId: "custom" }]) {
    assert.deepEqual(
      submitMessageSchema.parse({ ...input, policy }).policy.allowedTools,
      DEFAULT_CODING_TOOLS,
    );
  }
  for (const allowedTools of [[], ["read"]]) {
    assert.deepEqual(
      submitMessageSchema.parse({ ...input, policy: { allowedTools } }).policy
        .allowedTools,
      allowedTools,
    );
  }
  assert.equal(
    submitMessageSchema.safeParse({
      ...input,
      policy: { allowedTools: ["sudo"] },
    }).success,
    false,
  );
  assert.equal(
    submitMessageSchema.safeParse({ ...input, routing: { mode: "manual" } })
      .success,
    false,
  );
});
test("canonical request digest ignores object insertion order but retains array order", () => {
  assert.equal(
    canonicalJson({ b: 2, a: { y: 1, x: 2 } }),
    canonicalJson({ a: { x: 2, y: 1 }, b: 2 }),
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});
test("an optional exact model preference round-trips for auto routing and pinned nodes", () => {
  const input = { protocolVersion: "1", text: "hello", expectedRevision: 0 };
  assert.deepEqual(submitMessageSchema.parse(input).routing, { mode: "auto" });
  for (const routing of [
    { mode: "auto", modelId: "muse-glimmer:30b-mlx" },
    { mode: "manual", nodeId: uuid, modelId: "gemma4:31b-mlx" },
  ]) {
    assert.deepEqual(
      submitMessageSchema.parse({ ...input, routing }).routing,
      routing,
    );
    for (const modelId of ["", "x".repeat(257), 123, null])
      assert.equal(
        submitMessageSchema.safeParse({
          ...input,
          routing: { ...routing, modelId },
        }).success,
        false,
      );
  }
});
test("execution fixture preserves scope and rejects malformed digest", () => {
  const fixture = {
    protocolVersion: "1",
    attemptId: uuid,
    taskId: uuid,
    conversationId: uuid,
    nodeId: uuid,
    bootId: uuid,
    generation: uuid,
    deadline: "2026-11-08T12:00:00.000Z",
    profileId: "gemma",
    workspaceId: "default",
    allowedTools: [],
    messages: [{ role: "user", text: "hi" }],
    inputDigest: "a".repeat(64),
  };
  assert.deepEqual(executionRequestSchema.parse(fixture), fixture);
  assert.equal(
    executionRequestSchema.safeParse({ ...fixture, inputDigest: "hash" })
      .success,
    false,
  );
});
