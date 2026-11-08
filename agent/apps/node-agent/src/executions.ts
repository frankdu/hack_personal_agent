import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, executionRequestSchema, executionSnapshotSchema, type ExecutionRequest, type ExecutionSnapshot, type Lease } from '@agent/contracts';
import { durableWrite, readJson, Serial } from './storage.js';
import type { NodeConfig } from './config.js';

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}
export interface RunHooks {
  output(text: string): Promise<void>;
  tool(id: string, name: string, input: unknown, execute: () => Promise<unknown>): Promise<unknown>;
}
export interface Executor { run(request: ExecutionRequest, hooks: RunHooks, signal: AbortSignal): Promise<string>; }
interface ToolRecord { name: string; digest: string; status: 'running' | 'succeeded' | 'failed' | 'unknown'; }
interface JournalRecord { request: ExecutionRequest; snapshot: ExecutionSnapshot; tools: Record<string, ToolRecord>; }
const terminal = (status: ExecutionSnapshot['status']) => !['queued', 'running'].includes(status);
export class Executions {
  private readonly records = new Map<string, JournalRecord>();
  private readonly serial = new Serial();
  private active?: { id: string; controller: AbortController; done: Promise<void>; reason?: 'cancelled' | 'deadline' | 'lease_lost' | 'runtime_unavailable' | 'shutdown' | 'side_effect_unknown' };
  private draining = false;
  constructor(private readonly config: NodeConfig, readonly nodeId: string, readonly bootId: string, private readonly getLease: () => Lease | undefined, private readonly getReadyProfile: () => string | undefined, private readonly executor: Executor) {}
  private path(id: string) { return join(this.config.stateDir, 'executions', `${id}.json`); }
  private async save(record: JournalRecord) { await durableWrite(this.path(record.request.attemptId), record); }
  async initialize() {
    let entries: string[];
    try { entries = await readdir(join(this.config.stateDir, 'executions')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const record = await readJson(join(this.config.stateDir, 'executions', entry)) as JournalRecord;
      executionRequestSchema.parse(record.request); executionSnapshotSchema.parse(record.snapshot);
      if (!terminal(record.snapshot.status)) {
        record.snapshot = { ...record.snapshot, status: 'unknown', error: 'node_restarted_during_execution', sequence: record.snapshot.sequence + 1, updatedAt: new Date().toISOString() };
        for (const tool of Object.values(record.tools)) if (tool.status === 'running') tool.status = 'unknown';
        await this.save(record);
      }
      this.records.set(record.request.attemptId, record);
    }
  }
  usableLease() {
    const lease = this.getLease();
    return lease && lease.nodeId === this.nodeId && lease.bootId === this.bootId && Date.parse(lease.expiresAt) > Date.now() ? lease : undefined;
  }
  ready() { return !this.draining && !this.active && Boolean(this.usableLease()) && Boolean(this.getReadyProfile()) && ![...this.records.values()].some(record => record.snapshot.status === 'unknown'); }
  activeIds() { return [...new Set([...(this.active ? [this.active.id] : []), ...[...this.records.values()].filter(record => record.snapshot.status === 'unknown').map(record => record.request.attemptId)])]; }
  private validate(request: ExecutionRequest) {
    const lease = this.usableLease();
    if (!lease || request.nodeId !== this.nodeId || request.bootId !== this.bootId || request.generation !== lease.generation) throw new RequestError(409, 'stale_lease');
    if (Date.parse(request.deadline) <= Date.now()) throw new RequestError(410, 'deadline_expired');
    if (Date.parse(request.deadline) - Date.now() > 60 * 60 * 1000) throw new RequestError(400, 'deadline_too_distant');
    if (request.workspaceId !== this.config.workspaceId) throw new RequestError(403, 'workspace_not_allowed');
    if (request.allowedTools.some(tool => !this.config.enabledTools.includes(tool))) throw new RequestError(403, 'tool_not_allowed');
    if (request.profileId !== this.getReadyProfile()) throw new RequestError(409, 'profile_not_ready');
    if (request.messages.at(-1)?.role !== 'user') throw new RequestError(400, 'last_message_must_be_user');
  }
  async accept(request: ExecutionRequest): Promise<ExecutionSnapshot> {
    return this.serial.run(async () => {
      const { inputDigest, ...payload } = request;
      if (createHash('sha256').update(canonicalJson(payload)).digest('hex') !== inputDigest) throw new RequestError(400, 'invalid_input_digest');
      const existing = this.records.get(request.attemptId);
      if (existing) {
        if (existing.request.inputDigest !== inputDigest) throw new RequestError(409, 'attempt_digest_mismatch');
        return { ...existing.snapshot };
      }
      this.validate(request);
      if (!this.ready()) throw new RequestError(409, this.draining ? 'draining' : 'capacity_unavailable');
      const snapshot: ExecutionSnapshot = { attemptId: request.attemptId, inputDigest, status: 'queued', output: '', error: null, sequence: 0, updatedAt: new Date().toISOString() };
      const record: JournalRecord = { request, snapshot, tools: {} };
      await this.save(record); // Before acceptance, and before executor can make a side effect.
      this.records.set(request.attemptId, record);
      let begin!: () => void;
      const gate = new Promise<void>(resolve => { begin = resolve; });
      const controller = new AbortController();
      const done = gate.then(() => this.execute(record, controller));
      this.active = { id: request.attemptId, controller, done };
      setImmediate(begin);
      return { ...snapshot };
    });
  }
  get(id: string) { const record = this.records.get(id); if (!record) throw new RequestError(404, 'attempt_not_found'); return { ...record.snapshot }; }
  private async update(record: JournalRecord, patch: Partial<ExecutionSnapshot>) {
    return this.serial.run(async () => {
      const next = { ...record.snapshot, ...patch, sequence: record.snapshot.sequence + 1, updatedAt: new Date().toISOString() };
      await this.save({ ...record, snapshot: next }); record.snapshot = next;
    });
  }
  private async execute(record: JournalRecord, controller: AbortController) {
    const deadlineTimer = setTimeout(() => this.abort('deadline'), Math.max(1, Date.parse(record.request.deadline) - Date.now()));
    const leaseTimer = setInterval(() => { if (!this.usableLease() || this.getLease()?.generation !== record.request.generation) this.abort('lease_lost'); }, 250);
    try {
      this.validate(record.request);
      await this.update(record, { status: 'running' });
      const output = await this.executor.run(record.request, {
        output: async text => { if (text.length > 2_000_000) { controller.abort(); throw new Error('Output limit reached'); } await this.update(record, { output: text }); },
        tool: async (id, name, input, run) => {
          this.validate(record.request); controller.signal.throwIfAborted();
          if (!record.request.allowedTools.includes(name as any)) throw new Error('Tool is not authorized');
          const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
          await this.serial.run(async () => {
            if (record.tools[id]) throw new Error('Tool invocation already recorded; reconciliation required');
            record.tools[id] = { name, digest, status: 'running' }; await this.save(record);
          });
          try {
            const result = await run();
            controller.signal.throwIfAborted();
            const toolResult = result as { isError?: boolean; structuredContent?: { exit_code?: number } } | undefined;
            // A completed error result is known, even if the command made changes.
            // Preserve it for the agent; failed does not imply rolled back.
            const failed = toolResult?.isError || (toolResult?.structuredContent?.exit_code !== undefined && toolResult.structuredContent.exit_code !== 0);
            await this.serial.run(async () => { record.tools[id] = { name, digest, status: failed ? 'failed' : 'succeeded' }; await this.save(record); });
            return result;
          } catch (error) {
            const sideEffect = ['bash', 'write', 'edit'].includes(name);
            if (sideEffect) this.abort('side_effect_unknown');
            await this.serial.run(async () => { record.tools[id] = { name, digest, status: sideEffect || controller.signal.aborted ? 'unknown' : 'failed' }; await this.save(record); });
            throw error;
          }
        },
      }, controller.signal);
      if (!this.usableLease() || this.getLease()?.generation !== record.request.generation) this.abort('lease_lost');
      if (controller.signal.aborted) throw new Error('Execution aborted');
      await this.update(record, { status: 'succeeded', output, error: null });
    } catch {
      const reason = this.active?.reason;
      const uncertainTool = Object.values(record.tools).some(tool => ['running', 'unknown'].includes(tool.status));
      const status = uncertainTool || ['lease_lost', 'runtime_unavailable', 'shutdown'].includes(reason ?? '') ? 'unknown' : reason === 'cancelled' ? 'cancelled' : 'failed';
      await this.update(record, { status, error: reason ?? 'execution_failed' }).catch(() => { this.draining = true; });
    } finally {
      clearTimeout(deadlineTimer); clearInterval(leaseTimer);
      if (this.active?.id === record.request.attemptId) this.active = undefined;
    }
  }
  abort(reason: NonNullable<Executions['active']>['reason']) { if (this.active) { this.active.reason ??= reason; this.active.controller.abort(); } }
  async cancel(id: string) {
    const existing = this.get(id);
    if (!terminal(existing.status) && this.active?.id === id) { this.abort('cancelled'); await this.active.done; }
    return this.get(id);
  }
  async close() { this.draining = true; this.abort('shutdown'); await this.active?.done; }
}
