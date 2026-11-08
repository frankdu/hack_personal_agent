import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { submitMessageSchema, type ExecutionRequest } from "@agent/contracts";
import { readConfig } from "../src/config.js";
import { ExecutionError, type RunHooks } from "../src/executions.js";
import { PiExecutor } from "../src/pi-session.js";
import { parseRuntimeManifest } from "../src/runtime.js";

function stream(
  res: ServerResponse,
  deltas: Record<string, unknown>[],
  finishReason: string | null = "stop",
) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const delta of deltas)
    res.write(
      `data: ${JSON.stringify({
        id: "test-completion",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
  if (finishReason)
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`,
    );
  res.end("data: [DONE]\n\n");
}

async function fixture(
  respond: (body: any, res: ServerResponse, call: number) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-executor-"));
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    respond(body, res, bodies.length);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const executor = new PiExecutor(
    readConfig({
      NODE_STATE_DIR: join(dir, "state"),
      AGENT_WORKSPACE_DIR: workspace,
      OLLAMA_AUTO_DISCOVER: "false",
    }),
    parseRuntimeManifest({
      kind: "external",
      profileId: "test",
      modelId: "test-model",
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      contextWindow: 8192,
      maxTokens: 2048,
    }),
  );
  const request: ExecutionRequest = {
    protocolVersion: "1",
    attemptId: randomUUID(),
    taskId: randomUUID(),
    conversationId: randomUUID(),
    nodeId: randomUUID(),
    bootId: randomUUID(),
    generation: randomUUID(),
    deadline: new Date(Date.now() + 30_000).toISOString(),
    profileId: "test",
    workspaceId: "default",
    allowedTools: [],
    messages: [{ role: "user", text: "What did you find in your checking?" }],
    inputDigest: "a".repeat(64),
  };
  const snapshots: string[] = [];
  const tools: string[] = [];
  const hooks: RunHooks = {
    output: async (text) => {
      snapshots.push(text);
    },
    tool: async (_id, name, _input, execute) => {
      tools.push(name);
      return execute();
    },
  };
  return {
    workspace,
    bodies,
    executor,
    request,
    snapshots,
    tools,
    run: () => executor.run(request, hooks, AbortSignal.timeout(5000)),
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("no-tool tasks explicitly state capabilities even when history claims tools were available", async () => {
  const f = await fixture((_body, res) =>
    stream(res, [
      { content: "I cannot inspect files " },
      { content: "with tools disabled." },
    ]),
  );
  f.request.messages.unshift(
    { role: "user", text: "Check the workspace" },
    { role: "assistant", text: "I'll check using Bash and Glob." },
  );
  try {
    const output = await f.run();
    assert.equal(output, "I cannot inspect files with tools disabled.");
    assert.equal(f.snapshots.at(-1), output);
    assert.deepEqual(f.tools, []);
    assert.equal(f.bodies.length, 1);
    assert.equal(f.bodies[0].tools, undefined);
    const prompt = f.bodies[0].messages[0].content;
    assert.match(prompt, /Tools enabled for this task: none/);
    assert.match(prompt, /Do not promise to run checks/);
    assert.match(prompt, /Prior assistant promises are not evidence/);
    assert.match(prompt, /Be concise by default/);
    assert.match(prompt, /For a greeting, reply with a brief greeting/);
    assert.match(
      prompt,
      /Mention tool availability or limitations only when they affect the user's request/,
    );
    assert.ok(
      f.bodies[0].messages.some(
        (message: any) => message.content === "I'll check using Bash and Glob.",
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("default coding tools execute and retain paragraph boundaries before the final answer", async () => {
  const f = await fixture((_body, res, call) => {
    if (call === 1)
      stream(
        res,
        [
          {
            content: "I'll read the file.",
            tool_calls: [
              {
                index: 0,
                id: "read-1",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path: "sample.txt" }),
                },
              },
            ],
          },
        ],
        "tool_calls",
      );
    else stream(res, [{ content: "The file contains hello." }]);
  });
  f.request.allowedTools = submitMessageSchema.parse({
    protocolVersion: "1",
    text: "Read sample.txt",
    expectedRevision: 0,
  }).policy.allowedTools;
  await writeFile(join(f.workspace, "sample.txt"), "hello");
  try {
    assert.equal(
      await f.run(),
      "I'll read the file.\n\nThe file contains hello.",
    );
    assert.deepEqual(f.tools, ["read"]);
    assert.equal(f.bodies.length, 2);
    assert.match(
      f.bodies[0].messages[0].content,
      /Tools enabled for this task: read, bash, edit, write, grep, find, ls\./,
    );
    assert.deepEqual(
      f.bodies[0].tools.map((tool: any) => tool.function.name),
      f.request.allowedTools,
    );
    assert.ok(
      f.bodies[1].messages.some(
        (message: any) =>
          message.role === "tool" && message.content.includes("hello"),
      ),
    );
    assert.equal(
      f.snapshots.at(-1),
      "I'll read the file.\n\nThe file contains hello.",
    );
  } finally {
    await f.cleanup();
  }
});

test("token-limited responses fail and flush the tail instead of returning success", async () => {
  const f = await fixture((_body, res) =>
    stream(
      res,
      [{ content: "An incomplete " }, { content: "answer tail" }],
      "length",
    ),
  );
  try {
    await assert.rejects(
      f.run(),
      (error: unknown) =>
        error instanceof ExecutionError &&
        error.code === "model_output_truncated",
    );
    assert.equal(f.snapshots.at(-1), "An incomplete answer tail");
    assert.equal(f.bodies.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a stream missing its finish reason fails while preserving all received text", async () => {
  const f = await fixture((_body, res) =>
    stream(res, [{ content: "Partial " }, { content: "response tail" }], null),
  );
  try {
    await assert.rejects(f.run(), /Model stream failed/);
    assert.equal(f.snapshots.at(-1), "Partial response tail");
    assert.equal(f.bodies.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a truncated tool call is never executed or continued automatically", async () => {
  const f = await fixture((_body, res) =>
    stream(
      res,
      [
        {
          content: "I'll read the file.",
          tool_calls: [
            {
              index: 0,
              id: "read-1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"sample',
              },
            },
          ],
        },
      ],
      "length",
    ),
  );
  f.request.allowedTools = ["read"];
  try {
    await assert.rejects(
      f.run(),
      (error: unknown) =>
        error instanceof ExecutionError &&
        error.code === "model_output_truncated",
    );
    assert.deepEqual(f.tools, []);
    assert.equal(f.bodies.length, 1);
    assert.equal(f.snapshots.at(-1), "I'll read the file.");
  } finally {
    await f.cleanup();
  }
});
