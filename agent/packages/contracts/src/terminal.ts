import { z } from "zod";

const id = z.uuid();
const time = z.iso.datetime();
export const terminalSizeSchema = z
  .object({
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(200),
  })
  .strict();
export const createTerminalSchema = z
  .object({
    // Client-generated ID makes a timed-out create safe to retry.
    sessionId: id,
    workspaceId: z.string().min(1).max(128),
    backend: z.enum(["tmux", "pty"]).default("tmux"),
    ...terminalSizeSchema.shape,
  })
  .strict();
export const terminalSessionSchema = z.object({
  sessionId: id,
  nodeId: id,
  ownerId: z.string().regex(/^[a-f0-9]{64}$/),
  bootId: id,
  workspaceId: z.string().min(1).max(128),
  osUserRef: z.string(),
  backend: z.enum(["tmux", "pty"]),
  shellLocation: z.enum(["host", "container"]),
  state: z.enum(["detached", "attached", "ending", "ended", "expired", "lost"]),
  createdAt: time,
  expiresAt: time,
  idleExpiresAt: time,
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export const terminalListSchema = z.object({
  sessions: z.array(terminalSessionSchema).max(128),
  capability: z.object({
    available: z.boolean(),
    tmux: z.boolean(),
    reason: z.string().nullable(),
    shellLocation: z.enum(["host", "container"]),
    maxSessions: z.number().int(),
    idleTimeoutMs: z.number().int(),
    maxLifetimeMs: z.number().int(),
  }),
});
export const terminalScopeSchema = z
  .object({
    nodeId: id,
    bootId: id,
    generation: id,
    ownerId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const nodeTerminalRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), scope: terminalScopeSchema }).strict(),
  z
    .object({
      action: z.literal("create"),
      scope: terminalScopeSchema,
      input: createTerminalSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("end"),
      scope: terminalScopeSchema,
      sessionId: id,
    })
    .strict(),
]);
export const terminalTicketRequestSchema = z
  .object({
    clientId: id,
    takeover: z.boolean().default(false),
  })
  .strict();
export const terminalTicketSchema = z.object({
  ticket: z.string().min(32).max(128),
  expiresAt: time,
});
export const terminalAttachSchema = z
  .object({
    type: z.literal("attach"),
    ticket: z.string().min(32).max(128),
    ...terminalSizeSchema.shape,
  })
  .strict();
export const nodeTerminalAttachSchema = z
  .object({
    scope: terminalScopeSchema,
    sessionId: id,
    takeover: z.boolean(),
    ...terminalSizeSchema.shape,
  })
  .strict();
export const terminalClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(8192) }).strict(),
  z.object({ type: z.literal("resize"), ...terminalSizeSchema.shape }).strict(),
  z
    .object({
      type: z.literal("ack"),
      bytes: z.number().int().min(1).max(262144),
    })
    .strict(),
]);
export const terminalServerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("ready"), session: terminalSessionSchema })
    .strict(),
  z.object({ type: z.literal("output"), data: z.string().max(65536) }).strict(),
  z.object({ type: z.literal("exit"), reason: z.string().max(256) }).strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.string().max(128),
      message: z.string().max(512),
    })
    .strict(),
]);
