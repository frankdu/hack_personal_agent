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
