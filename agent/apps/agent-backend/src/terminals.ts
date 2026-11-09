import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  createTerminalSchema,
  terminalSessionSchema,
  terminalListSchema,
  terminalTicketRequestSchema,
  terminalAttachSchema,
  terminalClientFrameSchema,
  terminalServerFrameSchema,
  apiErrorSchema,
  type TerminalSession,
} from "@agent/contracts";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { ApiError, missing } from "./errors.js";
import { limitedText } from "./http-client.js";

type Target = Awaited<ReturnType<Store["terminalTarget"]>>;
type Ticket = {
  sessionId: string;
  ownerId: string;
  clientId: string;
  origin: string;
  target: Target;
  expires: number;
  takeover: boolean;
};
type Active = Ticket & {
  browser: WebSocket;
  node?: WebSocket;
  until: number;
  alive: boolean;
  nodeAlive: boolean;
};
const MAX_BUFFER = 262144;
const uuid = "[a-fA-F0-9-]{36}";
const alive = (s: TerminalSession) =>
  s.state === "attached" || s.state === "detached";
export function terminalOriginAllowed(req: IncomingMessage, config: Config) {
  const origin = req.headers.origin;
  if (!origin || !config.frontendOrigins.has(origin)) return false;
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const localSocket = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress ?? "",
  );
  // A TLS reverse proxy on loopback is supported; forwarded headers aren't trusted.
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
    (Boolean((req.socket as { encrypted?: boolean }).encrypted) || localSocket)
  );
}

