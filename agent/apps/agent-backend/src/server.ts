import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  registrationSchema,
  heartbeatSchema,
  submitMessageSchema,
  modelSelectionSchema,
  deleteMessageSchema,
  addProjectSchema,
  projectSchema,
  projectsResponseSchema,
  projectTreeQuerySchema,
  projectTreeResponseSchema,
} from "@agent/contracts";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import { Store } from "./store.js";
import { Dispatcher } from "./dispatcher.js";

function authorized(req: IncomingMessage, token: string): boolean {
  const a = Buffer.from(req.headers.authorization ?? "");
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new ApiError(415, "CONTENT_TYPE", "Use application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000)
      throw new ApiError(
        413,
        "BODY_TOO_LARGE",
        "Request exceeds one megabyte.",
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Invalid JSON body.");
  }
}
const uuid =
  "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";

export async function startBackend(
  config: Config,
  options: { dispatch?: boolean; migrate?: boolean } = {},
) {
  const store = new Store(config);
  const dispatcher = new Dispatcher(store);
  const streams = new Set<ServerResponse>();
  try {
    if (options.migrate !== false) await store.migrate();
  } catch (error) {
    await store.pool.end();
    throw error;
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof ApiError)
        json(res, error.status, {
          error: { code: error.code, message: error.message },
        });
      else if (error?.name === "ZodError")
        json(res, 400, {
          error: {
            code: "INVALID_REQUEST",
            message: "Request does not match the API schema.",
          },
        });
      else {
        console.error(JSON.stringify({ event: "request_failed" }));
        json(res, 500, {
          error: {
            code: "INTERNAL_ERROR",
            message: "Request could not be completed.",
          },
        });
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const requestOrigin = req.headers.origin;
    if (requestOrigin) {
      if (!config.frontendOrigins.has(requestOrigin))
        throw new ApiError(
          403,
          "ORIGIN_NOT_ALLOWED",
          "Frontend origin is not allowed.",
        );
      res.setHeader("access-control-allow-origin", requestOrigin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader(
        "access-control-allow-headers",
        "Authorization,Content-Type,Idempotency-Key,Last-Event-ID",
      );
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://backend.invalid");
    const path = url.pathname;
    if (req.method === "GET" && path === "/health/live") {
      json(res, 200, { status: "alive", mode: config.mode });
      return;
    }
    if (req.method === "GET" && path === "/health/ready") {
      try {
        await store.pool.query("SELECT 1");
        json(res, 200, {
          status: "ready",
          routing: config.jevApiKey ? "jev-configured" : "rules-only",
        });
      } catch {
        json(res, 503, { status: "unavailable" });
      }
      return;
    }
    if (req.method === "POST" && path === "/v1/nodes/register") {
      if (!authorized(req, config.nodeToken))
        throw new ApiError(401, "UNAUTHORIZED", "Node bearer token required.");
      json(
        res,
        200,
        await store.register(registrationSchema.parse(await body(req))),
      );
      return;
    }
    const heartbeat = path.match(
      new RegExp(`^/v1/nodes/(${uuid})/heartbeats?$`),
    );
    if (req.method === "POST" && heartbeat) {
      if (!authorized(req, config.nodeToken))
        throw new ApiError(401, "UNAUTHORIZED", "Node bearer token required.");
      json(
        res,
        200,
        await store.heartbeat(
          heartbeat[1]!,
          heartbeatSchema.parse(await body(req)),
        ),
      );
      return;
    }
    if (!authorized(req, config.apiToken))
      throw new ApiError(401, "UNAUTHORIZED", "User bearer token required.");
    if (req.method === "GET" && path === "/v1/nodes") {
      json(res, 200, { nodes: (await store.nodes()).map((n) => n.node) });
      return;
    }
    const nodeModel = path.match(new RegExp(`^/v1/nodes/(${uuid})/model$`));
    const projects = path.match(new RegExp(`^/v1/nodes/(${uuid})/projects$`));
    if (projects && req.method === "GET") {
      json(
        res,
        200,
        projectsResponseSchema.parse(
          await store.projectRequest(projects[1]!, "", "GET"),
        ),
      );
      return;
    }
    if (projects && req.method === "POST") {
      const input = addProjectSchema.parse(await body(req));
      json(
        res,
        200,
        projectSchema.parse(
          await store.projectRequest(projects[1]!, "", "POST", input),
        ),
      );
      return;
    }
    const tree = path.match(
      new RegExp(`^/v1/nodes/(${uuid})/projects/([a-f0-9]{64})/tree$`),
    );
    if (tree && req.method === "GET") {
      const query = projectTreeQuerySchema.parse(
        Object.fromEntries(new URL(req.url!, "http://localhost").searchParams),
      );
      const search = new URLSearchParams({
        path: query.path,
        offset: String(query.offset),
      });
      json(
        res,
        200,
        projectTreeResponseSchema.parse(
          await store.projectRequest(
            tree[1]!,
            `/${tree[2]}/tree?${search}`,
            "GET",
          ),
        ),
      );
      return;
    }
    if (req.method === "POST" && nodeModel) {
      const input = modelSelectionSchema.parse(await body(req));
      json(res, 202, await store.selectModel(nodeModel[1]!, input.profileId));
      return;
    }
    if (req.method === "GET" && path === "/v1/conversations") {
      json(res, 200, { conversations: await store.conversations() });
      return;
    }
    if (req.method === "POST" && path === "/v1/conversations") {
      json(res, 201, await store.createConversation());
      return;
    }
    const conversation = path.match(
      new RegExp(`^/v1/conversations/(${uuid})$`),
    );
    if (req.method === "GET" && conversation) {
      json(res, 200, await store.conversation(conversation[1]!));
      return;
    }
    const message = path.match(
      new RegExp(`^/v1/conversations/(${uuid})/messages/(${uuid})$`),
    );
    if (req.method === "DELETE" && message) {
      const input = deleteMessageSchema.parse(await body(req));
      json(
        res,
        200,
        await store.deleteMessage(
          message[1]!,
          message[2]!,
          input.expectedRevision,
        ),
      );
      return;
    }
    const messages = path.match(
      new RegExp(`^/v1/conversations/(${uuid})/messages$`),
    );
    if (req.method === "POST" && messages) {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 1 || key.length > 128)
        throw new ApiError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "Provide an Idempotency-Key header with 1–128 characters.",
        );
      json(
        res,
        202,
        await store.submit(
          messages[1]!,
          key,
          submitMessageSchema.parse(await body(req)),
        ),
      );
      return;
    }
    const events = path.match(
      new RegExp(`^/v1/conversations/(${uuid})/events$`),
    );
    if (req.method === "GET" && events) {
      const conversationId = events[1]!;
      await store.conversation(conversationId);
      const cursor =
        url.searchParams.get("after") ?? req.headers["last-event-id"] ?? "0";
      let after = Number(cursor);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "Event cursor must be a nonnegative integer.",
        );
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      streams.add(res);
      let busy = false;
      const pump = async () => {
        if (busy || res.destroyed) return;
        busy = true;
        try {
          for (const event of await store.events(conversationId, after)) {
            if (
              !res.write(
                `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
            ) {
              res.end();
              break;
            }
            after = event.id;
          }
        } catch {
          res.end();
        } finally {
          busy = false;
        }
      };
      const poll = setInterval(() => void pump(), 500);
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
      res.once("close", () => {
        clearInterval(poll);
        clearInterval(keepalive);
        streams.delete(res);
      });
      void pump();
      return;
    }
    const task = path.match(
      new RegExp(`^/v1/tasks/(${uuid})(?:/(cancel|decisions))?$`),
    );
    if (task && req.method === "GET" && !task[2]) {
      json(res, 200, await store.task(task[1]!));
      return;
    }
    if (task && req.method === "GET" && task[2] === "decisions") {
      json(res, 200, { decisions: await store.decisions(task[1]!) });
      return;
    }
    if (task && req.method === "POST" && task[2] === "cancel") {
      json(res, 200, await store.cancel(task[1]!));
      return;
    }
    throw new ApiError(404, "NOT_FOUND", "Endpoint not found.");
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    await store.pool.end();
    throw error;
  }
  if (options.dispatch !== false) dispatcher.start();
  return {
    server,
    store,
    dispatcher,
    async close() {
      for (const stream of streams) stream.end();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeIdleConnections();
      await dispatcher.stop();
      await closed;
      await store.pool.end();
    },
  };
}
