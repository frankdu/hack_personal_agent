import { test, expect, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { WebSocket } from "ws";
import { readConfig as backendConfig } from "../../apps/agent-backend/src/config.js";
import { startBackend } from "../../apps/agent-backend/src/server.js";
import { readConfig as nodeConfig } from "../../apps/node-agent/src/config.js";
import { startNode } from "../../apps/node-agent/src/app.js";

async function eventually<T>(
  fn: () => T | Promise<T>,
  check: (v: T) => boolean,
  timeout = 10000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (check(v)) return v;
    await delay(40);
  }
  throw new Error("Terminal integration condition timed out");
}
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
let tmux = false;
try {
  execFileSync("tmux", ["-V"]);
  tmux = true;
} catch {}

test.skipIf(
  !process.env.TEST_DATABASE_URL ||
    process.getuid?.() === 0 ||
    !["darwin", "linux"].includes(process.platform),
)(
  "real browser WebSocket → backend → enrolled node PTY, tickets, revocation, tmux and audit",
  { timeout: 90000 },
  async () => {
    const root = await realpath(await mkdtemp("/tmp/ct-e2e-"));
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `terminal_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const dbUrl = new URL(process.env.TEST_DATABASE_URL!);
    dbUrl.searchParams.set("options", `-c search_path=${schema}`);
    const port = await freePort();
    const origin = "http://localhost:3000";
    const userToken = randomUUID(),
      nodeToken = randomUUID();
    const config = {
      ...backendConfig({
        DATABASE_URL: dbUrl.toString(),
        API_TOKEN: userToken,
        NODE_SHARED_TOKEN: nodeToken,
        NODE_ENDPOINT_ALLOWLIST: `http://127.0.0.1:${port}`,
        FRONTEND_ORIGINS: `${origin},http://localhost:3300,http://remote.example`,
        HEARTBEAT_INTERVAL_MS: "200",
        NODE_LEASE_MS: "60000",
      }),
      port: 0,
    };
    let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
    let node: Awaited<ReturnType<typeof startNode>> | undefined;
    const sockets: WebSocket[] = [];
    try {
      backend = await startBackend(config, { dispatch: false });
      const base = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
      await mkdir(join(root, "work"));
      const nc = nodeConfig({
        PORT: String(port),
        NODE_STATE_DIR: join(root, "state"),
        AGENT_WORKSPACE_DIR: join(root, "work"),
        BACKEND_URL: base,
        NODE_ENDPOINT: `http://127.0.0.1:${port}`,
        NODE_SHARED_TOKEN: nodeToken,
        OLLAMA_AUTO_DISCOVER: "false",
        ENABLED_TOOLS: "",
      });
      node = await startNode(nc);
      await node.started;
      const path = `/v1/nodes/${node.nodeId}/terminals`;
      const api = async (
        path: string,
        method = "GET",
        input?: unknown,
        token = userToken,
        requestOrigin = origin,
      ) => {
        const response = await fetch(base + path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            origin: requestOrigin,
            "content-type": "application/json",
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        return { status: response.status, data: await response.json() };
      };
      async function attach(ticket: string, requestOrigin = origin) {
        const socket = new WebSocket(
          base.replace("http:", "ws:") + "/v1/terminals/attach",
          { origin: requestOrigin },
        );
        sockets.push(socket);
        const frames: any[] = [];
        let output = "";
        socket.on("error", () => {});
        socket.on("message", (raw) => {
          const f = JSON.parse(raw.toString());
          frames.push(f);
          if (f.type === "output") {
            output += f.data;
            socket.send(
              JSON.stringify({ type: "ack", bytes: Buffer.byteLength(f.data) }),
            );
          }
        });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        socket.send(
          JSON.stringify({ type: "attach", ticket, cols: 80, rows: 24 }),
        );
        await eventually(
          () => frames,
          (f) => f.some((v) => v.type === "ready" || v.type === "error"),
        );
        return {
          socket,
          frames,
          output: () => output,
          write: (data: string) =>
            socket.send(JSON.stringify({ type: "input", data })),
        };
      }
      const clientId = randomUUID();
      const ticketFor = async (id: string, takeover = false) => {
        const result = await api(`/v1/terminals/${id}/ticket`, "POST", {
          clientId,
          takeover,
        });
        expect(result.status).toBe(200);
        return result.data.ticket as string;
      };
      expect((await api(path, "GET", undefined, nodeToken)).status).toBe(401);
      expect(
        (await api(path, "GET", undefined, userToken, "https://evil.example"))
          .status,
      ).toBe(403);
      expect(
        (await api(path, "GET", undefined, userToken, "http://remote.example"))
          .status,
      ).toBe(403);
      expect(
        (
          await fetch(base + path, {
            headers: { authorization: `Bearer ${userToken}` },
          })
        ).status,
      ).toBe(403);
      const fleet = await api("/v1/nodes");
      expect(fleet.data.nodes[0].profiles).toEqual([]);
      expect(fleet.data.nodes[0].status).toBe("online");
      const list = await api(path);
      expect(list.status).toBe(200);
      expect(list.data.capability.available).toBe(true);
      const id = randomUUID();
      const input = {
        sessionId: id,
        workspaceId: "default",
        backend: "pty",
        cols: 80,
        rows: 24,
      };
      expect(
        (await api(path, "POST", { ...input, workspaceId: "/etc" })).status,
      ).toBe(403);
      const created = await api(path, "POST", input);
      expect(created.status).toBe(201);
      expect((await api(path, "POST", input)).data.sessionId).toBe(id);
      const ticket = await ticketFor(id);
      const a = await attach(ticket);
      expect(a.frames[0].type).toBe("ready");
      a.socket.send(JSON.stringify({ type: "resize", cols: 101, rows: 29 }));
      a.write("stty size; pwd; printf 'RELAY_%s\\n' 'RESULT'\r");
      await eventually(
        a.output,
        (text) =>
          text.includes("RELAY_RESULT") &&
          text.includes("29 101") &&
          text.includes(join(root, "work")),
      );
      const replay = await attach(ticket);
      expect(replay.frames[0].type).toBe("error");
      const wrongOriginTicket = await ticketFor(id);
      const wrongOrigin = await attach(
        wrongOriginTicket,
        "http://localhost:3300",
      );
      expect(wrongOrigin.frames[0].type).toBe("error");
      const wrongOriginReplay = await attach(wrongOriginTicket);
      expect(wrongOriginReplay.frames[0].type).toBe("error");
      const expiredTicket = await ticketFor(id);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
      try {
        const expired = await attach(expiredTicket);
        expect(expired.frames[0].type).toBe("error");
      } finally {
        clock.mockRestore();
      }
      // A different owner's record cannot be attached, even with the correct operator token.
      await backend.store.pool.query(
        "UPDATE terminal_sessions SET owner_id=$2 WHERE id=$1",
        [id, "f".repeat(64)],
      );
      expect(
        (await api(`/v1/terminals/${id}/ticket`, "POST", { clientId })).status,
      ).toBe(404);
      await backend.store.pool.query(
        "UPDATE terminal_sessions SET owner_id=$2 WHERE id=$1",
        [id, created.data.ownerId],
      );
      const pendingTicket = await ticketFor(id);
      expect(
        (await api(`/v1/terminal-connections/${clientId}`, "DELETE")).status,
      ).toBe(200);
      await eventually(
        () => a.socket.readyState,
        (s) => s === WebSocket.CLOSED,
      );
      const revoked = await attach(pendingTicket);
      expect(revoked.frames[0].type).toBe("error");
      await eventually(
        () => api(path),
        (r) =>
          r.data.sessions.find((s: any) => s.sessionId === id)?.state ===
          "ended",
      );
      if (tmux) {
        const tmuxId = randomUUID();
        expect(
          (
            await api(path, "POST", {
              ...input,
              sessionId: tmuxId,
              backend: "tmux",
            })
          ).status,
        ).toBe(201);
        const first = await attach(await ticketFor(tmuxId));
        first.write("sleep 0.3; printf 'TMUX_%s\\n' 'SURVIVED'\r");
        first.socket.close();
        await delay(500);
        await api(path);
        const second = await attach(await ticketFor(tmuxId));
        await eventually(second.output, (s) => s.includes("TMUX_SURVIVED"));
        const inUse = await attach(await ticketFor(tmuxId));
        expect(inUse.frames[0].code).toBe("terminal_in_use");
        const third = await attach(await ticketFor(tmuxId, true));
        expect(third.frames[0].type).toBe("ready");
        await eventually(
          () => second.socket.readyState,
          (s) => s === WebSocket.CLOSED,
        );
        await node.close();
        node = await startNode(nc);
        await node.started;
        await eventually(
          () => api(path),
          (r) =>
            r.data.sessions?.find((s: any) => s.sessionId === tmuxId)
              ?.bootId === node!.bootId,
        );
        const restarted = await attach(await ticketFor(tmuxId));
        expect(restarted.frames[0].type).toBe("ready");
        expect(
          (await api(`/v1/terminals/${tmuxId}/end`, "POST")).data.state,
        ).toBe("ended");
        await eventually(
          () => restarted.socket.readyState,
          (s) => s === WebSocket.CLOSED,
        );
      }
      if (tmux) {
        const pendingId = randomUUID();
        expect(
          (
            await api(path, "POST", {
              ...input,
              sessionId: pendingId,
              backend: "tmux",
            })
          ).status,
        ).toBe(201);
        await node.close();
        const ending = await api(`/v1/terminals/${pendingId}/end`, "POST");
        expect(ending.status).toBe(202);
        expect(ending.data.state).toBe("ending");
        const backendPort = (backend.server.address() as { port: number }).port;
        await backend.close();
        backend = await startBackend(
          { ...config, port: backendPort },
          { dispatch: false },
        );
        node = await startNode(nc);
        await node.started;
        await eventually(
          () => api(path),
          (r) =>
            r.data.sessions?.find((s: any) => s.sessionId === pendingId)
              ?.state === "ended",
        );
        const pendingRow = (
          await backend.store.pool.query(
            "SELECT end_requested FROM terminal_sessions WHERE id=$1",
            [pendingId],
          )
        ).rows[0];
        expect(pendingRow.end_requested).toBe(false);
      }
      const events = (
        await backend.store.pool.query("SELECT event FROM terminal_lifecycle")
      ).rows.map((r) => r.event);
      expect(events).toContain("attach");
      expect(events).toContain("detach");
      // Neither output nor keystrokes are persisted to terminal tables.
      const saved = JSON.stringify(
        (await backend.store.pool.query("SELECT body FROM terminal_sessions"))
          .rows,
      );
      expect(saved).not.toContain("RELAY_RESULT");
      expect(saved).not.toContain("stty size");
      const last = await api(path, "POST", {
        ...input,
        sessionId: randomUUID(),
      });
      const writer = await attach(await ticketFor(last.data.sessionId));
      await backend.store.pool.query(
        "UPDATE nodes SET lease_expires=now()-interval '1 second' WHERE id=$1",
        [node.nodeId],
      );
      // Stop renewal before checking backend revocation.
      await node.enrollment!.close();
      await eventually(
        () => writer.socket.readyState,
        (s) => s === WebSocket.CLOSED,
      );
    } finally {
      for (const s of sockets) s.terminate();
      await node?.close();
      await backend?.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
