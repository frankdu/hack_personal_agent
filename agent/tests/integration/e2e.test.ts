import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  conversationSchema,
  nodesResponseSchema,
  projectsResponseSchema,
  projectSchema,
  projectTreeResponseSchema,
  taskResponseSchema,
  taskSchema,
  type Task,
} from "@agent/contracts";
import { readConfig as backendConfig } from "../../apps/agent-backend/src/config.js";
import { startBackend } from "../../apps/agent-backend/src/server.js";
import { readConfig as nodeConfig } from "../../apps/node-agent/src/config.js";
import { startNode } from "../../apps/node-agent/src/app.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function eventually<T>(
  fn: () => Promise<T | undefined>,
  timeout = 20_000,
): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await fn();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error("Timed out waiting for integration state");
}

test(
  "PostgreSQL → routing audit → node journal → real Pi → local scripted inference",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "curilo_agent-e2e-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const userToken = randomUUID();
    const nodeToken = randomUUID();
    let modelCalls = 0;
    let toolResults = 0;
    const chatRequests: any[] = [];
    const model = createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "test-gemma" }] }));
        return;
      }
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.model, "test-gemma");
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "warm",
            choices: [
              {
                message: { role: "assistant", content: "OK" },
                finish_reason: "stop",
              },
            ],
          }),
        );
        return;
      }
      modelCalls++;
      chatRequests.push(body);
      const toolResult = body.messages.some(
        (m: any) =>
          m.role === "tool" &&
          JSON.stringify(m.content).includes("fixture-secret-content"),
      );
      if (toolResult) toolResults++;
      const lastUser = [...body.messages]
        .reverse()
        .find((m: any) => m.role === "user");
      const content = JSON.stringify(lastUser?.content ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test-gemma", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: "assistant" });
      if (content.includes("SLOW_CANCEL")) {
        chunk({ content: "Working…" });
        const timer = setTimeout(() => {
          chunk({ content: "finished" }, "stop");
          res.end("data: [DONE]\n\n");
        }, 30_000);
        res.once("close", () => clearTimeout(timer));
        return;
      }
      if (content.includes("TOOL_ROUNDTRIP") && !toolResult) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "tool-read-1",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: "fixture.txt" }),
              },
            },
          ],
        });
        chunk({}, "tool_calls");
      } else {
        chunk({
          content:
            body.max_tokens === 1
              ? "I"
              : toolResult
                ? "Tool read validated."
                : content.includes("write a python hello world program")
                  ? 'print("Hello, world!")'
                  : "Hello from the local test model.",
        });
        chunk({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    const modelPort = await listen(model);
    onTestFinished(async () => {
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
    });
    const nodePort = await freePort();
    const backend = await startBackend({
      ...backendConfig({
        MODE: "DEV",
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        API_TOKEN: userToken,
        NODE_SHARED_TOKEN: nodeToken,
        NODE_ENDPOINT_ALLOWLIST: `http://127.0.0.1:${nodePort}`,
        HEARTBEAT_INTERVAL_MS: "200",
        NODE_LEASE_MS: "10000",
        EXECUTION_TIMEOUT_MS: "60000",
      }),
      port: 0,
    });
    onTestFinished(() => backend.close());
    const base = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
    const api = async (path: string, body?: unknown, key?: string) => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "content-type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await fetch(base + "/v1/nodes")).status, 401);
    assert.equal(
      (
        await fetch(base + "/v1/nodes", {
          headers: { Authorization: `Bearer ${nodeToken}` },
        })
      ).status,
      401,
    );
    const workspace = join(root, "work");
    await mkdir(workspace);
    await writeFile(join(workspace, "fixture.txt"), "fixture-secret-content");
    const runtimePath = join(root, "runtime.json");
    await writeFile(
      runtimePath,
      JSON.stringify({
        kind: "external",
        profileId: "gemma-local",
        modelId: "test-gemma",
        endpoint: `http://127.0.0.1:${modelPort}/v1`,
        contextWindow: 4096,
        maxTokens: 2048,
        startupTimeoutMs: 5000,
        probeIntervalMs: 10000,
        maxRestarts: 0,
      }),
    );
    const config = nodeConfig({
      MODE: "DEV",
      PORT: String(nodePort),
      NODE_STATE_DIR: join(root, "node-state"),
      AGENT_WORKSPACE_DIR: workspace,
      ENABLED_TOOLS: "read",
      NODE_NAME: "Integration node",
      BACKEND_URL: base,
      NODE_ENDPOINT: `http://127.0.0.1:${nodePort}`,
      NODE_SHARED_TOKEN: nodeToken,
      RUNTIME_CONFIG: runtimePath,
    });
    const node = await startNode(config);
    onTestFinished(() => node.close());
    const fleet = await eventually(async () => {
      const nodes = nodesResponseSchema.parse(
        (await api("/v1/nodes")).body,
      ).nodes;
      return nodes[0]?.status === "online" &&
        nodes[0]?.profiles[0]?.state === "ready"
        ? nodes
        : undefined;
    });
    assert.equal(fleet[0]!.name, "Integration node");
    const projectsPath = `/v1/nodes/${fleet[0]!.nodeId}/projects`;
    assert.equal((await fetch(base + projectsPath)).status, 401);
    const roots = projectsResponseSchema.parse((await api(projectsPath)).body);
    assert.equal(roots.projects[0]!.name, "work");
    const treePath = `${projectsPath}/${roots.projects[0]!.id}/tree`;
    const listing = projectTreeResponseSchema.parse((await api(treePath)).body);
    assert.ok(
      listing.entries.some(
        (entry) => entry.name === "fixture.txt" && entry.kind === "file",
      ),
    );
    assert.equal((await api(`${treePath}?path=..`)).status, 403);
    const projectDirectory = join(root, "added-project");
    await mkdir(projectDirectory);
    const added = projectSchema.parse(
      (await api(projectsPath, { directory: projectDirectory })).body,
    );
    assert.equal(added.name, "added-project");
    const secondAdd = projectSchema.parse(
      (await api(projectsPath, { directory: projectDirectory })).body,
    );
    assert.equal(secondAdd.id, added.id);
    const conv = conversationSchema.parse(
      (await api("/v1/conversations", {})).body,
    );
    const body = {
      protocolVersion: "1",
      text: "Hello",
      expectedRevision: conv.revision,
      routing: { mode: "auto", modelId: "test-gemma" },
      policy: {
        workspaceId: "default",
        allowedTools: [],
        allowHostedJudgment: false,
        allowRulesFallback: true,
      },
    };
    assert.equal(
      (
        await api(
          `/v1/conversations/${conv.id}/messages`,
          { ...body, routing: { mode: "auto", modelId: "not-installed" } },
          randomUUID(),
        )
      ).status,
      409,
    );
    const key = randomUUID();
    const submitted = await api(
      `/v1/conversations/${conv.id}/messages`,
      body,
      key,
    );
    assert.ok(
      [200, 201, 202].includes(submitted.status),
      JSON.stringify(submitted.body),
    );
    const accepted = taskResponseSchema.parse(submitted.body);
    assert.equal(accepted.task.decision.provider, "rules");
    const duplicate = await api(
      `/v1/conversations/${conv.id}/messages`,
      body,
      key,
    );
    assert.equal(
      taskResponseSchema.parse(duplicate.body).task.id,
      accepted.task.id,
    );
    assert.equal(
      (
        await api(
          `/v1/conversations/${conv.id}/messages`,
          { ...body, text: "Different" },
          key,
        )
      ).status,
      409,
    );
    const finish = async (id: string): Promise<Task> =>
      eventually(async () => {
        const task = taskSchema.parse((await api(`/v1/tasks/${id}`)).body);
        return ["succeeded", "failed", "cancelled", "unknown"].includes(
          task.status,
        )
          ? task
          : undefined;
      });
    const result = await finish(accepted.task.id);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.output, "Hello from the local test model.");
    assert.equal(
      modelCalls,
      1,
      "request-key retry must not cause a second inference",
    );
    const decisions = await api(`/v1/tasks/${result.id}/decisions`);
    assert.equal(decisions.body.decisions[0].nodeId, fleet[0]!.nodeId);
    const history = conversationSchema.parse(
      (await api(`/v1/conversations/${conv.id}`)).body,
    );
    assert.equal(history.messages.at(-1)?.text, result.output);

    // A second turn must retain history and a usable output budget on 4K runtimes.
    const followup = await api(
      `/v1/conversations/${conv.id}/messages`,
      {
        ...body,
        text: "write a python hello world program",
        expectedRevision: history.revision,
      },
      randomUUID(),
    );
    assert.equal(followup.status, 202, JSON.stringify(followup.body));
    const followupTask = taskResponseSchema.parse(followup.body).task;
    const followupResult = await finish(followupTask.id);
    assert.equal(followupResult.status, "succeeded");
    assert.equal(followupResult.output, 'print("Hello, world!")');
    assert.equal(chatRequests.length, 2);
    for (const request of chatRequests) {
      assert.equal(request.stream, true);
      assert.ok(request.max_tokens > 1 && request.max_tokens <= 2048);
    }
    assert.deepEqual(
      chatRequests[1].messages
        .filter((message: any) => ["user", "assistant"].includes(message.role))
        .map((message: any) => ({
          role: message.role,
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part: any) => part.text).join(""),
        })),
      [
        { role: "user", content: "Hello" },
        { role: "assistant", content: result.output },
        { role: "user", content: "write a python hello world program" },
      ],
    );
    const followupHistory = conversationSchema.parse(
      (await api(`/v1/conversations/${conv.id}`)).body,
    );
    assert.equal(followupHistory.messages.length, 4);
    assert.equal(followupHistory.activeTaskId, null);

    // A manually selected unavailable target cannot fall back silently.
    assert.equal(
      (
        await api(
          `/v1/conversations/${conv.id}/messages`,
          {
            ...body,
            expectedRevision: followupHistory.revision,
            routing: { mode: "manual", nodeId: randomUUID() },
          },
          randomUUID(),
        )
      ).status,
      409,
    );

    // Real SDK tool-call/result roundtrip against a fixture workspace.
    const toolConversation = conversationSchema.parse(
      (await api("/v1/conversations", {})).body,
    );
    const toolTask = taskResponseSchema.parse(
      (
        await api(
          `/v1/conversations/${toolConversation.id}/messages`,
          {
            ...body,
            text: "TOOL_ROUNDTRIP read fixture.txt",
            expectedRevision: 0,
            policy: { ...body.policy, allowedTools: ["read"] },
          },
          randomUUID(),
        )
      ).body,
    ).task;
    const toolFinished = await finish(toolTask.id);
    assert.equal(
      toolFinished.status,
      "succeeded",
      JSON.stringify(toolFinished),
    );
    assert.equal(toolFinished.output, "Tool read validated.");
    assert.equal(toolResults, 1);

    // Explicit cancellation reaches the running Pi session; no synthetic success.
    const slowConv = conversationSchema.parse(
      (await api("/v1/conversations", {})).body,
    );
    const slow = taskResponseSchema.parse(
      (
        await api(
          `/v1/conversations/${slowConv.id}/messages`,
          { ...body, text: "SLOW_CANCEL", expectedRevision: 0 },
          randomUUID(),
        )
      ).body,
    ).task;
    await eventually(async () => {
      const value = taskSchema.parse((await api(`/v1/tasks/${slow.id}`)).body);
      return value.output.includes("Working") ? true : undefined;
    });
    await api(`/v1/tasks/${slow.id}/cancel`, {});
    assert.equal((await finish(slow.id)).status, "cancelled");
  },
);
