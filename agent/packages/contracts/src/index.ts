import { z } from 'zod';

/** Deployment mode, distinct from NODE_ENV and Vite's own mode names. */
export const modeSchema = z.enum(['DEV', 'PROD']);
export type Mode = z.infer<typeof modeSchema>;

/** Built-in Pi tools only. Enabling a name does not establish a sandbox. */
export const enabledToolSchema = z.enum(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
export type EnabledTool = z.infer<typeof enabledToolSchema>;

export const routingPreferenceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('manual'), nodeId: z.string().min(1) }).strict(),
]);
export type RoutingPreference = z.infer<typeof routingPreferenceSchema>;

export const PROTOCOL_VERSION = '1' as const;
const id = z.string().uuid();
const time = z.string().datetime();
export const hardwareSchema = z.object({
  platform: z.string(), arch: z.string(), cpuModel: z.string(), cpuCores: z.number().int().positive(),
  memoryBytes: z.number().int().nonnegative(), availableMemoryBytes: z.number().int().nonnegative(),
  unifiedMemory: z.boolean(),
  gpus: z.array(z.object({ name: z.string(), vendor: z.enum(['apple', 'nvidia', 'other']), memoryBytes: z.number().int().nonnegative().nullable() })),
  docker: z.object({ available: z.boolean(), scope: z.enum(['host', 'vm', 'unknown']) }),
});
export type Hardware = z.infer<typeof hardwareSchema>;
export const modelProfileSchema = z.object({
  id: z.string().min(1).max(128), modelId: z.string().min(1).max(256),
  runtime: z.enum(['native', 'docker', 'external']), state: z.enum(['stopped', 'starting', 'ready', 'failed']),
  contextWindow: z.number().int().positive(), concurrency: z.number().int().positive(),
  discovery: z.object({
    source: z.literal('ollama'), selected: z.boolean(), reason: z.string().max(256),
    parameterCount: z.number().positive().optional(), tokensPerSecond: z.number().nonnegative().optional(),
    measuredAt: time.optional(),
  }).optional(),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export const registrationSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), nodeId: id, bootId: id, name: z.string().min(1).max(128),
  endpoint: z.string().url(), hardware: hardwareSchema, enabledTools: z.array(enabledToolSchema),
  workspaceIds: z.array(z.string().min(1).max(128)).min(1), profiles: z.array(modelProfileSchema),
}).strict();
export type Registration = z.infer<typeof registrationSchema>;
export const leaseSchema = z.object({ nodeId: id, bootId: id, generation: id, expiresAt: time, heartbeatIntervalMs: z.number().int().positive() });
export type Lease = z.infer<typeof leaseSchema>;
export const heartbeatSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), bootId: id, generation: id, sequence: z.number().int().nonnegative(),
  draining: z.boolean(), activeAttempts: z.array(id), profiles: z.array(modelProfileSchema),
  availableMemoryBytes: z.number().int().nonnegative(),
}).strict();
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export const fleetNodeSchema = registrationSchema.omit({ endpoint: true }).extend({
  status: z.enum(['online', 'offline', 'draining']), lastSeenAt: time,
  activeAttempts: z.array(id), leaseExpiresAt: time,
});
export type FleetNode = z.infer<typeof fleetNodeSchema>;
export const nodesResponseSchema = z.object({ nodes: z.array(fleetNodeSchema) });

export const taskPolicySchema = z.object({
  workspaceId: z.string().min(1).max(128).default('default'),
  allowedTools: z.array(enabledToolSchema).default([]),
  allowHostedJudgment: z.boolean().default(true), allowRulesFallback: z.boolean().default(true),
}).strict();
export type TaskPolicy = z.infer<typeof taskPolicySchema>;
export const submitMessageSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), text: z.string().trim().min(1).max(32_000),
  expectedRevision: z.number().int().nonnegative(),
  routing: routingPreferenceSchema.default({ mode: 'auto' }), policy: taskPolicySchema.default({ workspaceId: 'default', allowedTools: [], allowHostedJudgment: true, allowRulesFallback: true }),
}).strict();
export type SubmitMessage = z.infer<typeof submitMessageSchema>;
export const messageSchema = z.object({ id, role: z.enum(['user', 'assistant']), text: z.string(), createdAt: time, taskId: id.nullable() });
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({ id, revision: z.number().int().nonnegative(), messages: z.array(messageSchema), activeTaskId: id.nullable() });
export type Conversation = z.infer<typeof conversationSchema>;
export const taskStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const decisionSchema = z.object({
  id, taskId: id, nodeId: id, profileId: z.string(), provider: z.enum(['jev', 'rules']),
  modelRevision: z.string().nullable(), promptRevision: z.string(), reasonCode: z.string(), reason: z.string(),
  candidateNodeIds: z.array(id), latencyMs: z.number().nonnegative(), createdAt: time,
});
export type Decision = z.infer<typeof decisionSchema>;
export const taskSchema = z.object({
  id, conversationId: id, status: taskStatusSchema, attemptId: id, decision: decisionSchema,
  output: z.string(), error: z.string().nullable(), createdAt: time,
});
export type Task = z.infer<typeof taskSchema>;
export const taskResponseSchema = z.object({ task: taskSchema, revision: z.number().int().nonnegative() });

/** One colocated execution. The node may execute ONLY these explicitly granted tools. */
export const executionRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), attemptId: id, taskId: id, conversationId: id,
  nodeId: id, bootId: id, generation: id, deadline: time, profileId: z.string().min(1),
  workspaceId: z.string().min(1), allowedTools: z.array(enabledToolSchema),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(128_000) })).min(1).max(100),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export const executionSnapshotSchema = z.object({
  attemptId: id, inputDigest: z.string(), status: taskStatusSchema, output: z.string(), error: z.string().nullable(),
  sequence: z.number().int().nonnegative(), updatedAt: time,
});
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export const eventSchema = z.object({
  id: z.number().int().positive(), conversationId: id, taskId: id.nullable(),
  type: z.enum(['message', 'task', 'decision']), createdAt: time,
  data: z.union([messageSchema, taskSchema, decisionSchema]),
});
export type ConversationEvent = z.infer<typeof eventSchema>;
export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Canonical JSON for digesting a request (omit inputDigest before hashing). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${fields.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