export class TerminalRelay {
  private tickets = new Map<string, Ticket>();
  private active = new Set<Active>();
  private sockets = new Set<WebSocket>();
  private timer: ReturnType<typeof setInterval>;
  private checking = false;
  private stopped = false;
  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.timer = setInterval(
      () =>
        void this.check().catch(() => {
          for (const a of this.active)
            this.disconnect(a, "Terminal authorization unavailable");
        }),
      1000,
    );
    this.timer.unref();
  }
  private owner() {
    return createHash("sha256").update(this.config.apiToken).digest("hex");
  }
  private async owned(id: string) {
    const row = (
      await this.store.pool.query(
        "SELECT body, end_requested FROM terminal_sessions WHERE id=$1 AND owner_id=$2",
        [id, this.owner()],
      )
    ).rows[0];
    if (!row) throw missing();
    const session = terminalSessionSchema.parse(row.body);
    if (row.end_requested) session.state = "ending";
    return session;
  }
  private async persist(session: TerminalSession, event?: string) {
    if (session.ownerId !== this.owner())
      throw new ApiError(
        502,
        "TERMINAL_OWNER_MISMATCH",
        "Node returned an invalid session owner.",
      );
    await this.store.transaction(async (db) => {
      const previous = (
        await db.query(
          "SELECT body, end_requested FROM terminal_sessions WHERE id=$1 FOR UPDATE",
          [session.sessionId],
        )
      ).rows[0];
      if (
        previous &&
        (previous.body.ownerId !== session.ownerId ||
          previous.body.nodeId !== session.nodeId)
      )
        throw new ApiError(
          409,
          "TERMINAL_ID_CONFLICT",
          "This terminal ID is already in use.",
        );
      if (previous?.end_requested && alive(session)) session.state = "ending";
      const saved = await db.query(
        `INSERT INTO terminal_sessions(id,node_id,owner_id,body) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET body=$4, updated_at=now()
        WHERE terminal_sessions.node_id=EXCLUDED.node_id AND terminal_sessions.owner_id=EXCLUDED.owner_id
        RETURNING id`,
        [
          session.sessionId,
          session.nodeId,
          session.ownerId,
          JSON.stringify(session),
        ],
      );
      if (!saved.rowCount)
        throw new ApiError(
          409,
          "TERMINAL_ID_CONFLICT",
          "This terminal ID is already in use.",
        );
      if (
        event ||
        !previous ||
        previous.body.state !== session.state ||
        previous.body.bootId !== session.bootId
      )
        await db.query(
          "INSERT INTO terminal_lifecycle(session_id,event) VALUES($1,$2)",
          [session.sessionId, event ?? session.state],
        );
    });
  }
  private async rpc(target: Target, action: string, rest: object = {}) {
    try {
      const response = await fetch(`${target.endpoint}/v1/node/terminals`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `Bearer ${this.config.nodeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action,
          scope: {
            nodeId: target.nodeId,
            bootId: target.bootId,
            generation: target.generation,
            ownerId: this.owner(),
          },
          ...rest,
        }),
      });
      const data: unknown = JSON.parse(await limitedText(response, 524288));
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(data);
        throw new ApiError(
          response.status < 500 ? response.status : 502,
          parsed.success ? parsed.data.error.code : "TERMINAL_REQUEST_FAILED",
          parsed.success
            ? parsed.data.error.message
            : "The node could not complete this terminal request.",
        );
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        502,
        "TERMINAL_NODE_UNREACHABLE",
        "Could not reach the node terminal service.",
      );
    }
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    readBody: () => Promise<unknown>,
    json: (status: number, data: unknown) => void,
  ) {
    const collection = path.match(
      new RegExp(`^/v1/nodes/(${uuid})/terminals$`),
    );
    const sessionRoute = path.match(
      new RegExp(`^/v1/terminals/(${uuid})/(ticket|end)$`),
    );
    const revoke = path.match(
      new RegExp(`^/v1/terminal-connections/(${uuid})$`),
    );
    if (!collection && !sessionRoute && !revoke) return false;
    if (!terminalOriginAllowed(req, this.config))
      throw new ApiError(
        403,
        "TERMINAL_ORIGIN_DENIED",
        "Terminals require an allowed browser origin and TLS outside loopback.",
      );
    if (revoke && req.method === "DELETE") {
      this.revokeClient(revoke[1]!, this.owner());
      json(200, { revoked: true });
      return true;
    }
    if (collection) {
      const target = await this.store.terminalTarget(collection[1]!);
      if (req.method === "GET") {
        const data = terminalListSchema.parse(await this.rpc(target, "list"));
        for (const session of data.sessions) {
          if (
            session.nodeId !== target.nodeId ||
            (session.bootId !== target.bootId && alive(session))
          )
            throw new ApiError(
              502,
              "TERMINAL_IDENTITY_MISMATCH",
              "Invalid node terminal identity.",
            );
          await this.persist(session);
        }
        // Preserve backend records after a node reboot or metadata loss; never silently recreate a shell.
        const stored = (
          await this.store.pool.query(
            "SELECT body FROM terminal_sessions WHERE node_id=$1 AND owner_id=$2",
            [target.nodeId, this.owner()],
          )
        ).rows;
        for (const row of stored) {
          const old = terminalSessionSchema.parse(row.body);
          if (data.sessions.some((s) => s.sessionId === old.sessionId))
            continue;
          if (alive(old)) {
            old.state = "lost";
            await this.persist(old);
          }
          data.sessions.push(old);
        }
        data.sessions = data.sessions
          .sort(
            (a, b) =>
              Number(alive(b) || b.state === "ending") -
                Number(alive(a) || a.state === "ending") ||
              b.createdAt.localeCompare(a.createdAt),
          )
          .slice(0, 128);
        json(200, data);
        return true;
      }
      if (req.method === "POST") {
        const input = createTerminalSchema.parse(await readBody());
        const session = terminalSessionSchema.parse(
          await this.rpc(target, "create", { input }),
        );
        if (
          session.nodeId !== target.nodeId ||
          session.bootId !== target.bootId ||
          session.sessionId !== input.sessionId
        )
          throw new ApiError(
            502,
            "TERMINAL_IDENTITY_MISMATCH",
            "Invalid node terminal identity.",
          );
        await this.persist(session);
        json(201, session);
        return true;
      }
    }
    if (sessionRoute && req.method === "POST") {
      const session = await this.owned(sessionRoute[1]!);
      if (sessionRoute[2] === "end") {
        // Persist termination intent even while the node is unreachable. A background
        // reconciler retries it; a backend restart must not forget an End request.
        await this.store.pool.query(
          "UPDATE terminal_sessions SET end_requested=true WHERE id=$1 AND owner_id=$2",
          [session.sessionId, this.owner()],
        );
        for (const a of this.active)
          if (a.sessionId === session.sessionId)
            this.disconnect(a, "Session ending");
        session.state = "ending";
        await this.persist(session, "end_requested");
        const ended = await this.endPending(session).catch(() => undefined);
        if (ended) {
          json(200, ended);
          return true;
        }
        json(202, await this.owned(session.sessionId));
        return true;
      }
      const target = await this.store.terminalTarget(session.nodeId);
      const input = terminalTicketRequestSchema.parse(await readBody());
      if (
        !alive(session) ||
        Date.parse(session.expiresAt) <= Date.now() ||
        session.bootId !== target.bootId
      )
        throw new ApiError(
          409,
          "TERMINAL_NOT_ATTACHABLE",
          "Refresh terminal sessions before reconnecting. This session may have ended or the node may have restarted.",
        );
      for (const [key, t] of this.tickets)
        if (t.expires <= Date.now()) this.tickets.delete(key);
      if (this.tickets.size >= 512)
        throw new ApiError(
          429,
          "TERMINAL_TICKET_LIMIT",
          "Too many pending terminal attachments.",
        );
      const ticket = randomBytes(32).toString("base64url");
      const expires = Date.now() + 30000;
      this.tickets.set(ticket, {
        sessionId: session.sessionId,
        ownerId: this.owner(),
        clientId: input.clientId,
        origin: req.headers.origin!,
        target,
        expires,
        takeover: input.takeover,
      });
      json(200, { ticket, expiresAt: new Date(expires).toISOString() });
      return true;
    }
    throw new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      "Unsupported terminal operation.",
    );
  }
  private async endPending(session: TerminalSession) {
    let result: TerminalSession;
    try {
      const target = await this.store.terminalTarget(session.nodeId);
      result = terminalSessionSchema.parse(
        await this.rpc(target, "end", { sessionId: session.sessionId }),
      );
      if (
        result.sessionId !== session.sessionId ||
        result.nodeId !== session.nodeId ||
        result.ownerId !== session.ownerId ||
        !["ended", "expired", "lost"].includes(result.state)
      )
        throw new ApiError(
          502,
          "TERMINAL_IDENTITY_MISMATCH",
          "Invalid termination result.",
        );
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "terminal_not_found")
        throw error;
      result = { ...session, state: "lost" };
    }
    await this.persist(result, "end");
    await this.store.pool.query(
      "UPDATE terminal_sessions SET end_requested=false WHERE id=$1 AND owner_id=$2",
      [session.sessionId, session.ownerId],
    );
    return result;
  }
  private revokeClient(id: string, owner: string) {
    for (const [key, t] of this.tickets)
      if (t.clientId === id && t.ownerId === owner) this.tickets.delete(key);
    for (const a of this.active)
      if (a.clientId === id && a.ownerId === owner)
        this.disconnect(a, "Workspace disconnected");
  }
  install(server: Server) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 16384,
      perMessageDeflate: false,
    });
    server.on("upgrade", (req, socket, head) => {
      if (
        this.stopped ||
        req.url !== "/v1/terminals/attach" ||
        !terminalOriginAllowed(req, this.config) ||
        this.sockets.size >= 64
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on("error", () => {});
        const timeout = setTimeout(
          () => ws.close(1008, "Attachment required"),
          5000,
        );
        ws.once("close", () => {
          clearTimeout(timeout);
          this.sockets.delete(ws);
        });
        ws.once("message", (raw, binary) => {
          clearTimeout(timeout);
          void (async () => {
            const frame = terminalAttachSchema.parse(
              JSON.parse(raw.toString()),
            );
            const ticket = this.tickets.get(frame.ticket);
            // Consume before any asynchronous work, including failed or racing attachments.
            this.tickets.delete(frame.ticket);
            if (
              binary ||
              !ticket ||
              ticket.expires <= Date.now() ||
              ticket.origin !== req.headers.origin ||
              ticket.ownerId !== this.owner()
            )
              throw new Error("Invalid attachment ticket");
            const target = await this.store.terminalTarget(
              ticket.target.nodeId,
            );
            if (
              target.bootId !== ticket.target.bootId ||
              target.generation !== ticket.target.generation ||
              target.endpoint !== ticket.target.endpoint
            )
              throw new Error("Node lease changed");
            const session = await this.owned(ticket.sessionId);
            if (
              !alive(session) ||
              session.bootId !== target.bootId ||
              ws.readyState !== WebSocket.OPEN
            )
              throw new Error("Session is no longer available");
            await this.connect(
              ws,
              ticket,
              frame.cols,
              frame.rows,
              session.expiresAt,
            );
          })().catch(() => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(
                JSON.stringify({
                  type: "error",
                  code: "TERMINAL_ATTACHMENT_DENIED",
                  message:
                    "Terminal attachment expired or was denied. Refresh and reconnect.",
                }),
              );
            ws.close(1008, "Attachment denied");
          });
        });
      });
    });
  }
  private async connect(
    browser: WebSocket,
    ticket: Ticket,
    cols: number,
    rows: number,
    expires: string,
  ) {
    const a: Active = {
      ...ticket,
      browser,
      until: Math.min(Date.parse(expires), Date.now() + 900000),
      alive: true,
      nodeAlive: true,
    };
    this.active.add(a);
    const url = new URL("/v1/node/terminals/attach", ticket.target.endpoint);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const node = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.nodeToken}` },
      maxPayload: 131072,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
      followRedirects: false,
    });
    a.node = node;
    let ready = false;
    const deadline = setTimeout(
      () => this.disconnect(a, "Node attachment timed out"),
      10000,
    );
    node.on("error", () => this.disconnect(a, "Node terminal unavailable"));
    node.once("open", () => {
      if (browser.readyState !== WebSocket.OPEN) {
        this.disconnect(a, "Browser disconnected");
        return;
      }
      node.send(
        JSON.stringify({
          scope: {
            nodeId: ticket.target.nodeId,
            bootId: ticket.target.bootId,
            generation: ticket.target.generation,
            ownerId: ticket.ownerId,
          },
          sessionId: ticket.sessionId,
          takeover: ticket.takeover,
          cols,
          rows,
        }),
      );
    });
    node.on("message", (raw, binary) => {
      try {
        if (binary) throw new Error("Invalid node frame");
        const frame = terminalServerFrameSchema.parse(
          JSON.parse(raw.toString()),
        );
        if (frame.type === "ready") {
          if (
            ready ||
            frame.session.sessionId !== ticket.sessionId ||
            frame.session.ownerId !== ticket.ownerId ||
            frame.session.nodeId !== ticket.target.nodeId ||
            frame.session.bootId !== ticket.target.bootId
          )
            throw new Error("Invalid session identity");
          ready = true;
          clearTimeout(deadline);
          void this.persist(
            frame.session,
            ticket.takeover ? "takeover" : "attach",
          ).catch(() => this.disconnect(a, "Session metadata unavailable"));
        }
        if (
          browser.readyState !== WebSocket.OPEN ||
          browser.bufferedAmount > MAX_BUFFER
        )
          throw new Error("Slow browser");
        browser.send(JSON.stringify(frame));
      } catch {
        this.disconnect(a, "Terminal output unavailable");
      }
    });
    browser.on("message", (raw, binary) => {
      try {
        if (
          !ready ||
          binary ||
          node.readyState !== WebSocket.OPEN ||
          node.bufferedAmount > MAX_BUFFER
        )
          throw new Error("Terminal is not ready");
        const frame = terminalClientFrameSchema.parse(
          JSON.parse(raw.toString()),
        );
        node.send(JSON.stringify(frame));
      } catch {
        this.disconnect(a, "Invalid terminal input");
      }
    });
    browser.on("pong", () => {
      a.alive = true;
    });
    node.on("pong", () => {
      a.nodeAlive = true;
    });
    node.once("close", (_code, reason) => {
      clearTimeout(deadline);
      this.disconnect(
        a,
        reason.toString().slice(0, 100) || "Node disconnected",
      );
    });
    browser.once("close", () => {
      clearTimeout(deadline);
      this.disconnect(a, "Browser disconnected");
      void this.store.pool
        .query(
          "INSERT INTO terminal_lifecycle(session_id,event) VALUES($1,$2)",
          [a.sessionId, "detach"],
        )
        .catch(() => {});
    });
  }
  private disconnect(a: Active, reason: string) {
    this.active.delete(a);
    for (const socket of [a.browser, a.node]) {
      if (!socket) continue;
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, reason);
        const kill = setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }, 1000);
        kill.unref();
      }
    }
  }
  private tick = 0;
  private async check() {
    for (const [key, ticket] of this.tickets)
      if (ticket.expires <= Date.now()) this.tickets.delete(key);
    if (this.checking) return;
    this.checking = true;
    const ping = ++this.tick % 15 === 0;
    try {
      const pending = await this.store.pool.query(
        "SELECT body FROM terminal_sessions WHERE end_requested AND owner_id=$1 LIMIT 32",
        [this.owner()],
      );
      await Promise.all(
        pending.rows.map((row) =>
          this.endPending(terminalSessionSchema.parse(row.body)).catch(
            () => {},
          ),
        ),
      );
      const targets = new Map<string, Promise<Target>>();
      await Promise.all(
        [...this.active].map(async (a) => {
          try {
            if (a.until <= Date.now() || a.ownerId !== this.owner())
              throw new Error("Expired");
            let target = targets.get(a.target.nodeId);
            if (!target) {
              target = this.store.terminalTarget(a.target.nodeId);
              targets.set(a.target.nodeId, target);
            }
            const current = await target;
            if (
              current.bootId !== a.target.bootId ||
              current.generation !== a.target.generation ||
              current.endpoint !== a.target.endpoint
            )
              throw new Error("Lease changed");
            if (ping) {
              if (!a.alive || !a.nodeAlive) throw new Error("Heartbeat lost");
              a.alive = false;
              a.nodeAlive = false;
              a.browser.ping();
              if (a.node?.readyState === WebSocket.OPEN) a.node.ping();
            }
          } catch {
            this.disconnect(a, "Terminal authorization expired; reconnect");
          }
        }),
      );
    } finally {
      this.checking = false;
    }
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.tickets.clear();
    for (const a of this.active) this.disconnect(a, "Backend restarting");
    for (const socket of this.sockets) socket.terminate();
  }
}
