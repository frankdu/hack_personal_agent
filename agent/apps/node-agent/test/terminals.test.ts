import { test, onTestFinished, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { Lease } from "@agent/contracts";
import { readConfig } from "../src/config.js";
import { Projects } from "../src/projects.js";
import { Terminals, terminalEnvironment } from "../src/terminals.js";

const supported =
  ["darwin", "linux"].includes(process.platform) && process.getuid?.() !== 0;
const shellTest = test.skipIf(!supported);
let tmux = false;
try {
  execFileSync("tmux", ["-V"]);
  tmux = true;
} catch {}
const owner = createHash("sha256").update("operator").digest("hex");
async function eventually<T>(
  fn: () => T | Promise<T>,
  check: (v: T) => boolean,
  timeout = 5000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (check(v)) return v;
    await delay(30);
  }
  throw new Error("Terminal test condition timed out");
}
async function fixture(
  overrides: Partial<
    NonNullable<ReturnType<typeof readConfig>["terminal"]>
  > = {},
) {
  const root = await realpath(await mkdtemp("/tmp/ct-"));
  await mkdir(join(root, "work"));
  const config = readConfig({
    NODE_STATE_DIR: join(root, "state"),
    AGENT_WORKSPACE_DIR: join(root, "work"),
    OLLAMA_AUTO_DISCOVER: "false",
  });
  config.terminal = {
    enabled: true,
    maxSessions: 2,
    idleTimeoutMs: 60000,
    maxLifetimeMs: 60000,
    ...overrides,
  };
  const nodeId = randomUUID(),
    bootId = randomUUID();
  let lease: Lease | undefined = {
    protocolVersion: "1",
    nodeId,
    bootId,
    generation: randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    heartbeatIntervalMs: 1000,
  };
  const scope = {
    nodeId,
    bootId,
    generation: lease.generation,
    ownerId: owner,
  };
  const projects = new Projects(config);
  await projects.initialize();
  const broker = new Terminals(config, nodeId, bootId, () => lease, projects);
  await broker.initialize();
  const server = createServer();
  broker.install(server, (token) => token === "Bearer test");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/node/terminals/attach`;
  const sockets: WebSocket[] = [];
  onTestFinished(async () => {
    for (const s of sockets) s.terminate();
    for (const s of (await broker.list(scope).catch(() => ({ sessions: [] })))
      .sessions)
      await broker.end(scope, s.sessionId).catch(() => {});
    await broker.close();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });
  const create = (backend: "tmux" | "pty" = "pty", sessionId = randomUUID()) =>
    broker.create(scope, {
      sessionId,
      backend,
      workspaceId: "default",
      cols: 80,
      rows: 24,
    });
  async function attach(id: string, takeover = false, customScope = scope) {
    const socket = new WebSocket(url, {
      headers: { authorization: "Bearer test" },
    });
    sockets.push(socket);
    let output = "";
    const frames: any[] = [];
    socket.on("error", () => {});
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (frame.type === "output") {
        output += frame.data;
        socket.send(
          JSON.stringify({ type: "ack", bytes: Buffer.byteLength(frame.data) }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        scope: customScope,
        sessionId: id,
        takeover,
        cols: 80,
        rows: 24,
      }),
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
  return {
    root,
    broker,
    scope,
    create,
    attach,
    config,
    projects,
    setLease: (v: Lease | undefined) => {
      lease = v;
    },
  };
}

test("terminal environment excludes service credentials", () => {
  process.env.TERMINAL_TEST_SECRET = "secret";
  const env = terminalEnvironment();
  expect(env.TERMINAL_TEST_SECRET).toBeUndefined();
  expect(env.API_TOKEN).toBeUndefined();
  expect(env.NODE_SHARED_TOKEN).toBeUndefined();
  expect(env.TERM).toBe("xterm-256color");
  delete process.env.TERMINAL_TEST_SECRET;
});
shellTest(
  "real PTY, resize, workspace, ownership, stale lease and temporary disconnect",
  async () => {
    const f = await fixture();
    const session = await f.create();
    expect(session.shellLocation).toMatch(/host|container/);
    await expect(
      f.broker.create(f.scope, {
        sessionId: randomUUID(),
        backend: "pty",
        workspaceId: "/etc",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "terminal_workspace_denied" });
    const denied = await f.attach(session.sessionId, false, {
      ...f.scope,
      ownerId: "f".repeat(64),
    });
    expect(denied.frames[0].code).toBe("terminal_not_found");
    const stale = await f.attach(session.sessionId, false, {
      ...f.scope,
      generation: randomUUID(),
    });
    expect(stale.frames[0].code).toBe("terminal_stale_lease");
    const a = await f.attach(session.sessionId);
    expect(a.frames[0].type).toBe("ready");
    a.socket.send(JSON.stringify({ type: "resize", cols: 99, rows: 31 }));
    a.write("stty size; pwd; printf 'PTY_%s\\n' 'RESULT'\r");
    await eventually(
      a.output,
      (text) =>
        text.includes("PTY_RESULT") &&
        text.includes("31 99") &&
        text.includes(join(f.root, "work")),
    );
    const second = await f.attach(session.sessionId);
    expect(second.frames[0].code).toBe("terminal_in_use");
    a.socket.close();
    await eventually(
      () => f.broker.list(f.scope),
      (list) => list.sessions[0]?.state === "ended",
    );
    const ended = await f.attach(session.sessionId);
    expect(ended.frames[0].code).toBe("terminal_ended");
  },
);
shellTest(
  "idempotent create, live-session limit and expiry terminate sessions",
  async () => {
    const f = await fixture({ maxSessions: 1, idleTimeoutMs: 1000 });
    const s = await f.create();
    expect((await f.create("pty", s.sessionId)).sessionId).toBe(s.sessionId);
    await expect(f.create()).rejects.toMatchObject({ code: "terminal_limit" });
    const a = await f.attach(s.sessionId);
    await eventually(
      () => f.broker.list(f.scope),
      (list) => list.sessions[0]?.state === "expired",
    );
    await eventually(
      () => a.socket.readyState,
      (state) => state === WebSocket.CLOSED,
    );
  },
);
shellTest(
  "absolute lifetime expires even while the terminal receives input",
  async () => {
    const f = await fixture({ maxLifetimeMs: 1000, idleTimeoutMs: 60000 });
    const s = await f.create();
    const a = await f.attach(s.sessionId);
    const activity = setInterval(() => {
      if (a.socket.readyState === WebSocket.OPEN) a.write(" ");
    }, 100);
    try {
      await eventually(
        () => f.broker.list(f.scope),
        (list) => list.sessions[0]?.state === "expired",
      );
    } finally {
      clearInterval(activity);
    }
  },
);

shellTest(
  "terminal disablement denies shells without affecting session discovery",
  async () => {
    const f = await fixture({ enabled: false });
    expect((await f.broker.list(f.scope)).capability.available).toBe(false);
    await expect(f.create()).rejects.toMatchObject({
      code: "terminal_unavailable",
    });
  },
);

shellTest("lease loss immediately removes shell writer", async () => {
  const f = await fixture();
  const s = await f.create();
  const a = await f.attach(s.sessionId);
  f.setLease(undefined);
  f.broker.revoke();
  await eventually(
    () => a.socket.readyState,
    (state) => state === WebSocket.CLOSED,
  );
});
shellTest(
  "slow terminal readers are disconnected without unbounded output buffers",
  async () => {
    const f = await fixture();
    const s = await f.create();
    // Use a second client with no ACKs: the broker pauses and disconnects after 10 seconds.
    const a = await f.attach(s.sessionId);
    a.socket.removeAllListeners("message");
    a.write("yes 'bounded-terminal-output'\r");
    await eventually(
      () => a.socket.readyState,
      (state) => state === WebSocket.CLOSED,
      15000,
    );
  },
  20000,
);
test.skipIf(!tmux || !supported)(
  "tmux command survives detach, explicit takeover, node restart and End session",
  async () => {
    const f = await fixture();
    const s = await f.create("tmux");
    const a = await f.attach(s.sessionId);
    a.write(
      "sleep 0.2; printf 'SURVIVED_%s\\n' 'DETACH'; printf x >> once.txt\r",
    );
    a.socket.close();
    await delay(400);
    const b = await f.attach(s.sessionId);
    await eventually(b.output, (text) => text.includes("SURVIVED_DETACH"));
    expect(await readFile(join(f.root, "work/once.txt"), "utf8")).toBe("x");
    const c = await f.attach(s.sessionId, true);
    expect(c.frames[0].type).toBe("ready");
    await eventually(
      () => b.socket.readyState,
      (state) => state === WebSocket.CLOSED,
    );
    await f.broker.close();
    const bootId = randomUUID();
    const scope = { ...f.scope, bootId };
    const restarted = new Terminals(
      f.config,
      scope.nodeId,
      bootId,
      () => ({
        protocolVersion: "1",
        nodeId: scope.nodeId,
        bootId,
        generation: scope.generation,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        heartbeatIntervalMs: 1000,
      }),
      f.projects,
    );
    await restarted.initialize();
    onTestFinished(() => restarted.close());
    const restored = await restarted.list(scope);
    expect(restored.sessions[0]?.state).toBe("detached");
    expect(restored.sessions[0]?.bootId).toBe(bootId);
    await restarted.end(scope, s.sessionId);
    expect((await restarted.list(scope)).sessions[0]?.state).toBe("ended");
  },
);
