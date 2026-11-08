import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hardware } from '@agent/contracts';
import { readConfig } from '../src/config.js';
import { OllamaDiscovery, measuredSpeed, parameterCount, supportedFamily } from '../src/ollama.js';
import { startNode } from '../src/app.js';

const hardware: Hardware = { platform: 'darwin', arch: 'arm64', cpuModel: 'Apple test', cpuCores: 8, memoryBytes: 64 * 1024 ** 3, availableMemoryBytes: 32 * 1024 ** 3, unifiedMemory: true, gpus: [{ name: 'Apple GPU', vendor: 'apple', memoryBytes: null }], docker: { available: false, scope: 'unknown' } };
interface Model { name: string; parameters: number; speed: number; speeds?: number[]; digest?: string; capabilities?: string[]; count?: number; cloud?: boolean; size?: number; warmupFails?: boolean; }
async function fixture(models: Model[]) {
  let available = true; let busy = false; let version = 'test-1';
  let holdWarmup = false; let beganWarmup!: () => void;
  const warmupBegan = new Promise<void>(resolve => { beganWarmup = resolve; });
  const samples: string[] = []; const unloads: string[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const send = (data: unknown) => res.end(JSON.stringify(data));
    if (!available) { res.writeHead(503); send({ error: 'offline' }); return; }
    if (req.url === '/api/tags') return send({ models: models.map(m => ({ name: m.name, digest: m.digest ?? m.name, size: m.size ?? 1024 })) });
    if (req.url === '/api/version') return send({ version });
    if (req.url === '/api/show') {
      const m = models.find(m => m.name === body.model)!;
      return send({ remote_model: m.cloud ? m.name : undefined, capabilities: m.capabilities ?? ['completion', 'tools'], model_info: { 'general.parameter_count': m.parameters }, parameters: 'num_ctx 8192' });
    }
    if (req.url === '/api/chat') {
      assert.equal(body.think, false); assert.equal(body.stream, false);
      const m = models.find(m => m.name === body.model)!;
      if (body.options.num_predict === 128) samples.push(m.name);
      const count = m.count ?? 128;
      const speed = body.options.num_predict === 128 ? m.speeds?.shift() ?? m.speed : m.speed;
      return send({ done: true, message: { content: 'A sufficiently detailed response.' }, eval_count: count, eval_duration: count / speed * 1e9 });
    }
    if (req.url === '/api/generate') { assert.equal(body.keep_alive, 0); unloads.push(body.model); return send({ done: true }); }
    if (req.url === '/v1/models') return send({ data: models.map(m => ({ id: m.name })) });
    if (req.url === '/v1/chat/completions') {
      assert.equal(body.reasoning_effort, 'none'); beganWarmup();
      if (holdWarmup) return;
      if (models.find(m => m.name === body.model)?.warmupFails) { res.writeHead(503); return send({ error: 'warmup failed' }); }
      return send({ choices: [{ message: { content: 'OK' } }] });
    }
    res.writeHead(404); send({});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const stateDir = await mkdtemp(join(tmpdir(), 'ollama-discovery-'));
  const config = { ...readConfig({}).ollama, url: `http://127.0.0.1:${address.port}`, refreshIntervalMs: 3600000 };
  const controllers: OllamaDiscovery[] = [];
  const controller = (hw = hardware) => {
    const instance = new OllamaDiscovery(config, hw, 'test-node', stateDir, () => busy);
    controllers.push(instance); return instance;
  };
  return { models, config, stateDir, samples, unloads, controller,
    holdWarmup: () => { holdWarmup = true; }, warmupBegan,
    busy: (value: boolean) => { busy = value; }, offline: () => { available = false; }, version: (value: string) => { version = value; },
    close: async () => { await Promise.all(controllers.map(c => c.close())); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await rm(stateDir, { recursive: true, force: true }); },
  };
}

test('selection measures two samples per eligible model and chooses capacity over raw speed', async () => {
  const f = await fixture([
    { name: 'qwen3:32b', parameters: 32e9, speed: 19.9, speeds: [100, 19.9] },
    { name: 'gemma4:27b', parameters: 27e9, speed: 20 },
    { name: 'qwen3:8b', parameters: 8e9, speed: 80 },
    { name: 'muse:30b', parameters: 30e9, speed: 60 },
    { name: 'gemma3:4b', parameters: 4e9, speed: 80 },
  ]);
  try {
    const discovery = f.controller(); await discovery.start();
    assert.equal(discovery.manifest?.modelId, 'gemma4:27b'); assert.ok(discovery.readyProfile());
    assert.equal(discovery.profiles().length, 5);
    assert.equal(discovery.profiles().filter(p => p.state === 'ready').length, 1);
    assert.equal(discovery.profiles().find(p => p.modelId === 'gemma4:27b')?.discovery?.tokensPerSecond, 20);
    assert.match(discovery.profiles()[0]!.discovery!.reason, /Below 20/);
    assert.deepEqual(f.samples, ['qwen3:32b', 'qwen3:32b', 'gemma4:27b', 'gemma4:27b', 'qwen3:8b', 'qwen3:8b']);
    assert.deepEqual(f.unloads, ['qwen3:32b', 'gemma4:27b', 'qwen3:8b']);
  } finally { await f.close(); }
});

test('no ready profile when samples are too slow, short, cloud, unsupported or oversized', async () => {
  const f = await fixture([
    { name: 'qwen3:8b', parameters: 8e9, speed: 19 },
    { name: 'gemma4:4b', parameters: 4e9, speed: 50, count: 2 },
    { name: 'qwen3:cloud', parameters: 100e9, speed: 90, cloud: true },
    { name: 'qwen3:embedding', parameters: 1e9, speed: 90, capabilities: ['embedding'] },
    { name: 'qwen3:100b', parameters: 100e9, speed: 90, size: hardware.memoryBytes },
  ]);
  try {
    const discovery = f.controller(); await discovery.start();
    assert.equal(discovery.readyProfile(), undefined); assert.equal(discovery.manifest, undefined);
    assert.equal(discovery.profiles()[1]!.state, 'failed');
    assert.ok(f.samples.every(name => ['qwen3:8b', 'gemma4:4b'].includes(name)));
  } finally { await f.close(); }
});

test('benchmarks persist, invalidate on digest/version changes, and refresh waits for idle', async () => {
  const f = await fixture([{ name: 'qwen3:8b', parameters: 8e9, speed: 40 }]);
  try {
    const first = f.controller(); await first.start(); assert.equal(f.samples.length, 2); await first.close();
    const next = f.controller(); await next.start(); assert.equal(f.samples.length, 2, 'reuse cached measurements');
    f.models.push({ name: 'gemma4:27b', parameters: 27e9, speed: 25 });
    f.busy(true); await next.refresh(); assert.equal(next.manifest?.modelId, 'qwen3:8b'); assert.equal(f.samples.length, 2);
    f.busy(false); await next.refresh(); assert.equal(next.manifest?.modelId, 'gemma4:27b'); assert.equal(f.samples.length, 4);
    f.models[0]!.digest = 'new-weights'; await next.refresh(); assert.equal(f.samples.length, 6);
    f.version('test-2'); await next.refresh(); assert.equal(f.samples.length, 10, 'runtime version invalidates all measurements');
    f.offline(); await next.refresh(); assert.match(next.status, /unavailable/);
  } finally { await f.close(); }
});

test('operator ranking override never bypasses the minimum speed requirement', async () => {
  const f = await fixture([{ name: 'qwen3:8b', parameters: 8e9, speed: 40 }, { name: 'gemma4:27b', parameters: 27e9, speed: 25 }]);
  f.config.modelPriority = ['qwen3:8b'];
  try { const discovery = f.controller(); await discovery.start(); assert.equal(discovery.manifest?.modelId, 'qwen3:8b'); }
  finally { await f.close(); }
});

test('an incompatible winning endpoint falls back to the next passing model', async () => {
  const f = await fixture([{ name: 'qwen3:32b', parameters: 32e9, speed: 40, warmupFails: true }, { name: 'gemma4:27b', parameters: 27e9, speed: 25 }]);
  try {
    const discovery = f.controller(); await discovery.start(); assert.equal(discovery.manifest?.modelId, 'gemma4:27b');
    assert.match(discovery.profiles()[0]!.discovery!.reason, /failed warmup/);
  } finally { await f.close(); }
});

test('node startup advertises discovered profiles', async () => {
  const f = await fixture([{ name: 'qwen3:8b', parameters: 8e9, speed: 40 }]);
  const config = readConfig({ NODE_STATE_DIR: join(f.stateDir, 'node') }); config.port = 0; config.ollama = f.config;
  const node = await startNode(config);
  try {
    await node.started;
    const address = node.server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/node/status`).then(r => r.json());
    assert.equal(response.profiles[0].modelId, 'qwen3:8b'); assert.equal(response.profiles[0].state, 'ready');
    assert.equal(response.profiles[0].discovery.selected, true); assert.match(response.modelDiscovery, /Selected/);
    assert.equal(response.executionReady, false, 'an unenrolled node cannot execute');
  } finally { await node.close(); await f.close(); }
});

test('an explicit runtime manifest takes precedence over automatic discovery', async () => {
  const f = await fixture([{ name: 'qwen3:8b', parameters: 8e9, speed: 40 }]);
  const path = join(f.stateDir, 'explicit.json');
  await writeFile(path, JSON.stringify({ kind: 'external', profileId: 'operator', modelId: 'qwen3:8b', endpoint: `${f.config.url}/v1`, ollama: true }));
  const config = readConfig({ NODE_STATE_DIR: join(f.stateDir, 'node'), RUNTIME_CONFIG: path }); config.port = 0; config.ollama = f.config;
  const node = await startNode(config);
  try {
    await node.started; assert.equal(node.discovery, undefined); assert.equal(node.runtime?.profile().state, 'ready');
    assert.equal(node.runtime?.profile().id, 'operator'); assert.equal(f.samples.length, 0);
  } finally { await node.close(); await f.close(); }
});

test('shutdown aborts an in-flight benchmark without advertising readiness', async () => {
  const f = await fixture([{ name: 'qwen3:8b', parameters: 8e9, speed: 40 }]);
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    if (!String(input).endsWith('/api/chat')) return fetch(input, init);
    began();
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const discovery = new OllamaDiscovery(f.config, hardware, 'test-node', f.stateDir, () => false, fetcher);
  try {
    const pending = discovery.start(); await started;
    assert.equal(discovery.readyProfile(), undefined);
    await discovery.close(); await pending;
    assert.equal(discovery.readyProfile(), undefined); assert.equal(discovery.manifest, undefined);
  } finally { await discovery.close(); await f.close(); }
});

test('shutdown also cancels a selected runtime warmup', { timeout: 3000 }, async () => {
  const f = await fixture([{ name: 'qwen3:8b', parameters: 8e9, speed: 40 }]);
  f.holdWarmup();
  const discovery = f.controller();
  try {
    const pending = discovery.start(); await f.warmupBegan;
    await discovery.close(); await pending;
    assert.equal(discovery.readyProfile(), undefined);
  } finally { await f.close(); }
});

test('metadata identification and speed measurement reject fabricated eligibility', () => {
  assert.equal(parameterCount({ model_info: { 'general.parameter_count': 12345 } }, 'unknown'), 12345);
  assert.equal(parameterCount({}, 'qwen3.8:27b-mlx'), 27e9);
  assert.equal(parameterCount({ details: { parameter_size: '1.5B' } }, 'unknown'), 1.5e9);
  assert.equal(supportedFamily('alias', { details: { family: 'gemma4' } }), true);
  assert.equal(supportedFamily('gemma3:4b', {}), false);
  for (const value of [{}, { done: true, eval_count: 128, eval_duration: 0 }, { done: true, eval_count: 128, eval_duration: 1e9 }]) assert.throws(() => measuredSpeed(value), /Insufficient/);
});
