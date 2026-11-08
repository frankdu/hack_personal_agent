import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, executionRequestSchema, registrationSchema, submitMessageSchema } from '../src/index.js';

const uuid = 'b29ff712-41d7-4289-8774-dc7e8f15a35a';
test('registration fixture round-trips; protocol mismatches and secret fields fail closed', () => {
  const fixture = {
    protocolVersion: '1', nodeId: uuid, bootId: uuid, name: 'Mac', endpoint: 'http://127.0.0.1:3101',
    hardware: { platform: 'darwin', arch: 'arm64', cpuModel: 'Apple', cpuCores: 8, memoryBytes: 16e9, availableMemoryBytes: 8e9, unifiedMemory: true, gpus: [{ name: 'Apple', vendor: 'apple', memoryBytes: null }], docker: { available: false, scope: 'unknown' } },
    enabledTools: ['read'], workspaceIds: ['default'], profiles: [{ id: 'gemma', modelId: 'gemma-4-e2b', runtime: 'native', state: 'ready', contextWindow: 8192, concurrency: 1 }],
  };
  assert.deepEqual(registrationSchema.parse(JSON.parse(JSON.stringify(fixture))), fixture);
  assert.equal(registrationSchema.safeParse({ ...fixture, protocolVersion: '2' }).success, false);
  assert.equal(registrationSchema.safeParse({ ...fixture, token: 'do-not-forward' }).success, false);
});
test('tools default empty, unknown tools rejected, manual routing requires a target', () => {
  const input = { protocolVersion: '1', text: 'hello', expectedRevision: 0 };
  assert.deepEqual(submitMessageSchema.parse(input).policy.allowedTools, []);
  assert.equal(submitMessageSchema.safeParse({ ...input, policy: { allowedTools: ['sudo'] } }).success, false);
  assert.equal(submitMessageSchema.safeParse({ ...input, routing: { mode: 'manual' } }).success, false);
});
test('canonical request digest ignores object insertion order but retains array order', () => {
  assert.equal(canonicalJson({ b: 2, a: { y: 1, x: 2 } }), canonicalJson({ a: { x: 2, y: 1 }, b: 2 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});
test('execution fixture preserves scope and rejects malformed digest', () => {
  const fixture = { protocolVersion: '1', attemptId: uuid, taskId: uuid, conversationId: uuid, nodeId: uuid, bootId: uuid, generation: uuid, deadline: '2026-11-08T12:00:00.000Z', profileId: 'gemma', workspaceId: 'default', allowedTools: [], messages: [{ role: 'user', text: 'hi' }], inputDigest: 'a'.repeat(64) };
  assert.deepEqual(executionRequestSchema.parse(fixture), fixture);
  assert.equal(executionRequestSchema.safeParse({ ...fixture, inputDigest: 'hash' }).success, false);
});
