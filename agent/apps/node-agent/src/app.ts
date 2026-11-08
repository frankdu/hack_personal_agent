import { mkdir, realpath, stat, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { readConfig, type NodeConfig } from './config.js';
import { durableWrite, readJson } from './storage.js';
import { inspectHardware } from './hardware.js';
import { loadRuntime, RuntimeSupervisor } from './runtime.js';
import { PiExecutor } from './pi-session.js';
import { Enrollment } from './enrollment.js';
import { Executions } from './executions.js';
import { createNodeServer } from './server.js';
async function acquire(stateDir: string, bootId: string) {
  const path = join(stateDir, 'owner.lock');
  try { await mkdir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid: number };
    if (!Number.isInteger(existing.pid) || existing.pid < 1) throw new Error('Invalid state lock');
    try { process.kill(existing.pid, 0); throw new Error('Node state directory already in use'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    await rm(path, { recursive: true }); await mkdir(path);
  }
  await durableWrite(join(path, 'owner.json'), { pid: process.pid, bootId });
  return async () => { const owner = await readJson(join(path, 'owner.json')) as { bootId: string } | undefined; if (owner?.bootId === bootId) await rm(path, { recursive: true }); };
}
export async function startNode(config: NodeConfig = readConfig()) {
  if (!(await stat(config.workspaceDir)).isDirectory()) throw new Error('Workspace must be a directory');
  config = { ...config, workspaceDir: await realpath(config.workspaceDir) };
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  config = { ...config, stateDir: await realpath(config.stateDir) };
  const stateWithinWorkspace = relative(config.workspaceDir, config.stateDir);
  if (config.enabledTools.length && (stateWithinWorkspace === '' || (!stateWithinWorkspace.startsWith('..') && !isAbsolute(stateWithinWorkspace)))) throw new Error('Private node state must be outside any tool-enabled workspace');
  const bootId = randomUUID(); const unlock = await acquire(config.stateDir, bootId);
  let runtime: RuntimeSupervisor | undefined; let enrollment: Enrollment | undefined; let executions: Executions | undefined;
  try {
    const stored = await readJson(join(config.stateDir, 'identity.json')) as { nodeId: string } | undefined;
    const nodeId = stored?.nodeId ?? randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(nodeId)) throw new Error('Invalid persisted identity');
    await durableWrite(join(config.stateDir, 'identity.json'), { nodeId });
    const [hardware, manifest] = await Promise.all([inspectHardware(), loadRuntime(config.runtimeConfigPath)]);
    if (manifest) runtime = new RuntimeSupervisor(manifest, nodeId, config.stateDir, hardware.availableMemoryBytes);
    const profiles = () => runtime ? [runtime.profile()] : [];
    enrollment = new Enrollment(config, nodeId, bootId, hardware, profiles, () => executions?.activeIds() ?? []);
    executions = new Executions(config, nodeId, bootId, () => enrollment!.current(), () => runtime?.profile().state === 'ready' ? runtime.profile().id : undefined, manifest ? new PiExecutor(config, manifest) : { run: async () => { throw new Error('No configured runtime'); } });
    await executions.initialize();
    enrollment.onLeaseLost = () => executions!.abort('lease_lost');
    if (runtime) runtime.onUnavailable = () => executions!.abort('runtime_unavailable');
    const { server, drain } = createNodeServer(config, { executions, hardware, nodeId, bootId, profiles, registered: () => Boolean(enrollment!.current()) });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); }); });
    const starting = Promise.all([enrollment.start(), runtime?.start()]);
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true; drain();
      try {
        await executions!.close();
        await Promise.allSettled([enrollment!.close(), runtime?.close(), starting]);
      } finally {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
        await unlock();
      }
    };
    return { server, nodeId, bootId, executions, runtime, enrollment, close, started: starting };
  } catch (error) { await runtime?.close().catch(() => {}); await enrollment?.close(); await unlock(); throw error; }
}
