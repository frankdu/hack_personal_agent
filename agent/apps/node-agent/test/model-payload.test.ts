import assert from "node:assert/strict";
import { test } from "vitest";
import { localModelPayload } from "../src/model-payload.js";

const manifest = { contextWindow: 4096, maxTokens: 2048 };
const payload = {
  model: "local",
  stream: true,
  max_tokens: 1,
  messages: [{ role: "user", content: "hello" }],
};

test("4K local models get their configured reply budget instead of Pi's one-token clamp", () => {
  const result = localModelPayload(payload, { ...manifest, ollama: true });
  assert.equal(result.max_tokens, 2048);
  assert.equal(result.reasoning_effort, "none");
  assert.equal(result.messages, payload.messages);
  assert.equal(result.stream, true);
  assert.equal(
    localModelPayload(payload, manifest).reasoning_effort,
    undefined,
  );
});

test("reply budget includes full history and tool schemas and rejects exhausted context", () => {
  const messages = [
    { role: "system", content: "Follow the workspace rules." },
    { role: "user", content: "hello" },
    { role: "assistant", content: "x".repeat(5000) },
    { role: "user", content: "write a python hello world program" },
  ];
  const tools = [
    { type: "function", function: { description: "x".repeat(2000) } },
  ];
  const result = localModelPayload({ ...payload, messages, tools }, manifest);
  assert.ok(Number(result.max_tokens) >= 128);
  assert.ok(Number(result.max_tokens) < 2048);
  assert.equal(result.messages, messages);
  assert.equal(result.tools, tools);
  assert.throws(
    () =>
      localModelPayload(
        {
          ...payload,
          messages: [{ role: "user", content: "x".repeat(12000) }],
        },
        manifest,
      ),
    /too little context/,
  );
});
