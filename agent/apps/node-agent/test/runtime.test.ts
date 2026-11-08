import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseRuntimeManifest, dockerRunArgs, DockerContainerRuntime } from '../src/runtime.js';
import { assertWorkspacePath } from '../src/pi-session.js';
const external = { kind: 'external', profileId: 'gemma', modelId: 'gemma-4', endpoint: 'http://127.0.0.1:8080/v1' };
test('runtime endpoints and provisioning require explicit local immutable configuration', () => {
  assert.equal(parseRuntimeManifest(external).kind, 'external');
  assert.throws(() => parseRuntimeManifest({ ...external, endpoint: 'https://hosted.example/v1' }), /loopback/);
  assert.throws(() => parseRuntimeManifest({ ...external, kind: 'docker', requiredMemoryBytes: 100, docker: { image: 'untrusted:latest', artifactPath: '/models/model', artifactSha256: 'a'.repeat(64) } }), /pinned/);
});
test('Docker args pin image, loopback publication and bounded owned container; no pull or privileged mode', () => {
  const m = parseRuntimeManifest({ ...external, kind: 'docker', requiredMemoryBytes: 100, docker: { image: `local/llama@sha256:${'a'.repeat(64)}`, artifactPath: '/models/gemma.gguf', artifactSha256: 'b'.repeat(64), modelMountPath: '/model.gguf', command: ['--model', '/model.gguf'], gpus: 'device=0' } });
  const args = dockerRunArgs(m, 'node-id', 'digest');
  assert.ok(args.includes('--pull=never')); assert.ok(args.includes('127.0.0.1:8080:8080')); assert.ok(args.includes('curilo_agent-node-id-gemma')); assert.ok(!args.includes('--privileged')); assert.ok(!args.includes('/var/run/docker.sock'));
});
test('Docker refuses adoption of a container without matching ownership labels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-owned-')); const artifact = join(dir, 'model'); await writeFile(artifact, 'model');
  const m = parseRuntimeManifest({ ...external, kind: 'docker', requiredMemoryBytes: 100, docker: { image: `local/llama@sha256:${'a'.repeat(64)}`, artifactPath: artifact, artifactSha256: createHash('sha256').update('model').digest('hex'), modelMountPath: '/model' } });
  const calls: string[][] = [];
  const runtime = new DockerContainerRuntime(m, 'node', dir, async (_file, args) => { calls.push(args); return args[0] === 'ps' ? 'a'.repeat(64) : JSON.stringify([{ Config: { Labels: {} } }]); });
  try { await assert.rejects(runtime.start(), /ownership/); assert.ok(!calls.some(args => ['stop', 'rm', 'run'].includes(args[0]!))); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('tool path guard rejects parent traversal and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-')); const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  try { await symlink(outside, join(root, 'escape')); await assertWorkspacePath(root, 'new/nested/file'); await assert.rejects(assertWorkspacePath(root, '../outside'), /outside/); await assert.rejects(assertWorkspacePath(root, 'escape/new-file'), /outside/); }
  finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
