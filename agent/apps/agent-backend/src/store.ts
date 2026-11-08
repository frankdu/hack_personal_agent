import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  canonicalJson, PROTOCOL_VERSION, executionRequestSchema, fleetNodeSchema,
  type Registration, type Heartbeat, type Lease, type FleetNode, type Conversation,
  type Message, type Task, type Decision, type SubmitMessage, type ExecutionRequest,
  type ExecutionSnapshot, type ConversationEvent,
} from '@agent/contracts';
import type { Config } from './config.js';
import { origin } from './config.js';
import { ApiError, missing } from './errors.js';
import { migration } from './migrations.js';
import { eligibleCandidates, selectCandidate } from './routing.js';

type Db = Pool | PoolClient;
export interface PendingAttempt {
  id: string; task_id: string; endpoint: string; request: ExecutionRequest; sent_at: Date | null;
  cancel_requested: boolean; body: Task; last_sequence: string; last_contact: Date | null; uncertain_since: Date | null;
}
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export class Store {
  readonly pool: Pool;
  constructor(readonly config: Config) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15_000 });
    this.pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
  }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async migrate(): Promise<void> {
    await this.transaction(async db => { await db.query('SELECT pg_advisory_xact_lock(87003100)'); await db.query(migration); });
  }
  async event(db: Db, conversationId: string, taskId: string | null, type: ConversationEvent['type'], data: unknown): Promise<void> {
    await db.query('INSERT INTO execution_events(conversation_id,task_id,type,data) VALUES($1,$2,$3,$4)', [conversationId, taskId, type, JSON.stringify(data)]);
  }
  async register(input: Registration): Promise<Lease> {
    let endpoint: string;
    try { endpoint = origin(input.endpoint); } catch { throw new ApiError(400, 'INVALID_ENDPOINT', 'Node endpoint must be an HTTP(S) origin.'); }
    if (!this.config.nodeOrigins.has(endpoint)) throw new ApiError(403, 'ENDPOINT_NOT_ALLOWED', 'Node endpoint is not enrolled in NODE_ENDPOINT_ALLOWLIST.');
    return this.transaction(async db => {
      // Serialize even first-time concurrent enrollment of the same stable identity.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.nodeId]);
      const current = (await db.query('SELECT * FROM nodes WHERE id=$1 FOR UPDATE', [input.nodeId])).rows[0];
      const now = new Date(); const expiresAt = new Date(now.getTime() + this.config.leaseMs).toISOString();
      const retired: string[] = current?.retired_boot_ids ?? [];
      if (retired.includes(input.bootId)) throw new ApiError(409, 'STALE_BOOT', 'This boot generation has already been replaced.');
      const sameBoot = current?.boot_id === input.bootId; const generation = sameBoot ? current.generation : randomUUID();
      if (current && !sameBoot) retired.push(current.boot_id);
      await db.query(`INSERT INTO nodes(id,boot_id,generation,registration,retired_boot_ids,last_seen,lease_expires)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET boot_id=$2,generation=$3,registration=$4,
        retired_boot_ids=$5,last_seen=$6,lease_expires=$7,heartbeat_sequence=CASE WHEN nodes.boot_id=$2 THEN nodes.heartbeat_sequence ELSE -1 END,
        active_attempts=CASE WHEN nodes.boot_id=$2 THEN nodes.active_attempts ELSE '[]'::jsonb END,
        draining=CASE WHEN nodes.boot_id=$2 THEN nodes.draining ELSE false END`,
      [input.nodeId, input.bootId, generation, JSON.stringify({ ...input, endpoint }), JSON.stringify(retired), now, expiresAt]);
      return { nodeId: input.nodeId, bootId: input.bootId, generation, expiresAt, heartbeatIntervalMs: this.config.heartbeatMs };
    });
  }
  async heartbeat(nodeId: string, input: Heartbeat): Promise<Lease> {
    return this.transaction(async db => {
      const current = (await db.query('SELECT * FROM nodes WHERE id=$1 FOR UPDATE', [nodeId])).rows[0];
      if (!current) throw missing();
      if (current.boot_id !== input.bootId || current.generation !== input.generation) throw new ApiError(409, 'STALE_FENCE', 'Node generation is no longer current.');
      if (input.sequence <= Number(current.heartbeat_sequence)) throw new ApiError(409, 'STALE_HEARTBEAT', 'Heartbeat sequence must increase.');
      const now = new Date(); const expiresAt = new Date(now.getTime() + this.config.leaseMs).toISOString();
      const reg: Registration = current.registration;
      reg.profiles = input.profiles; reg.hardware.availableMemoryBytes = input.availableMemoryBytes;
      await db.query('UPDATE nodes SET registration=$2,heartbeat_sequence=$3,last_seen=$4,lease_expires=$5,draining=$6,active_attempts=$7 WHERE id=$1',
        [nodeId, JSON.stringify(reg), input.sequence, now, expiresAt, input.draining, JSON.stringify(input.activeAttempts)]);
      return { nodeId, bootId: input.bootId, generation: input.generation, expiresAt, heartbeatIntervalMs: this.config.heartbeatMs };
    });
  }
  async nodes(db: Db = this.pool): Promise<Array<{ node: FleetNode; reserved: number }>> {
    const result = await db.query(`SELECT n.*, (SELECT count(*) FROM execution_attempts a JOIN tasks t ON t.id=a.task_id
      WHERE a.node_id=n.id AND t.body->>'status' IN ('queued','running','unknown')) AS reserved FROM nodes n ORDER BY n.id`);
    return result.rows.map(row => {
      const { endpoint: _, ...registration } = row.registration as Registration;
      const node = fleetNodeSchema.parse({ ...registration, status: row.lease_expires.getTime() <= Date.now() ? 'offline' : row.draining ? 'draining' : 'online',
        lastSeenAt: row.last_seen.toISOString(), leaseExpiresAt: row.lease_expires.toISOString(), activeAttempts: row.active_attempts });
      return { node, reserved: Number(row.reserved) };
    });
  }
  async createConversation(): Promise<Conversation> {
    const body: Conversation = { id: randomUUID(), revision: 0, messages: [], activeTaskId: null };
    await this.pool.query('INSERT INTO conversations(id,body) VALUES($1,$2)', [body.id, JSON.stringify(body)]); return body;
  }
  async conversation(id: string, db: Db = this.pool, lock = false): Promise<Conversation> {
    const row = (await db.query(`SELECT body FROM conversations WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row) throw missing(); return row.body as Conversation;
  }
  async task(id: string, db: Db = this.pool): Promise<Task> {
    const row = (await db.query('SELECT body FROM tasks WHERE id=$1', [id])).rows[0];
    if (!row) throw missing(); return row.body as Task;
  }
  async decisions(taskId: string): Promise<Decision[]> {
    await this.task(taskId); return (await this.pool.query('SELECT body FROM routing_decisions WHERE task_id=$1', [taskId])).rows.map(r => r.body as Decision);
  }
  async submit(conversationId: string, key: string, input: SubmitMessage): Promise<{ task: Task; revision: number }> {
    const inputHash = digest(input);
    // Bounded judgment under this row lock serializes conversation submission and idempotent replay.
    // No node execution/network dispatch occurs in the transaction.
    return this.transaction(async db => {
      const conversation = await this.conversation(conversationId, db, true);
      const duplicate = (await db.query('SELECT body,input_hash,accepted_revision FROM tasks WHERE conversation_id=$1 AND request_key=$2', [conversationId, key])).rows[0];
      if (duplicate) {
        if (duplicate.input_hash !== inputHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different input.');
        return { task: duplicate.body as Task, revision: duplicate.accepted_revision as number };
      }
      if (conversation.revision !== input.expectedRevision || conversation.activeTaskId) throw new ApiError(409, 'CONVERSATION_CONFLICT', 'Conversation changed or still has an active or unresolved task.');
      if (conversation.messages.length >= 100) throw new ApiError(409, 'CONTEXT_LIMIT', 'This conversation reached the initial implementation history limit. Start a new conversation.');
      const nodes = await this.nodes(db);
      const contextCharacters = input.text.length + conversation.messages.reduce((n, m) => n + m.text.length, 0);
      const candidates = eligibleCandidates(nodes, input, contextCharacters);
      const selection = await selectCandidate(candidates, input, this.config);
      const chosen = selection.candidate;
      const nodeRow = (await db.query('SELECT * FROM nodes WHERE id=$1 FOR UPDATE', [chosen.node.nodeId])).rows[0];
      // Re-read availability/capacity while holding the placement lock after a potentially slow provider call.
      const refreshed = (await this.nodes(db)).find(n => n.node.nodeId === chosen.node.nodeId);
      if (!refreshed || !eligibleCandidates([refreshed], input, contextCharacters).some(c => c.profile.id === chosen.profile.id)) throw new ApiError(409, 'CAPACITY_CHANGED', 'Selected node became unavailable; retry with the same request key.');
      const now = new Date().toISOString(); const taskId = randomUUID(); const attemptId = randomUUID();
      const decision: Decision = { id: randomUUID(), taskId, nodeId: chosen.node.nodeId, profileId: chosen.profile.id,
        provider: selection.provider, modelRevision: selection.modelRevision, promptRevision: 'placement-v1',
        reasonCode: selection.reasonCode, reason: selection.reason, candidateNodeIds: [...new Set(candidates.map(c => c.node.nodeId))], latencyMs: selection.latencyMs, createdAt: now };
      const task: Task = { id: taskId, conversationId, attemptId, decision, status: 'queued', output: '', error: null, createdAt: now };
      const message: Message = { id: randomUUID(), role: 'user', text: input.text, createdAt: now, taskId };
      conversation.messages.push(message); conversation.revision++; conversation.activeTaskId = taskId;
      const payload = { protocolVersion: PROTOCOL_VERSION, attemptId, taskId, conversationId, nodeId: chosen.node.nodeId,
        bootId: nodeRow.boot_id as string, generation: nodeRow.generation as string, deadline: new Date(Date.now() + this.config.executionTimeoutMs).toISOString(),
        profileId: chosen.profile.id, workspaceId: input.policy.workspaceId, allowedTools: input.policy.allowedTools,
        messages: conversation.messages.map(m => ({ role: m.role, text: m.text })) };
      const execution = executionRequestSchema.parse({ ...payload, inputDigest: digest(payload) });
      await db.query('UPDATE conversations SET body=$2 WHERE id=$1', [conversationId, JSON.stringify(conversation)]);
      await db.query('INSERT INTO tasks(id,conversation_id,request_key,input_hash,body,accepted_revision) VALUES($1,$2,$3,$4,$5,$6)', [taskId, conversationId, key, inputHash, JSON.stringify(task), conversation.revision]);
      await db.query('INSERT INTO routing_decisions(id,task_id,body,evidence) VALUES($1,$2,$3,$4)', [decision.id, taskId, JSON.stringify(decision), JSON.stringify(selection.evidence)]);
      await db.query('INSERT INTO execution_attempts(id,task_id,decision_id,node_id,endpoint,request) VALUES($1,$2,$3,$4,$5,$6)', [attemptId, taskId, decision.id, chosen.node.nodeId, nodeRow.registration.endpoint, JSON.stringify(execution)]);
      await db.query('INSERT INTO dispatch_outbox(attempt_id) VALUES($1)', [attemptId]);
      await this.event(db, conversationId, taskId, 'message', message);
      await this.event(db, conversationId, taskId, 'decision', decision);
      await this.event(db, conversationId, taskId, 'task', task);
      return { task, revision: conversation.revision };
    });
  }
  async cancel(taskId: string): Promise<Task> {
    const task = await this.task(taskId);
    if (['queued', 'running', 'unknown'].includes(task.status)) await this.pool.query('UPDATE tasks SET cancel_requested=true WHERE id=$1', [taskId]);
    return task;
  }
  async events(conversationId: string, after: number): Promise<ConversationEvent[]> {
    const result = await this.pool.query('SELECT * FROM execution_events WHERE conversation_id=$1 AND id>$2 ORDER BY id LIMIT 200', [conversationId, after]);
    return result.rows.map(r => ({ id: Number(r.id), conversationId, taskId: r.task_id, type: r.type, data: r.data, createdAt: r.created_at.toISOString() } as ConversationEvent));
  }
  async pending(): Promise<PendingAttempt[]> {
    return (await this.pool.query(`SELECT a.*,t.cancel_requested,t.body FROM dispatch_outbox o JOIN execution_attempts a ON a.id=o.attempt_id
      JOIN tasks t ON t.id=a.task_id WHERE NOT o.completed ORDER BY o.created_at LIMIT 50`)).rows as PendingAttempt[];
  }
  async markSent(id: string): Promise<void> { await this.pool.query('UPDATE execution_attempts SET sent_at=COALESCE(sent_at,now()) WHERE id=$1', [id]); }
  async currentLease(request: ExecutionRequest): Promise<boolean> {
    const row = (await this.pool.query('SELECT 1 FROM nodes WHERE id=$1 AND boot_id=$2 AND generation=$3 AND lease_expires>now() AND NOT draining', [request.nodeId, request.bootId, request.generation])).rows[0]; return !!row;
  }
  async applySnapshot(attempt: PendingAttempt, snapshot: ExecutionSnapshot, local = false): Promise<void> {
    if (snapshot.attemptId !== attempt.id || snapshot.inputDigest !== attempt.request.inputDigest) throw new Error('Execution identity mismatch.');
    await this.transaction(async db => {
      const conversation = await this.conversation(attempt.body.conversationId, db, true);
      const row = (await db.query('SELECT a.last_sequence,t.body FROM execution_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1 FOR UPDATE OF a,t', [attempt.id])).rows[0];
      const task = row.body as Task;
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return;
      if (!local && snapshot.sequence < Number(row.last_sequence)) return;
      if (!local) await db.query('UPDATE execution_attempts SET last_sequence=$2,last_contact=now(),uncertain_since=NULL WHERE id=$1', [attempt.id, snapshot.sequence]);
      if (task.status === snapshot.status && task.output === snapshot.output && task.error === snapshot.error) return;
      task.status = snapshot.status; task.output = snapshot.output; task.error = snapshot.error;
      await db.query('UPDATE tasks SET body=$2 WHERE id=$1', [task.id, JSON.stringify(task)]);
      await this.event(db, task.conversationId, task.id, 'task', task);
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
        conversation.activeTaskId = null; conversation.revision++;
        if (task.output) {
          const message: Message = { id: randomUUID(), role: 'assistant', text: task.output, createdAt: new Date().toISOString(), taskId: task.id };
          conversation.messages.push(message); await this.event(db, task.conversationId, task.id, 'message', message);
        }
        await db.query('UPDATE conversations SET body=$2 WHERE id=$1', [conversation.id, JSON.stringify(conversation)]);
        await db.query('UPDATE dispatch_outbox SET completed=true WHERE attempt_id=$1', [attempt.id]);
      }
      // unknown intentionally keeps activeTaskId and the outbox for reconciliation.
    });
  }
  async localOutcome(attempt: PendingAttempt, status: 'unknown' | 'failed' | 'cancelled', error: string): Promise<void> {
    await this.applySnapshot(attempt, { attemptId: attempt.id, inputDigest: attempt.request.inputDigest, sequence: Math.max(0, Number(attempt.last_sequence)), status, output: attempt.body.output, error, updatedAt: new Date().toISOString() }, true);
  }
}
