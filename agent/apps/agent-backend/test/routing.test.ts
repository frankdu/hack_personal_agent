import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { submitMessageSchema, type FleetNode } from '@agent/contracts';
import { readConfig, origin } from '../src/config.js';
import { eligibleCandidates, selectCandidate } from '../src/routing.js';

const env = { DATABASE_URL: 'postgresql://localhost/test', API_TOKEN: 'test-user-token-long-enough', NODE_SHARED_TOKEN: 'test-node-token-long-enough' };
const config = () => readConfig(env);
function node(): FleetNode {
  return {
    protocolVersion: '1', nodeId: randomUUID(), bootId: randomUUID(), name: 'test', enabledTools: ['read'], workspaceIds: ['default'],
    hardware: { platform: 'linux', arch: 'x64', cpuModel: 'CPU', cpuCores: 4, memoryBytes: 1000, availableMemoryBytes: 500,
      unifiedMemory: false, gpus: [], docker: { available: false, scope: 'unknown' } },
    profiles: [{ id: 'test', modelId: 'gemma-test', runtime: 'external', state: 'ready', contextWindow: 8192, concurrency: 1 }],
    status: 'online', activeAttempts: [], lastSeenAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 20000).toISOString(),
  };
}
const message = () => submitMessageSchema.parse({ protocolVersion: '1', text: 'Explain this function', expectedRevision: 0 });

test('config separates credentials and rejects endpoint paths/credentials', () => {
  assert.throws(() => readConfig({ ...env, NODE_SHARED_TOKEN: env.API_TOKEN }), /must differ/);
  assert.throws(() => readConfig({ ...env, MODE: 'PROD' }), /PROD requires/);
  assert.throws(() => origin('http://user:password@localhost:3101'));
  assert.throws(() => origin('http://localhost:3101/admin'));
  assert.equal(origin('http://localhost:3101/'), 'http://localhost:3101');
});
test('hard eligibility filters tools, offline nodes, workspace, capacity and manual preference', () => {
  const a = node(); const input = message(); const records = [{ node: a, reserved: 0 }];
  assert.equal(eligibleCandidates(records, input).length, 1);
  assert.equal(eligibleCandidates([{ node: { ...a, status: 'offline' }, reserved: 0 }], input).length, 0);
  assert.equal(eligibleCandidates([{ node: a, reserved: 1 }], input).length, 0);
  assert.equal(eligibleCandidates(records, { ...input, policy: { ...input.policy, allowedTools: ['bash'] } }).length, 0);
  assert.equal(eligibleCandidates(records, { ...input, policy: { ...input.policy, workspaceId: 'elsewhere' } }).length, 0);
  assert.equal(eligibleCandidates(records, { ...input, routing: { mode: 'manual', nodeId: randomUUID() } }).length, 0);
});
test('sole candidate and hosted-forbidden routing never call the provider', async () => {
  const input = message(); const records = [node(), node()].map(n => ({ node: n, reserved: 0 }));
  const candidates = eligibleCandidates(records, input); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('unexpected call'); };
  const configured = { ...config(), jevApiKey: 'fake-test-key' };
  assert.equal((await selectCandidate(candidates.slice(0, 1), input, configured, fetcher)).reasonCode, 'SOLE_ELIGIBLE_CANDIDATE');
  assert.equal((await selectCandidate(candidates, { ...input, policy: { ...input.policy, allowHostedJudgment: false } }, configured, fetcher)).reasonCode, 'HOSTED_JUDGMENT_FORBIDDEN');
  assert.equal(calls, 0);
  await assert.rejects(selectCandidate(candidates, { ...input, policy: { ...input.policy, allowHostedJudgment: false, allowRulesFallback: false } }, configured, fetcher), /unavailable/);
});
test('Jev adapter sends typed choices and validates the complete response', async () => {
  const input = message(); const candidates = eligibleCandidates([node(), node()].map(n => ({ node: n, reserved: 0 })), input);
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const payload = JSON.parse(String(init?.body)); assert.equal(payload.questions.placement.type, 'choice');
    assert.equal(payload.state.task, input.text);
    return Response.json({ model: config().jevModel, answers: { placement: { type: 'choice', choice: 'candidate_1', probabilities: { candidate_0: .2, candidate_1: .8 } } } });
  };
  const selected = await selectCandidate(candidates, input, { ...config(), jevApiKey: 'fake' }, fetcher);
  assert.equal(selected.candidate.node.nodeId, candidates[1]!.node.nodeId); assert.equal(selected.provider, 'jev');
  const invalid: typeof fetch = async () => Response.json({ model: 'bad', answers: { placement: { choice: 'arbitrary' } } });
  assert.equal((await selectCandidate(candidates, input, { ...config(), jevApiKey: 'fake' }, invalid)).reasonCode, 'JEV_FAILED_RULES_FALLBACK');
});

test('Jev rejects model revision drift and bounds concurrency without a queue', async () => {
  const input = message(); const candidates = eligibleCandidates([node(), node()].map(n => ({ node: n, reserved: 0 })), input);
  const configured = { ...config(), jevApiKey: 'fake' };
  const wrong: typeof fetch = async () => Response.json({ model: 'changed-version', answers: { placement: { type: 'choice', choice: 'candidate_0', probabilities: { candidate_0: 1, candidate_1: 0 } } } });
  assert.equal((await selectCandidate(candidates, input, configured, wrong)).reasonCode, 'JEV_FAILED_RULES_FALLBACK');
  const releases: Array<() => void> = [];
  const blocked: typeof fetch = async () => {
    await new Promise<void>(resolve => releases.push(resolve));
    return Response.json({ model: configured.jevModel, answers: { placement: { type: 'choice', choice: 'candidate_0', probabilities: { candidate_0: 1, candidate_1: 0 } } } });
  };
  const pending = Array.from({ length: 4 }, () => selectCandidate(candidates, input, configured, blocked));
  assert.equal(releases.length, 4);
  assert.equal((await selectCandidate(candidates, input, configured, blocked)).reasonCode, 'JEV_BUSY_RULES_FALLBACK');
  await assert.rejects(selectCandidate(candidates, { ...input, policy: { ...input.policy, allowRulesFallback: false } }, configured, blocked), /capacity is busy/);
  releases.forEach(release => release()); await Promise.all(pending);
});
