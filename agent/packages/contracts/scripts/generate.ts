import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import * as contracts from "../src/index.js";

const schemas = Object.fromEntries(
  Object.entries(contracts)
    .filter(
      ([name, value]) => name.endsWith("Schema") && value instanceof z.ZodType,
    )
    .map(([name, value]) => [
      name,
      z.toJSONSchema(value as z.ZodType, {
        target: "draft-2020-12",
        io: "input",
      }),
    ]),
);
const dir = new URL("../generated/", import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(
  new URL("schemas.json", dir),
  JSON.stringify(schemas, null, 2) + "\n",
);
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({
  description: "Success",
  content: { "application/json": { schema: ref(name) } },
});
const operation = (
  request: string | null,
  result: string,
  node = false,
  status = "200",
) => ({
  security: [{ [node ? "nodeToken" : "userToken"]: [] }],
  ...(request
    ? {
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref(request) } },
        },
      }
    : {}),
  responses: {
    [status]: response(result),
    default: { ...response("apiErrorSchema"), description: "Error" },
  },
});
const parameter = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});
const document = {
  openapi: "3.1.0",
  info: { title: "Curilo Agent protocol", version: contracts.PROTOCOL_VERSION },
  paths: {
    "/v1/nodes/{nodeId}/terminals": {
      parameters: [parameter("nodeId")],
      get: operation(null, "terminalListSchema"),
      post: operation(
        "createTerminalSchema",
        "terminalSessionSchema",
        false,
        "201",
      ),
    },
    "/v1/terminals/{sessionId}/ticket": {
      parameters: [parameter("sessionId")],
      post: operation("terminalTicketRequestSchema", "terminalTicketSchema"),
    },
    "/v1/terminals/{sessionId}/end": {
      parameters: [parameter("sessionId")],
      post: {
        ...operation(null, "terminalSessionSchema"),
        responses: {
          "200": response("terminalSessionSchema"),
          "202": {
            ...response("terminalSessionSchema"),
            description: "Termination persisted; awaiting node reconciliation.",
          },
          default: { ...response("apiErrorSchema"), description: "Error" },
        },
      },
    },
    "/v1/terminal-connections/{clientId}": {
      parameters: [parameter("clientId")],
      delete: {
        security: [{ userToken: [] }],
        responses: {
          "200": {
            description:
              "Attachment tickets revoked and active writers detached for this browser connection.",
          },
        },
      },
    },
    "/v1/node/terminals": {
      post: {
        ...operation("nodeTerminalRequestSchema", "terminalListSchema", true),
        responses: {
          "200": {
            description:
              "List returns terminalListSchema; end returns terminalSessionSchema.",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    ref("terminalListSchema"),
                    ref("terminalSessionSchema"),
                  ],
                },
              },
            },
          },
          "201": response("terminalSessionSchema"),
        },
      },
    },
    "/v1/terminals/attach": {
      get: {
        description:
          "WebSocket upgrade. Require an allowlisted Origin and TLS outside loopback. Send terminalAttachSchema as the first frame within five seconds. The 30-second ticket is single-use and never sent in a URL. Then exchange terminalClientFrameSchema / terminalServerFrameSchema; ACK output UTF-8 bytes after rendering. Attachment expires after 15 minutes; reconnect explicitly with a fresh ticket. No input replay.",
        responses: {
          "101": {
            description:
              "WebSocket upgraded; authorization completes on the first frame.",
          },
        },
      },
    },
    "/v1/node/terminals/attach": {
      get: {
        description:
          "Backend-only WebSocket upgrade with node bearer Authorization. Send nodeTerminalAttachSchema first; every attachment is bound to the current boot and lease generation.",
        security: [{ nodeToken: [] }],
        responses: { "101": { description: "Node terminal stream." } },
      },
    },
    "/v1/nodes": { get: operation(null, "nodesResponseSchema") },
    "/v1/nodes/{nodeId}/projects": {
      parameters: [parameter("nodeId")],
      get: operation(null, "projectsResponseSchema"),
      post: operation("addProjectSchema", "projectSchema"),
    },
    "/v1/node/projects": {
      get: operation(null, "projectsResponseSchema", true),
      post: operation("addProjectSchema", "projectSchema", true),
    },
    "/v1/nodes/{nodeId}/projects/{projectId}/tree": {
      parameters: [
        parameter("nodeId"),
        {
          name: "projectId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      ],
      get: {
        ...operation(null, "projectTreeResponseSchema"),
        parameters: [
          {
            name: "path",
            in: "query",
            schema: { type: "string", default: ".", maxLength: 4096 },
          },
          {
            name: "offset",
            in: "query",
            schema: {
              type: "integer",
              minimum: 0,
              maximum: 1000000,
              default: 0,
            },
          },
        ],
      },
    },
    "/v1/node/projects/{projectId}/tree": {
      parameters: [
        {
          name: "projectId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      ],
      get: {
        ...operation(null, "projectTreeResponseSchema", true),
        parameters: [
          {
            name: "path",
            in: "query",
            schema: { type: "string", default: ".", maxLength: 4096 },
          },
          {
            name: "offset",
            in: "query",
            schema: {
              type: "integer",
              minimum: 0,
              maximum: 1000000,
              default: 0,
            },
          },
        ],
      },
    },
    "/v1/nodes/{nodeId}/model": {
      parameters: [parameter("nodeId")],
      post: operation(
        "modelSelectionSchema",
        "modelSelectionResponseSchema",
        false,
        "202",
      ),
    },
    "/v1/node/model": {
      post: operation(
        "nodeModelSelectionSchema",
        "modelSelectionResponseSchema",
        true,
        "202",
      ),
    },
    "/v1/nodes/register": {
      post: operation("registrationSchema", "leaseSchema", true),
    },
    "/v1/nodes/{nodeId}/heartbeats": {
      parameters: [parameter("nodeId")],
      post: operation("heartbeatSchema", "leaseSchema", true),
    },
    "/v1/conversations": {
      get: operation(null, "conversationsResponseSchema"),
      post: operation(null, "conversationSchema", false, "201"),
    },
    "/v1/conversations/{conversationId}": {
      parameters: [parameter("conversationId")],
      get: operation(null, "conversationSchema"),
    },
    "/v1/conversations/{conversationId}/messages": {
      parameters: [parameter("conversationId")],
      post: {
        ...operation("submitMessageSchema", "taskResponseSchema", false, "202"),
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 128 },
          },
        ],
      },
    },
    "/v1/conversations/{conversationId}/events": {
      parameters: [parameter("conversationId")],
      get: {
        security: [{ userToken: [] }],
        parameters: [
          {
            name: "after",
            in: "query",
            schema: { type: "integer", minimum: 0 },
          },
          { name: "Last-Event-ID", in: "header", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "Durable ordered SSE; data validates against eventSchema. Reconnect using last event ID.",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/v1/tasks/{taskId}": {
      parameters: [parameter("taskId")],
      get: operation(null, "taskSchema"),
    },
    "/v1/tasks/{taskId}/cancel": {
      parameters: [parameter("taskId")],
      post: operation(null, "taskSchema"),
    },
    "/v1/tasks/{taskId}/decisions": {
      parameters: [parameter("taskId")],
      get: {
        security: [{ userToken: [] }],
        responses: {
          "200": {
            description: "Audit records",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    decisions: { type: "array", items: ref("decisionSchema") },
                  },
                  required: ["decisions"],
                },
              },
            },
          },
        },
      },
    },
    "/v1/executions": {
      post: operation(
        "executionRequestSchema",
        "executionSnapshotSchema",
        true,
        "202",
      ),
    },
    "/v1/executions/{attemptId}": {
      parameters: [parameter("attemptId")],
      get: operation(null, "executionSnapshotSchema", true),
    },
    "/v1/executions/{attemptId}/cancel": {
      parameters: [parameter("attemptId")],
      post: operation(null, "executionSnapshotSchema", true),
    },
  },
  components: {
    schemas,
    securitySchemes: {
      userToken: { type: "http", scheme: "bearer" },
      nodeToken: { type: "http", scheme: "bearer" },
    },
  },
};
await writeFile(
  new URL("openapi.json", dir),
  JSON.stringify(document, null, 2) + "\n",
);
