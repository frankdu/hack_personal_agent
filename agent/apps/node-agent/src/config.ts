import { hostname } from "node:os";
import { resolve } from "node:path";
import { enabledToolSchema, modeSchema, type EnabledTool, type Mode } from "@agent/contracts";

export const supportedTools = enabledToolSchema.options;
export type { EnabledTool } from "@agent/contracts";

export interface NodeConfig {
  mode: Mode;
  host: string;
  port: number;
  name: string;
  stateDir: string;
  workspaceDir: string;
  enabledTools: EnabledTool[];
  modelProvider?: string;
  modelId?: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const parsedMode = modeSchema.safeParse(env.MODE ?? "DEV");
  if (!parsedMode.success) throw new Error("MODE must be DEV or PROD");
  const mode = parsedMode.data;
  const portText = env.PORT ?? "3101";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const requested = (env.ENABLED_TOOLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const tool of requested) {
    if (!(supportedTools as readonly string[]).includes(tool)) {
      throw new Error(`Unsupported tool in ENABLED_TOOLS: ${tool}`);
    }
  }
  const modelProvider = env.MODEL_PROVIDER?.trim() || undefined;
  const modelId = env.MODEL_ID?.trim() || undefined;
  if (Boolean(modelProvider) !== Boolean(modelId)) {
    throw new Error("MODEL_PROVIDER and MODEL_ID must be supplied together");
  }
  const host = env.HOST?.trim() || "127.0.0.1";
  return {
    mode,
    host,
    port,
    name: env.NODE_NAME?.trim() || hostname(),
    stateDir: resolve(env.NODE_STATE_DIR ?? ".state/node-agent"),
    workspaceDir: resolve(env.AGENT_WORKSPACE_DIR ?? process.cwd()),
    enabledTools: [...new Set(requested)] as EnabledTool[],
    modelProvider,
    modelId,
  };
}
