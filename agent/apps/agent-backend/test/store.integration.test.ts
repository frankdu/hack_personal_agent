import { afterAll, beforeAll, describe, test, vi } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  conversationsResponseSchema,
  registrationSchema,
  submitMessageSchema,
} from "@agent/contracts";
import { readConfig } from "../src/config.js";
import { startBackend } from "../src/server.js";
import { Dispatcher } from "../src/dispatcher.js";
import { digest } from "../src/store.js";

describe(
  "PostgreSQL audit, dispatch, leases, idempotency, unknown outcomes and HTTP auth",
  { skip: !process.env.TEST_DATABASE_URL, concurrent: false },
  () => {
    // These cases intentionally share state and exercise the same conversation lifecycle.
    let admin: Pool;
    let schema: string;
    let config: ReturnType<typeof readConfig>;
    let app: Awaited<ReturnType<typeof startBackend>>;
    let http: string;
    let lease: Awaited<ReturnType<typeof app.store.register>>;
    let conversation: Awaited<ReturnType<typeof app.store.createConversation>>;
    let first: Awaited<ReturnType<typeof app.store.submit>>;

    const registration = registrationSchema.parse({
      protocolVersion: "1",
      nodeId: randomUUID(),
      bootId: randomUUID(),
      name: "integration",
      endpoint: "http://127.0.0.1:32001",
      enabledTools: ["read"],
      workspaceIds: ["default"],
      profiles: [
        {
          id: "gemma",
          modelId: "gemma-test",
          runtime: "external",
          state: "ready",
          contextWindow: 200000,
          concurrency: 1,
        },
      ],
      hardware: {
        platform: "linux",
        arch: "x64",
        cpuModel: "test",
        cpuCores: 2,
        memoryBytes: 1000,
        availableMemoryBytes: 1000,
        unifiedMemory: false,
        gpus: [],
        docker: { available: false, scope: "unknown" },
      },
    });
    const input = submitMessageSchema.parse({
      protocolVersion: "1",
      text: "Hello",
      expectedRevision: 0,
    });

    beforeAll(async () => {
      const base = process.env.TEST_DATABASE_URL!;
      admin = new Pool({ connectionString: base });
      schema = `backend_test_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(base);
      url.searchParams.set("options", `-c search_path=${schema}`);
      config = {
        ...readConfig({
          DATABASE_URL: url.toString(),
          API_TOKEN: "integration-user-token-long",
          NODE_SHARED_TOKEN: "integration-node-token-long",
          NODE_ENDPOINT_ALLOWLIST: "http://127.0.0.1:32001",
        }),
        port: 0,
      };
      app = await startBackend(config, { dispatch: false });
      const address = app.server.address();
      assert(address && typeof address !== "string");
      http = `http://127.0.0.1:${address.port}`;
      lease = await app.store.register(registration);
    });

    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        if (admin) {
          try {
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
    });

    test("bearer scopes and CORS are enforced", async () => {
      assert.equal((await fetch(`${http}/v1/nodes`)).status, 401);
      assert.equal(
        (
          await fetch(`${http}/v1/nodes`, {
            headers: { authorization: `Bearer ${config.nodeToken}` },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(`${http}/v1/nodes`, {
            headers: {
              authorization: `Bearer ${config.apiToken}`,
              origin: "https://untrusted.invalid",
            },
          })
        ).status,
        403,
      );
      const cors = await fetch(`${http}/v1/nodes`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      });
      assert.equal(cors.status, 204);
      assert.equal(
        cors.headers.get("access-control-allow-origin"),
        "http://localhost:3000",
      );
    });
    test("conversation list is authenticated, read-only and ordered by latest message", async () => {
      for (const token of ["", config.nodeToken]) {
        const response = await fetch(`${http}/v1/conversations`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 401);
      }
      const list = async () => {
        const response = await fetch(`${http}/v1/conversations`, {
          headers: { authorization: `Bearer ${config.apiToken}` },
        });
        assert.equal(response.status, 200);
        return conversationsResponseSchema.parse(await response.json())
          .conversations;
      };
      assert.deepEqual(await list(), []);
      assert.deepEqual(await list(), []);
      const older = await app.store.createConversation();
      const newer = await app.store.createConversation();
      const empty = await app.store.createConversation();
      try {
        for (const [chat, date] of [
          [older, "2026-11-07T12:00:00.000Z"],
          [newer, "2026-11-08T12:00:00.000Z"],
        ] as const) {
          await app.store.pool.query(
            "UPDATE conversations SET body=$2 WHERE id=$1",
            [
              chat.id,
              JSON.stringify({
                ...chat,
                activeTaskId: chat.id,
                messages: [
                  {
                    id: randomUUID(),
                    role: "user",
                    text: "Hello ".repeat(30),
                    createdAt: "2026-11-06T12:00:00.000Z",
                    taskId: chat.id,
                  },
                  {
                    id: randomUUID(),
                    role: "assistant",
                    text: "Latest reply",
                    createdAt: date,
                    taskId: chat.id,
                  },
                ],
              }),
            ],
          );
        }
        await app.store.pool.query(
          "UPDATE conversations SET created_at=$2 WHERE id=$1",
          [empty.id, "2026-11-05T12:00:00.000Z"],
        );
        const summaries = await list();
        assert.deepEqual(
          summaries.map((chat) => chat.id),
          [newer.id, older.id, empty.id],
        );
        assert.deepEqual(summaries[0], {
          id: newer.id,
          title: "Hello ".repeat(30).slice(0, 100),
          updatedAt: "2026-11-08T12:00:00.000Z",
          activeTaskId: newer.id,
        });
        assert.equal(summaries[2]!.title, "Untitled conversation");
        assert.equal(summaries[2]!.activeTaskId, null);
      } finally {
        await app.store.pool.query(
          "DELETE FROM conversations WHERE id = ANY($1::uuid[])",
          [[older.id, newer.id, empty.id]],
        );
      }
      assert.deepEqual(await list(), []);
    });
    test("registration allowlist, boot fencing and heartbeat order", async () => {
      await assert.rejects(
        app.store.register({
          ...registration,
          endpoint: "http://169.254.169.254",
        }),
        /not enrolled/,
      );
      assert.equal(
        (await app.store.register(registration)).generation,
        lease.generation,
      );
      const hb = {
        protocolVersion: "1" as const,
        bootId: registration.bootId,
        generation: lease.generation,
        sequence: 1,
        draining: false,
        activeAttempts: [],
        profiles: registration.profiles,
        availableMemoryBytes: 900,
      };
      await app.store.heartbeat(registration.nodeId, hb);
      await assert.rejects(
        app.store.heartbeat(registration.nodeId, hb),
        /must increase/,
      );
      const fleet = (await app.store.nodes())[0]!.node;
      assert.equal("endpoint" in fleet, false);
    });
    test("operator model control forwards a fenced request and removes readiness while warming", async () => {
      const profiles = [
        {
          ...registration.profiles[0]!,
          discovery: {
            source: "ollama" as const,
            selected: true,
            selectable: true,
            reason: "Selected",
          },
        },
        {
          ...registration.profiles[0]!,
          id: "qwen",
          modelId: "qwen3:8b",
          state: "stopped" as const,
          discovery: {
            source: "ollama" as const,
            selected: false,
            selectable: true,
            reason: "Speed requirement met",
          },
        },
      ];
      await app.store.register({ ...registration, profiles });
      let calls = 0;
      let rejectSwitch = true;
      const originalFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url) !== `${registration.endpoint}/v1/node/model`)
            return originalFetch(url, init);
          calls++;
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${config.nodeToken}`,
          );
          assert.equal(init?.redirect, "error");
          assert.deepEqual(JSON.parse(String(init?.body)), {
            profileId: "qwen",
            bootId: registration.bootId,
            generation: lease.generation,
          });
          if (rejectSwitch)
            return Response.json(
              { error: { code: "node_busy", message: "Node is busy." } },
              { status: 409 },
            );
          return Response.json(
            {
              profiles: profiles.map((p) => ({
                ...p,
                state: p.id === "qwen" ? "starting" : "stopped",
                discovery: {
                  ...p.discovery,
                  selected: false,
                  selectable: false,
                },
              })),
            },
            { status: 202 },
          );
        },
      );
      const control = (token: string, profileId = "qwen") =>
        fetch(`${http}/v1/nodes/${registration.nodeId}/model`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ profileId }),
        });
      assert.equal((await control(config.nodeToken)).status, 401);
      assert.equal((await control(config.apiToken, "missing")).status, 409);
      assert.equal(calls, 0);
      assert.equal((await control(config.apiToken)).status, 409);
      assert.equal(
        (await app.store.nodes())[0]!.node.profiles[0]!.state,
        "ready",
      );
      rejectSwitch = false;
      const response = await control(config.apiToken);
      assert.equal(response.status, 202);
      const fleet = (await app.store.nodes())[0]!.node;
      assert.equal(
        fleet.profiles.some((p) => p.state === "ready"),
        false,
      );
      assert.equal(
        fleet.profiles.find((p) => p.id === "qwen")?.state,
        "starting",
      );
      await app.store.register(registration);
    });
    test("queued attempts block model switching before dispatch", async () => {
      conversation = await app.store.createConversation();
      first = await app.store.submit(conversation.id, "request-1", input);
      await assert.rejects(
        app.store.selectModel(registration.nodeId, "gemma"),
        /active or unresolved tasks/,
      );
    });
    test("one transaction writes decision, attempt and outbox; replay is idempotent", async () => {
      for (const table of [
        "tasks",
        "routing_decisions",
        "execution_attempts",
        "dispatch_outbox",
      ])
        assert.equal(
          Number(
            (await app.store.pool.query(`SELECT count(*) AS n FROM ${table}`))
              .rows[0].n,
          ),
          1,
        );
      assert.equal(
        (await app.store.submit(conversation.id, "request-1", input)).task.id,
        first.task.id,
      );
      await assert.rejects(
        app.store.submit(conversation.id, "request-1", {
          ...input,
          text: "Different",
        }),
        /different input/,
      );
      const attempt = (await app.store.pending())[0]!;
      const { inputDigest, ...payload } = attempt.request;
      assert.equal(inputDigest, digest(payload));
    });
    test("dispatch observes committed audit and completed attempt is not dispatched again", async () => {
      let calls = 0;
      const fetcher: typeof fetch = async (_url, init) => {
        calls++;
        assert.equal(
          Number(
            (
              await app.store.pool.query(
                "SELECT count(*) AS n FROM routing_decisions",
              )
            ).rows[0].n,
          ),
          1,
        );
        const request = JSON.parse(String(init?.body));
        return Response.json({
          attemptId: request.attemptId,
          inputDigest: request.inputDigest,
          status: "succeeded",
          output: "Hello from the model",
          error: null,
          sequence: 1,
          updatedAt: new Date().toISOString(),
        });
      };
      const dispatcher = new Dispatcher(app.store, fetcher);
      await dispatcher.sweep();
      await dispatcher.sweep();
      assert.equal(calls, 1);
      assert.equal((await app.store.task(first.task.id)).status, "succeeded");
      const final = await app.store.conversation(conversation.id);
      assert.equal(final.activeTaskId, null);
      assert.equal(final.revision, 2);
      assert.equal(final.messages[1]!.text, "Hello from the model");
      const events = await app.store.events(conversation.id, 0);
      assert(events.length >= 5);
      assert(
        (await app.store.events(conversation.id, events[1]!.id)).every(
          (e) => e.id > events[1]!.id,
        ),
      );
    });
    test("HTTP model preference narrows nodes and survives persistence and idempotency checks", async () => {
      const matchingNode = {
        ...registration,
        nodeId: randomUUID(),
        bootId: randomUUID(),
        name: "matching-model-node",
        profiles: [
          {
            ...registration.profiles[0]!,
            id: "qwen-local",
            modelId: "qwen3:8b",
          },
        ],
      };
      await app.store.register(matchingNode);
      const branch = await app.store.createConversation();
      const post = (modelId: string, key: string) =>
        fetch(`${http}/v1/conversations/${branch.id}/messages`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({
            ...input,
            routing: { mode: "auto", modelId },
          }),
        });
      assert.equal((await post("missing-model", "filter-request")).status, 409);
      assert.equal((await app.store.conversation(branch.id)).revision, 0);
      const response = await post("qwen3:8b", "filter-request");
      assert.equal(response.status, 202);
      const accepted = await response.json();
      assert.equal(accepted.task.decision.nodeId, matchingNode.nodeId);
      assert.equal(accepted.task.decision.profileId, "qwen-local");
      assert.equal(
        accepted.task.decision.reasonCode,
        "SOLE_ELIGIBLE_CANDIDATE",
      );
      assert.equal(accepted.task.decision.provider, "rules");
      assert.equal(
        (await (await post("qwen3:8b", "filter-request")).json()).task.id,
        accepted.task.id,
      );
      assert.equal(
        (await post("gemma-test", "filter-request")).status,
        409,
        "a changed model cannot reuse a submission key",
      );
      const attempt = (await app.store.pending()).find(
        (a) => a.body.id === accepted.task.id,
      )!;
      assert.equal(attempt.request.profileId, "qwen-local");
      await app.store.localOutcome(
        attempt,
        "cancelled",
        "Test cancellation before dispatch.",
      );
      await app.store.pool.query(
        "UPDATE nodes SET lease_expires=now()-interval '1 second' WHERE id=$1",
        [matchingNode.nodeId],
      );
    });
    test("concurrent conversation revisions accept only one new task", async () => {
      const branch = await app.store.createConversation();
      const results = await Promise.allSettled([
        app.store.submit(branch.id, "race-a", input),
        app.store.submit(branch.id, "race-b", input),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      const pending = (await app.store.pending()).find(
        (a) => a.body.conversationId === branch.id,
      )!;
      assert(pending);
      await app.store.localOutcome(
        pending,
        "cancelled",
        "Test cancellation before dispatch.",
      );
    });
    test("lost acknowledgement and backend restart reconcile without a second execution", async () => {
      const branch = await app.store.createConversation();
      const submitted = await app.store.submit(branch.id, "lost-ack", input);
      let executed = 0;
      let polls = 0;
      let completed: Record<string, unknown> | undefined;
      const node: typeof fetch = async (_url, init) => {
        if (init?.method === "POST") {
          executed++;
          const request = JSON.parse(String(init.body));
          completed = {
            attemptId: request.attemptId,
            inputDigest: request.inputDigest,
            status: "succeeded",
            output: "Durable result",
            error: null,
            sequence: 2,
            updatedAt: new Date().toISOString(),
          };
          throw new Error(
            "The node executed, but the acknowledgement was lost.",
          );
        }
        polls++;
        assert(completed);
        return Response.json(completed);
      };
      await new Dispatcher(app.store, node).sweep();
      assert.equal((await app.store.task(submitted.task.id)).status, "unknown");
      await app.close();
      app = await startBackend(config, { dispatch: false });
      const newAddress = app.server.address();
      assert(newAddress && typeof newAddress !== "string");
      http = `http://127.0.0.1:${newAddress.port}`;
      assert.equal((await app.store.task(submitted.task.id)).status, "unknown");
      await new Dispatcher(app.store, node).sweep();
      assert.equal(executed, 1);
      assert.equal(polls, 1);
      assert.equal(
        (await app.store.task(submitted.task.id)).status,
        "succeeded",
      );
      assert.equal(
        (await app.store.conversation(branch.id)).activeTaskId,
        null,
      );
    });
    test("SSE resumes after a durable cursor across backend restart", async () => {
      const events = await app.store.events(conversation.id, 0);
      const cursor = events[1]!.id;
      const response = await fetch(
        `${http}/v1/conversations/${conversation.id}/events`,
        {
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            "last-event-id": String(cursor),
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /text\/event-stream/);
      const reader = response.body!.getReader();
      let wire = "";
      try {
        while (!wire.includes("data: ")) {
          const part = await reader.read();
          if (part.done) break;
          wire += new TextDecoder().decode(part.value);
        }
        const ids = [...wire.matchAll(/^id: (\d+)$/gm)].map((m) =>
          Number(m[1]),
        );
        assert(ids.length > 0);
        assert(ids.every((id) => id > cursor));
      } finally {
        await reader.cancel();
      }
    });
    test("uncertain dispatch holds conversation and never creates a replacement attempt", async () => {
      const second = await app.store.submit(conversation.id, "request-2", {
        ...input,
        expectedRevision: 2,
      });
      const fail: typeof fetch = async () => {
        throw new Error("connection lost");
      };
      await new Dispatcher(app.store, fail).sweep();
      assert.equal((await app.store.task(second.task.id)).status, "unknown");
      assert.equal(
        (await app.store.conversation(conversation.id)).activeTaskId,
        second.task.id,
      );
      await assert.rejects(
        app.store.submit(conversation.id, "request-3", {
          ...input,
          expectedRevision: 3,
        }),
        /unresolved task/,
      );
      assert.equal((await app.store.pending())[0]!.id, second.task.attemptId);
      const replacement = await app.store.register({
        ...registration,
        bootId: randomUUID(),
      });
      assert.notEqual(replacement.generation, lease.generation);
      await assert.rejects(
        app.store.register(registration),
        /already been replaced/,
      );
    });
  },
);
