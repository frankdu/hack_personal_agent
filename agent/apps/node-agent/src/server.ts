import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  executionRequestSchema,
  nodeModelSelectionSchema,
  addProjectSchema,
  projectTreeQuerySchema,
  type Hardware,
} from "@agent/contracts";
import type { NodeConfig } from "./config.js";
import { Executions, RequestError } from "./executions.js";
import type { Projects } from "./projects.js";
export interface ServerDependencies {
  projects?: Projects;
  executions: Executions;
  hardware: Hardware;
  nodeId: string;
  bootId: string;
  profiles: () => unknown[];
  registered: () => boolean;
  discoveryStatus?: () => string | undefined;
  selectModel?: (
    input: ReturnType<typeof nodeModelSelectionSchema.parse>,
  ) => void;
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new RequestError(413, "body_too_large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
}
function authenticated(value: string | undefined, token: string | undefined) {
  if (!token) return false;
  const given = Buffer.from(value ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
export function createNodeServer(
  config: NodeConfig,
  dependencies?: ServerDependencies,
) {
  let draining = false;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, data: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(data));
    };
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      if (request.method === "GET" && pathname === "/health/live")
        return send(draining ? 503 : 200, {
          status: draining ? "draining" : "alive",
          mode: config.mode,
        });
      if (request.method === "GET" && pathname === "/health/ready")
        return send(!draining && dependencies?.executions.ready() ? 200 : 503, {
          ready: !draining && Boolean(dependencies?.executions.ready()),
        });
      if (request.method === "GET" && pathname === "/v1/node/status")
        return send(200, {
          name: config.name,
          mode: config.mode,
          nodeId: dependencies?.nodeId,
          bootId: dependencies?.bootId,
          enabledTools: config.enabledTools,
          hardware: dependencies?.hardware,
          profiles: dependencies?.profiles() ?? [],
          modelDiscovery: dependencies?.discoveryStatus?.(),
          registered: dependencies?.registered() ?? false,
          executionReady:
            !draining && Boolean(dependencies?.executions.ready()),
        });
      if (!authenticated(request.headers.authorization, config.sharedToken))
        throw new RequestError(401, "unauthorized");
      if (!dependencies)
        throw new RequestError(503, "execution_not_configured");
      if (pathname === "/v1/node/projects" && dependencies.projects) {
        if (request.method === "GET")
          return send(200, dependencies.projects.list());
        if (request.method === "POST") {
          const input = addProjectSchema.safeParse(await body(request));
          if (!input.success) throw new RequestError(400, "invalid_project");
          return send(
            200,
            await dependencies.projects.add(input.data.directory),
          );
        }
      }
      const tree = /^\/v1\/node\/projects\/([a-f0-9]{64})\/tree$/.exec(
        pathname,
      );
      if (tree && request.method === "GET" && dependencies.projects) {
        const input = projectTreeQuerySchema.safeParse(
          Object.fromEntries(url.searchParams),
        );
        if (!input.success) throw new RequestError(400, "invalid_tree_query");
        return send(
          200,
          await dependencies.projects.tree(
            tree[1]!,
            input.data.path,
            input.data.offset,
          ),
        );
      }
      if (request.method === "POST" && pathname === "/v1/node/model") {
        if (draining) throw new RequestError(503, "draining");
        const parsed = nodeModelSelectionSchema.safeParse(await body(request));
        if (!parsed.success)
          throw new RequestError(400, "invalid_model_selection");
        if (!dependencies.selectModel)
          throw new RequestError(
            409,
            "model_selection_unavailable",
            "This node uses an explicitly configured runtime.",
          );
        dependencies.selectModel(parsed.data);
        return send(202, { profiles: dependencies.profiles() });
      }
      if (request.method === "POST" && pathname === "/v1/executions") {
        if (draining) throw new RequestError(503, "draining");
        const parsed = executionRequestSchema.safeParse(await body(request));
        if (!parsed.success)
          throw new RequestError(400, "invalid_execution_request");
        return send(202, await dependencies.executions.accept(parsed.data));
      }
      const match = /^\/v1\/executions\/([a-f0-9-]{36})(\/cancel)?$/.exec(
        pathname,
      );
      if (match && request.method === "GET" && !match[2])
        return send(200, dependencies.executions.get(match[1]!));
      if (match && request.method === "POST" && match[2])
        return send(200, await dependencies.executions.cancel(match[1]!));
      throw new RequestError(404, "not_found");
    })().catch((error) => {
      if (!response.headersSent)
        send(error instanceof RequestError ? error.status : 500, {
          error: {
            code: error instanceof RequestError ? error.code : "internal_error",
            message:
              error instanceof RequestError
                ? error.message
                : "Node request failed",
          },
        });
      else response.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server,
    drain: () => {
      draining = true;
    },
  };
}
