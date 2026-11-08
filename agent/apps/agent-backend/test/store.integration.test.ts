import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { registrationSchema, submitMessageSchema } from '@agent/contracts';
import { readConfig } from '../src/config.js';
import { startBackend } from '../src/server.js';
import { Dispatcher } from '../src/dispatcher.js';
import { digest } from '../src/store.js';

test('PostgreSQL audit, dispatch, leases, idempotency, unknown outcomes and HTTP auth', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const base = process.env.TEST_DATABASE_URL!; const admin = new Pool({ connectionString: base });
  const schema = `backend_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`);
  const config = { ...readConfig({ DATABASE_URL: url.toString(), API_TOKEN: 'integration-user-token-long', NODE_SHARED_TOKEN: 'integration-node-token-long', NODE_ENDPOINT_ALLOWLIST: 'http://127.0.0.1:32001' }), port: 0 };
  let app = await startBackend(config, { dispatch: false });
  const address = app.server.address(); assert(address && typeof address !== 'string'); let http = `http://127.0.0.1:${address.port}`;
  try {
    await t.test('bearer scopes and CORS are enforced', async () => {
      assert.equal((await fetch(`${http}/v1/nodes`)).status, 401);
      assert.equal((await fetch(`${http}/v1/nodes`, { headers: { authorization: `Bearer ${config.nodeToken}` } })).status, 401);
      assert.equal((await fetch(`${http}/v1/nodes`, { headers: { authorization: `Bearer ${config.apiToken}`, origin: 'https://untrusted.invalid' } })).status, 403);
      const cors = await fetch(`${http}/v1/nodes`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
      assert.equal(cors.status, 204); assert.equal(cors.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    });
    const registration = registrationSchema.parse({ protocolVersion: '1', nodeId: randomUUID(), bootId: randomUUID(), name: 'integration', endpoint: 'http://127.0.0.1:32001',
      enabledTools: ['read'], workspaceIds: ['default'], profiles: [{ id: 'gemma', modelId: 'gemma-test', runtime: 'external', state: 'ready', contextWindow: 200000, concurrency: 1 }],
      hardware: { platform: 'linux', arch: 'x64', cpuModel: 'test', cpuCores: 2, memoryBytes: 1000, availableMemoryBytes: 1000, unifiedMemory: false, gpus: [], docker: { available: false, scope: 'unknown' } } });
    const lease = await app.store.register(registration);
    await t.test('registration allowlist, boot fencing and heartbeat order', async () => {
      await assert.rejects(app.store.register({ ...registration, endpoint: 'http://169.254.169.254' }), /not enrolled/);
      assert.equal((await app.store.register(registration)).generation, lease.generation);
      const hb = { protocolVersion: '1' as const, bootId: registration.bootId, generation: lease.generation, sequence: 1, draining: false, activeAttempts: [], profiles: registration.profiles, availableMemoryBytes: 900 };
      await app.store.heartbeat(registration.nodeId, hb);
      await assert.rejects(app.store.heartbeat(registration.nodeId, hb), /must increase/);
      const fleet = (await app.store.nodes())[0]!.node; assert.equal('endpoint' in fleet, false);
    });
    const conversation = await app.store.createConversation();
    const input = submitMessageSchema.parse({ protocolVersion: '1', text: 'Hello', expectedRevision: 0 });
    const first = await app.store.submit(conversation.id, 'request-1', input);
    await t.test('one transaction writes decision, attempt and outbox; replay is idempotent', async () => {
      for (const table of ['tasks', 'routing_decisions', 'execution_attempts', 'dispatch_outbox']) assert.equal(Number((await app.store.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 1);
      assert.equal((await app.store.submit(conversation.id, 'request-1', input)).task.id, first.task.id);
      await assert.rejects(app.store.submit(conversation.id, 'request-1', { ...input, text: 'Different' }), /different input/);
      const attempt = (await app.store.pending())[0]!; const { inputDigest, ...payload } = attempt.request; assert.equal(inputDigest, digest(payload));
    });
    await t.test('dispatch observes committed audit and completed attempt is not dispatched again', async () => {
      let calls = 0;
      const fetcher: typeof fetch = async (_url, init) => {
        calls++; assert.equal(Number((await app.store.pool.query('SELECT count(*) AS n FROM routing_decisions')).rows[0].n), 1);
        const request = JSON.parse(String(init?.body));
        return Response.json({ attemptId: request.attemptId, inputDigest: request.inputDigest, status: 'succeeded', output: 'Hello from the model', error: null, sequence: 1, updatedAt: new Date().toISOString() });
      };
      const dispatcher = new Dispatcher(app.store, fetcher); await dispatcher.sweep(); await dispatcher.sweep();
      assert.equal(calls, 1); assert.equal((await app.store.task(first.task.id)).status, 'succeeded');
      const final = await app.store.conversation(conversation.id); assert.equal(final.activeTaskId, null); assert.equal(final.revision, 2); assert.equal(final.messages[1]!.text, 'Hello from the model');
      const events = await app.store.events(conversation.id, 0); assert(events.length >= 5);
      assert((await app.store.events(conversation.id, events[1]!.id)).every(e => e.id > events[1]!.id));
    });
    await t.test('concurrent conversation revisions accept only one new task', async () => {
      const branch = await app.store.createConversation();
      const results = await Promise.allSettled([
        app.store.submit(branch.id, 'race-a', input), app.store.submit(branch.id, 'race-b', input),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected').length, 1);
      const pending = (await app.store.pending()).find(a => a.body.conversationId === branch.id)!;
      assert(pending); await app.store.localOutcome(pending, 'cancelled', 'Test cancellation before dispatch.');
    });
    await t.test('lost acknowledgement and backend restart reconcile without a second execution', async () => {
      const branch = await app.store.createConversation(); const submitted = await app.store.submit(branch.id, 'lost-ack', input);
      let executed = 0; let polls = 0; let completed: Record<string, unknown> | undefined;
      const node: typeof fetch = async (_url, init) => {
        if (init?.method === 'POST') {
          executed++; const request = JSON.parse(String(init.body));
          completed = { attemptId: request.attemptId, inputDigest: request.inputDigest, status: 'succeeded', output: 'Durable result', error: null, sequence: 2, updatedAt: new Date().toISOString() };
          throw new Error('The node executed, but the acknowledgement was lost.');
        }
        polls++; assert(completed); return Response.json(completed);
      };
      await new Dispatcher(app.store, node).sweep();
      assert.equal((await app.store.task(submitted.task.id)).status, 'unknown');
      await app.close(); app = await startBackend(config, { dispatch: false });
      const newAddress = app.server.address(); assert(newAddress && typeof newAddress !== 'string'); http = `http://127.0.0.1:${newAddress.port}`;
      assert.equal((await app.store.task(submitted.task.id)).status, 'unknown');
      await new Dispatcher(app.store, node).sweep();
      assert.equal(executed, 1); assert.equal(polls, 1);
      assert.equal((await app.store.task(submitted.task.id)).status, 'succeeded');
      assert.equal((await app.store.conversation(branch.id)).activeTaskId, null);
    });
    await t.test('SSE resumes after a durable cursor across backend restart', async () => {
      const events = await app.store.events(conversation.id, 0); const cursor = events[1]!.id;
      const response = await fetch(`${http}/v1/conversations/${conversation.id}/events`, {
        headers: { authorization: `Bearer ${config.apiToken}`, 'last-event-id': String(cursor) }, signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
      const reader = response.body!.getReader(); let wire = '';
      try {
        while (!wire.includes('data: ')) { const part = await reader.read(); if (part.done) break; wire += new TextDecoder().decode(part.value); }
        const ids = [...wire.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
        assert(ids.length > 0); assert(ids.every(id => id > cursor));
      } finally { await reader.cancel(); }
    });
    await t.test('uncertain dispatch holds conversation and never creates a replacement attempt', async () => {
      const second = await app.store.submit(conversation.id, 'request-2', { ...input, expectedRevision: 2 });
      const fail: typeof fetch = async () => { throw new Error('connection lost'); };
      await new Dispatcher(app.store, fail).sweep();
      assert.equal((await app.store.task(second.task.id)).status, 'unknown');
      assert.equal((await app.store.conversation(conversation.id)).activeTaskId, second.task.id);
      await assert.rejects(app.store.submit(conversation.id, 'request-3', { ...input, expectedRevision: 3 }), /unresolved task/);
      assert.equal((await app.store.pending())[0]!.id, second.task.attemptId);
      const replacement = await app.store.register({ ...registration, bootId: randomUUID() });
      assert.notEqual(replacement.generation, lease.generation);
      await assert.rejects(app.store.register(registration), /already been replaced/);
    });
  } finally { await app.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
