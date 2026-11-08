import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// A disposable database with a dynamically assigned loopback port. Never touches existing services.
const name = `curilo_agent-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
let started = false;
try {
  docker(['run', '--rm', '--detach', '--name', name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=agent_test', '--publish', '127.0.0.1::5432', 'postgres:18-bookworm'], { env: { ...process.env, POSTGRES_PASSWORD: password } });
  started = true;
  const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'agent_test']); ready = true; break; } catch { await setTimeout(500); }
  }
  if (!ready) throw new Error('Disposable PostgreSQL failed to become ready');
  console.info('Disposable PostgreSQL is ready; running real backend/node/Pi integration with a scripted local model endpoint.');
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', 'tests/integration/e2e.test.ts', 'apps/agent-backend/test/store.integration.test.ts'], {
    stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/agent_test` },
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
} finally {
  if (started) { docker(['stop', '--time', '5', name]); console.info('Removed the disposable PostgreSQL container.'); }
}
