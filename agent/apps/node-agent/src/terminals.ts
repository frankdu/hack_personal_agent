import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import {
  nodeTerminalAttachSchema,
  terminalClientFrameSchema,
  terminalSessionSchema,
  type TerminalSession,
  type Lease,
  type terminalScopeSchema,
  type createTerminalSchema,
} from "@agent/contracts";
import type { z } from "zod";
import type { NodeConfig } from "./config.js";
import { RequestError } from "./executions.js";
import { durableWrite, readJson, Serial } from "./storage.js";
import type { Projects } from "./projects.js";

const exec = promisify(execFile);
type Scope = z.infer<typeof terminalScopeSchema>;
type Create = z.infer<typeof createTerminalSchema>;
type Record = { session: TerminalSession; hostBoot: string };
type Attachment = {
  scope: Scope;
  ws: WebSocket;
  pty: IPty;
  pending: number;
  pausedAt?: number;
  inputBytes: number;
  inputWindow: number;
};
const live = (s: TerminalSession) =>
  s.state === "attached" || s.state === "detached";
const MAX_BUFFER = 262144;

/** Deliberately do not copy service credentials or arbitrary inherited environment. */
export function terminalEnvironment(): { [key: string]: string } {
  const env: { [key: string]: string } = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
    "TMPDIR",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function hostBootIdentity() {
  if (process.platform === "linux")
    return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (process.platform === "darwin")
    return (
      await exec("/usr/sbin/sysctl", ["-n", "kern.boottime"])
    ).stdout.trim();
  throw new Error("Unsupported host boot identity");
}

export class Terminals {
  private records = new Map<string, Record>();
  private attachments = new Map<string, Attachment>();
  private serial = new Serial();
  private pty?: typeof import("node-pty");
  private boot = "";
  private tmux = false;
  private reason: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private readonly options;
  private readonly directory: string;
  private readonly socket: string;
  private readonly shell = userInfo().shell || "/bin/sh";
  private readonly location =
    existsSync("/.dockerenv") ||
    existsSync("/run/.containerenv") ||
    process.env.CURILO_CONTAINER === "true"
      ? "container"
      : "host";
  constructor(
    private readonly config: NodeConfig,
    private readonly nodeId: string,
    private readonly bootId: string,
    private readonly lease: () => Lease | undefined,
    private readonly projects: Projects,
  ) {
    this.options = config.terminal ?? {
      enabled: true,
      maxSessions: 8,
      idleTimeoutMs: 1800000,
      maxLifetimeMs: 86400000,
    };
    this.directory = join(config.stateDir, "terminals");
    this.socket = join(this.directory, "tmux.sock");
  }
  private async command(args: string[]) {
    return exec("tmux", ["-S", this.socket, "-f", "/dev/null", ...args], {
      env: terminalEnvironment(),
      timeout: 3000,
      maxBuffer: 65536,
    });
  }
  private initialized = false;
  async initialize() {
    try {
      await this.initializeState();
      this.initialized = true;
    } catch {
      this.reason =
        "Terminal state could not be initialized. Check the node state directory permissions.";
      this.pty = undefined;
    }
  }
  private async initializeState() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    // Unknown host boot identity never authorizes restart adoption, but local PTYs still work.
    this.boot = await hostBootIdentity().catch(() => randomUUID());
    if (!["darwin", "linux"].includes(process.platform))
      this.reason = "Browser terminals support native macOS and Linux nodes.";
    else if (!this.options.enabled)
      this.reason = "Terminal access is disabled by TERMINAL_ENABLED.";
    else if (typeof process.getuid === "function" && process.getuid() === 0)
      this.reason =
        "Run the node as a non-root OS user to enable terminal access.";
    else {
      try {
        this.pty = await import("node-pty");
      } catch {
        this.reason =
          "The native node-pty module is unavailable. Reinstall dependencies on this machine.";
      }
    }
    try {
      await exec("tmux", ["-V"], { timeout: 3000 });
      this.tmux = Buffer.byteLength(this.socket) < 100;
    } catch {
      this.tmux = false;
    }
    const stored = await readJson(join(this.directory, "sessions.json"));
    if (
      stored &&
      typeof stored === "object" &&
      "sessions" in stored &&
      Array.isArray(stored.sessions)
    ) {
      for (const value of stored.sessions.slice(-128)) {
        const record = value as Record;
        const parsed = terminalSessionSchema.safeParse(record.session);
        if (!parsed.success || parsed.data.nodeId !== this.nodeId) continue;
        record.session = parsed.data;
        this.records.set(parsed.data.sessionId, record);
        if (!live(parsed.data)) continue;
        const survives =
          record.hostBoot === this.boot &&
          this.tmux &&
          parsed.data.backend === "tmux" &&
          (await this.hasSession(parsed.data.sessionId));
        record.session.state = survives ? "detached" : "lost";
        if (survives) record.session.bootId = this.bootId;
      }
    }
    await this.expire();
    await this.save();
    this.timer = setInterval(
      () =>
        void this.serial.run(() => this.expire()).catch(() => this.revoke()),
      1000,
    );
    this.timer.unref();
  }
  capability() {
    return {
      available: Boolean(this.pty) && !this.reason && !this.closing,
      tmux: this.tmux,
      reason: this.reason,
      shellLocation: this.location,
      ...this.options,
    };
  }
  validate(scope: Scope) {
    const lease = this.lease();
    if (
      this.closing ||
      scope.nodeId !== this.nodeId ||
      scope.bootId !== this.bootId ||
      !lease ||
      lease.generation !== scope.generation
    )
      throw new RequestError(
        409,
        "terminal_stale_lease",
        "The node lease changed. Refresh the node and reconnect.",
      );
  }
  private owned(id: string, scope: Scope) {
    this.validate(scope);
    const record = this.records.get(id);
    if (!record || record.session.ownerId !== scope.ownerId)
      throw new RequestError(
        404,
        "terminal_not_found",
        "Terminal session not found.",
      );
    return record;
  }
  async list(scope: Scope) {
    return this.serial.run(async () => {
      this.validate(scope);
      await this.expire();
      // Detect shells ended while detached, independently of inference readiness.
      for (const record of this.records.values()) {
        if (
          record.session.ownerId === scope.ownerId &&
          live(record.session) &&
          record.session.backend === "tmux" &&
          !(await this.hasSession(record.session.sessionId))
        )
          await this.finish(record, "ended");
      }
      return {
        sessions: [...this.records.values()]
          .map((r) => r.session)
          .filter((s) => s.ownerId === scope.ownerId),
        capability: this.capability(),
      };
    });
  }
  async create(scope: Scope, input: Create) {
    return this.serial.run(async () => {
      this.validate(scope);
      if (!this.capability().available)
        throw new RequestError(
          409,
          "terminal_unavailable",
          this.reason ?? "Terminal unavailable.",
        );
      const previous = this.records.get(input.sessionId);
      if (previous) {
        const record = this.owned(input.sessionId, scope);
        if (
          record.session.workspaceId !== input.workspaceId ||
          record.session.backend !== input.backend
        )
          throw new RequestError(
            409,
            "terminal_id_conflict",
            "This terminal ID has already been used.",
          );
        return record.session;
      }
      await this.expire();
      if (
        [...this.records.values()].filter((r) => live(r.session)).length >=
        this.options.maxSessions
      )
        throw new RequestError(
          409,
          "terminal_limit",
          "End an existing terminal before opening another.",
        );
      if (input.backend === "tmux" && !this.tmux)
        throw new RequestError(
          409,
          "tmux_unavailable",
          "Install tmux on this node, or explicitly choose a temporary terminal.",
        );
      const project = this.projects
        .list()
        .projects.find((p) => p.id === input.workspaceId);
      const directory =
        input.workspaceId === this.config.workspaceId
          ? this.config.workspaceDir
          : project?.directory;
      if (!directory)
        throw new RequestError(
          403,
          "terminal_workspace_denied",
          "Choose a registered workspace.",
        );
      if (
        (await realpath(directory)) !== directory ||
        !(await stat(directory)).isDirectory()
      )
        throw new RequestError(
          409,
          "terminal_workspace_changed",
          "The workspace directory changed.",
        );
      const now = Date.now();
      const record: Record = {
        hostBoot: this.boot,
        session: {
          sessionId: input.sessionId,
          nodeId: this.nodeId,
          ownerId: scope.ownerId,
          bootId: this.bootId,
          workspaceId: input.workspaceId,
          osUserRef: userInfo().username,
          shellLocation: this.location,
          backend: input.backend,
          state: "detached",
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + this.options.maxLifetimeMs).toISOString(),
          idleExpiresAt: new Date(
            now + this.options.idleTimeoutMs,
          ).toISOString(),
        },
      };
      // Persist intent before creating a process so recovery only adopts recorded sessions.
      this.records.set(input.sessionId, record);
      await this.save();
      try {
        if (input.backend === "tmux") {
          await this.command([
            "new-session",
            "-d",
            "-s",
            this.name(input.sessionId),
            "-c",
            directory,
            "-x",
            String(input.cols),
            "-y",
            String(input.rows),
            this.shell,
          ]);
          await this.command([
            "set-option",
            "-t",
            this.name(input.sessionId),
            "history-limit",
            "5000",
          ]);
          await this.command([
            "set-option",
            "-t",
            this.name(input.sessionId),
            "status",
            "off",
          ]);
        }
      } catch {
        await this.finish(record, "lost");
        throw new RequestError(
          503,
          "terminal_start_failed",
          "Could not start tmux on this node.",
        );
      }
      return record.session;
    });
  }
  private name(id: string) {
    return `curilo_${id.replaceAll("-", "")}`;
  }
  private async hasSession(id: string) {
    try {
      await this.command(["has-session", "-t", this.name(id)]);
      return true;
    } catch {
      return false;
    }
  }
  private async save() {
    const all = [...this.records.values()];
    // Keep all live records plus the most recent ended records, bounded to 128.
    const retained = [
      ...all.filter((r) => !live(r.session)).slice(-96),
      ...all.filter((r) => live(r.session)),
    ];
    this.records = new Map(retained.map((r) => [r.session.sessionId, r]));
    await durableWrite(join(this.directory, "sessions.json"), {
      sessions: retained,
    });
  }
  private detach(id: string, reason = "Terminal detached") {
    const attachment = this.attachments.get(id);
    if (!attachment) return;
    this.attachments.delete(id);
    const record = this.records.get(id);
    if (record && live(record.session))
      record.session.state =
        record.session.backend === "tmux" ? "detached" : "ended";
    void this.serial.run(() => this.save()).catch(() => {});
    attachment.ws.close(1000, reason);
    // Killing the tmux client leaves the tmux server and shell alive.
    try {
      attachment.pty.kill();
    } catch {
      /* Already exited. */
    }
  }
  private async finish(record: Record, state: "ended" | "expired" | "lost") {
    this.detach(record.session.sessionId, `Session ${state}`);
    if (record.session.backend === "tmux" && live(record.session)) {
      try {
        await this.command([
          "kill-session",
          "-t",
          this.name(record.session.sessionId),
        ]);
      } catch {
        if (await this.hasSession(record.session.sessionId))
          throw new RequestError(
            503,
            "terminal_end_failed",
            "The tmux session could not be ended. Retry End session.",
          );
      }
    }
    record.session.state = state;
    await this.save();
  }
  async end(scope: Scope, id: string) {
    return this.serial.run(async () => {
      const record = this.owned(id, scope);
      await this.finish(record, "ended");
      return record.session;
    });
  }
  private async expire() {
    for (const record of [...this.records.values()]) {
      const s = record.session;
      if (
        live(s) &&
        (Date.parse(s.expiresAt) <= Date.now() ||
          Date.parse(s.idleExpiresAt) <= Date.now())
      )
        await this.finish(record, "expired");
    }
    if (!this.lease()) this.revoke();
    for (const [id, a] of this.attachments) {
      try {
        this.validate(a.scope);
      } catch {
        this.detach(id, "Terminal authorization expired");
        continue;
      }
      if (
        (a.pausedAt && Date.now() - a.pausedAt > 10000) ||
        a.ws.bufferedAmount > MAX_BUFFER
      )
        this.detach(id, "Slow terminal reader");
    }
  }
  revoke() {
    for (const id of [...this.attachments.keys()])
      this.detach(id, "Terminal authorization expired");
  }
  install(
    server: Server,
    authenticated: (value: string | undefined) => boolean,
  ) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 16384,
      perMessageDeflate: false,
    });
    server.on("upgrade", (req, socket, head) => {
      if (
        req.url !== "/v1/node/terminals/attach" ||
        !authenticated(req.headers.authorization) ||
        req.headers.origin
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        const timeout = setTimeout(
          () => ws.close(1008, "Attachment required"),
          5000,
        );
        ws.once("close", () => clearTimeout(timeout));
        ws.once("message", (raw, binary) => {
          clearTimeout(timeout);
          void this.serial
            .run(async () => {
              const input = nodeTerminalAttachSchema.parse(
                JSON.parse(raw.toString()),
              );
              if (binary) throw new Error("Binary handshake");
              await this.attach(ws, input);
            })
            .catch((error) => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(
                  JSON.stringify({
                    type: "error",
                    code:
                      error instanceof RequestError
                        ? error.code
                        : "invalid_attachment",
                    message:
                      error instanceof RequestError
                        ? error.message
                        : "Invalid terminal attachment.",
                  }),
                );
              ws.close(1008, "Attachment denied");
            });
        });
      });
    });
  }
  private async attach(
    ws: WebSocket,
    input: z.infer<typeof nodeTerminalAttachSchema>,
  ) {
    const record = this.owned(input.sessionId, input.scope);
    await this.expire();
    if (
      record.session.backend === "tmux" &&
      !(await this.hasSession(input.sessionId))
    ) {
      await this.finish(record, "ended");
    }
    if (!live(record.session))
      throw new RequestError(
        409,
        "terminal_ended",
        "This terminal session has ended.",
      );
    if (!this.pty || ws.readyState !== WebSocket.OPEN)
      throw new RequestError(409, "terminal_unavailable");
    if (this.attachments.has(input.sessionId)) {
      if (!input.takeover)
        throw new RequestError(
          409,
          "terminal_in_use",
          "This terminal is open in another tab. Use Take over to move control here.",
        );
      if (record.session.backend === "pty")
        throw new RequestError(
          409,
          "temporary_terminal_in_use",
          "Temporary shells cannot be taken over. End this session and open a new terminal.",
        );
      this.detach(input.sessionId, "Taken over by another attachment");
    }
    const project = this.projects
      .list()
      .projects.find((p) => p.id === record.session.workspaceId);
    const cwd =
      record.session.workspaceId === this.config.workspaceId
        ? this.config.workspaceDir
        : project?.directory;
    if (
      record.session.backend === "pty" &&
      record.session.bootId !== this.bootId
    )
      throw new RequestError(409, "terminal_ended");
    if (!cwd || (await realpath(cwd)) !== cwd)
      throw new RequestError(409, "terminal_workspace_changed");
    const pty =
      record.session.backend === "tmux"
        ? this.pty.spawn(
            "tmux",
            [
              "-S",
              this.socket,
              "-f",
              "/dev/null",
              "attach-session",
              "-t",
              this.name(input.sessionId),
            ],
            {
              name: "xterm-256color",
              cols: input.cols,
              rows: input.rows,
              cwd,
              env: terminalEnvironment(),
            },
          )
        : this.pty.spawn(this.shell, [], {
            name: "xterm-256color",
            cols: input.cols,
            rows: input.rows,
            cwd,
            env: terminalEnvironment(),
          });
    const attachment: Attachment = {
      scope: input.scope,
      ws,
      pty,
      pending: 0,
      inputBytes: 0,
      inputWindow: Date.now(),
    };
    this.attachments.set(input.sessionId, attachment);
    record.session.state = "attached";
    record.session.idleExpiresAt = new Date(
      Date.now() + this.options.idleTimeoutMs,
    ).toISOString();
    ws.send(JSON.stringify({ type: "ready", session: record.session }));
    const send = (value: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
    };
    pty.onData((data) => {
      if (this.attachments.get(input.sessionId) !== attachment) return;
      for (let i = 0; i < data.length; i += 16384) {
        const chunk = data.slice(i, i + 16384);
        attachment.pending += Buffer.byteLength(chunk);
        if (attachment.pending > MAX_BUFFER || ws.bufferedAmount > MAX_BUFFER) {
          this.detach(input.sessionId, "Slow terminal reader");
          return;
        }
        send({ type: "output", data: chunk });
      }
      if (attachment.pending > 65536 && !attachment.pausedAt) {
        pty.pause();
        attachment.pausedAt = Date.now();
      }
    });
    pty.onExit(() => {
      if (this.attachments.get(input.sessionId) !== attachment) return;
      send({ type: "exit", reason: "Shell exited" });
      ws.close(1000, "Shell exited");
    });
    let saveAt = Date.now();
    ws.on("message", (raw, binary) => {
      try {
        this.validate(input.scope);
        if (binary || this.attachments.get(input.sessionId) !== attachment)
          throw new Error("Invalid writer");
        const frame = terminalClientFrameSchema.parse(
          JSON.parse(raw.toString()),
        );
        if (frame.type === "input") {
          if (Date.now() - attachment.inputWindow >= 1000) {
            attachment.inputWindow = Date.now();
            attachment.inputBytes = 0;
          }
          attachment.inputBytes += Buffer.byteLength(frame.data);
          if (attachment.inputBytes > 65536)
            throw new Error("Input rate exceeded");
          pty.write(frame.data);
          record.session.idleExpiresAt = new Date(
            Date.now() + this.options.idleTimeoutMs,
          ).toISOString();
          if (Date.now() - saveAt > 5000) {
            saveAt = Date.now();
            void this.serial.run(() => this.save()).catch(() => this.revoke());
          }
        } else if (frame.type === "resize") pty.resize(frame.cols, frame.rows);
        else {
          attachment.pending = Math.max(0, attachment.pending - frame.bytes);
          if (attachment.pending < 32768 && attachment.pausedAt) {
            attachment.pausedAt = undefined;
            pty.resume();
          }
        }
      } catch {
        ws.close(1008, "Invalid terminal frame or authorization");
      }
    });
    ws.once("close", () => {
      void this.serial
        .run(async () => {
          if (this.attachments.get(input.sessionId) !== attachment) return;
          this.detach(input.sessionId);
          if (record.session.backend === "pty")
            await this.finish(record, "ended");
          else {
            record.session.state = (await this.hasSession(input.sessionId))
              ? "detached"
              : "ended";
            await this.save();
          }
        })
        .catch(() => this.revoke());
    });
    await this.save();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    if (!this.initialized) return;
    await this.serial.run(async () => {
      for (const record of [...this.records.values()]) {
        this.detach(record.session.sessionId, "Node restarting");
        if (live(record.session)) {
          if (record.session.backend === "pty") record.session.state = "lost";
          else record.session.state = "detached";
        }
      }
      await this.save();
    });
  }
}
