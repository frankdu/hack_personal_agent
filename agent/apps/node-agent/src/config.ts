import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  enabledToolSchema,
  modeSchema,
  type EnabledTool,
  type Mode,
} from "@agent/contracts";

export const supportedTools = enabledToolSchema.options;
export type { EnabledTool } from "@agent/contracts";

export interface OllamaConfig {
  enabled: boolean;
  url: string;
  minTokensPerSecond: number;
  contextWindow: number;
  benchmarkTimeoutMs: number;
  benchmarkTtlMs: number;
  refreshIntervalMs: number;
  modelPriority: string[];
}

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
  backendUrl?: string;
  endpoint: string;
  sharedToken?: string;
  workspaceId: string;
  runtimeConfigPath?: string;
  ollama: OllamaConfig;
}

function setting(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${key}`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const parsedMode = modeSchema.safeParse(env.MODE ?? "DEV");
  if (!parsedMode.success) throw new Error("MODE must be DEV or PROD");
  const mode = parsedMode.data;
  const portText = env.PORT ?? "3101";
  const port = Number(portText);
  if (
    !/^\d+$/.test(portText) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const requested = (env.ENABLED_TOOLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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
  const backendUrl = env.BACKEND_URL?.trim() || undefined;
  const sharedToken = env.NODE_SHARED_TOKEN?.trim() || undefined;
  const endpoint = env.NODE_ENDPOINT?.trim() || `http://127.0.0.1:${port}`;
  for (const value of [backendUrl, endpoint].filter(Boolean)) {
    const url = new URL(value!);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error(
        "Backend and node URLs must be HTTP(S) origins without credentials",
      );
    }
  }
  if (backendUrl && (!sharedToken || sharedToken.length < 32))
    throw new Error(
      "NODE_SHARED_TOKEN must contain at least 32 characters when BACKEND_URL is set",
    );
  if (
    env.OLLAMA_AUTO_DISCOVER !== undefined &&
    !["true", "false"].includes(env.OLLAMA_AUTO_DISCOVER)
  )
    throw new Error("OLLAMA_AUTO_DISCOVER must be true or false");
  const ollamaUrl = new URL(env.OLLAMA_URL ?? "http://127.0.0.1:11434");
  if (
    ollamaUrl.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(ollamaUrl.hostname) ||
    ollamaUrl.username ||
    ollamaUrl.password ||
    ollamaUrl.search ||
    ollamaUrl.hash ||
    ollamaUrl.pathname !== "/"
  )
    throw new Error("OLLAMA_URL must be a loopback HTTP origin");
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
    backendUrl,
    endpoint: new URL(endpoint).origin,
    sharedToken,
    workspaceId: env.WORKSPACE_ID?.trim() || "default",
    runtimeConfigPath: env.RUNTIME_CONFIG
      ? resolve(env.RUNTIME_CONFIG)
      : undefined,
    ollama: {
      enabled: env.OLLAMA_AUTO_DISCOVER !== "false",
      url: ollamaUrl.origin,
      minTokensPerSecond: setting(
        env,
        "OLLAMA_MIN_TOKENS_PER_SECOND",
        20,
        20,
        10000,
      ),
      contextWindow: setting(env, "OLLAMA_CONTEXT_WINDOW", 8192, 256, 262144),
      benchmarkTimeoutMs: setting(
        env,
        "OLLAMA_BENCHMARK_TIMEOUT_MS",
        180000,
        1000,
        600000,
      ),
      benchmarkTtlMs: setting(
        env,
        "OLLAMA_BENCHMARK_TTL_MS",
        21600000,
        1000,
        86400000,
      ),
      refreshIntervalMs: setting(
        env,
        "OLLAMA_REFRESH_INTERVAL_MS",
        60000,
        1000,
        3600000,
      ),
      modelPriority: [
        ...new Set(
          (env.OLLAMA_MODEL_PRIORITY ?? "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ],
    },
  };
}
