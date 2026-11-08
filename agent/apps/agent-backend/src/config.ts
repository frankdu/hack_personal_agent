import { modeSchema } from '@agent/contracts';

export interface Config {
  mode: 'DEV' | 'PROD'; host: string; port: number; databaseUrl: string;
  apiToken: string; nodeToken: string; nodeOrigins: Set<string>; frontendOrigins: Set<string>;
  jevApiKey?: string; jevModel: string; jevTimeoutMs: number;
  leaseMs: number; heartbeatMs: number; executionTimeoutMs: number;
}
function integer(value: string | undefined, fallback: number, name: string, min = 1, max = 86_400_000): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}
export function origin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Endpoints must be HTTP(S) origins without credentials, path, query or fragment.');
  }
  return url.origin;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = modeSchema.parse(env.MODE ?? 'DEV');
  const token = (key: string) => {
    const value = env[key];
    if (!value || value.length < 16) throw new Error(`${key} must contain at least 16 characters.`);
    return value;
  };
  const apiToken = token('API_TOKEN'); const nodeToken = token('NODE_SHARED_TOKEN');
  if (apiToken === nodeToken) throw new Error('API_TOKEN and NODE_SHARED_TOKEN must differ.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  if (mode === 'PROD' && (!env.FRONTEND_ORIGINS || !env.NODE_ENDPOINT_ALLOWLIST)) throw new Error('PROD requires FRONTEND_ORIGINS and NODE_ENDPOINT_ALLOWLIST.');
  const parseOrigins = (value: string) => new Set(value.split(',').map(s => s.trim()).filter(Boolean).map(origin));
  const config: Config = {
    mode, host: env.HOST ?? '127.0.0.1', port: integer(env.PORT, 3100, 'PORT', 1, 65535),
    databaseUrl: env.DATABASE_URL, apiToken, nodeToken,
    nodeOrigins: parseOrigins(env.NODE_ENDPOINT_ALLOWLIST ?? 'http://127.0.0.1:3101,http://localhost:3101'),
    frontendOrigins: parseOrigins(env.FRONTEND_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000'),
    ...(env.JEV_API_KEY ? { jevApiKey: env.JEV_API_KEY } : {}), jevModel: env.JEV_MODEL ?? 'jev-1.14.0',
    jevTimeoutMs: integer(env.JEV_TIMEOUT_MS, 2000, 'JEV_TIMEOUT_MS', 100, 30_000),
    leaseMs: integer(env.NODE_LEASE_MS, 20_000, 'NODE_LEASE_MS', 1000),
    heartbeatMs: integer(env.HEARTBEAT_INTERVAL_MS, 5000, 'HEARTBEAT_INTERVAL_MS', 100),
    executionTimeoutMs: integer(env.EXECUTION_TIMEOUT_MS, 600_000, 'EXECUTION_TIMEOUT_MS', 1000),
  };
  if (config.heartbeatMs >= config.leaseMs) throw new Error('Heartbeat interval must be shorter than the node lease.');
  return config;
}
