import { freemem } from 'node:os';
import { PROTOCOL_VERSION, leaseSchema, type Lease, type Registration, type ModelProfile, type Hardware } from '@agent/contracts';
import type { NodeConfig } from './config.js';

export class Enrollment {
  private lease?: Lease;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private sequence = 0;
  private failures = 0;
  private draining = false;
  onLeaseLost: () => void = () => {};
  constructor(private readonly config: NodeConfig, readonly nodeId: string, readonly bootId: string, private readonly hardware: Hardware, private readonly profiles: () => ModelProfile[], private readonly active: () => string[]) {}
  current() { return this.lease && Date.parse(this.lease.expiresAt) > Date.now() ? this.lease : undefined; }
  async start() { if (this.config.backendUrl) await this.tick(); }
  private async request(path: string, body: unknown) {
    const response = await fetch(`${this.config.backendUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.sharedToken}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error(`enrollment_${response.status}`);
    const lease = leaseSchema.parse(await response.json());
    if (lease.nodeId !== this.nodeId || lease.bootId !== this.bootId || Date.parse(lease.expiresAt) <= Date.now()) throw new Error('Invalid lease identity or expiry');
    return lease;
  }
  private async tick() {
    if (this.stopped) return;
    try {
      if (!this.lease) {
        const registration: Registration = { protocolVersion: PROTOCOL_VERSION, nodeId: this.nodeId, bootId: this.bootId, name: this.config.name, endpoint: this.config.endpoint, hardware: this.hardware, enabledTools: this.config.enabledTools, workspaceIds: [this.config.workspaceId], profiles: this.profiles() };
        this.lease = await this.request('/v1/nodes/register', registration); this.sequence = 0;
      } else {
        const lease = await this.request(`/v1/nodes/${this.nodeId}/heartbeats`, { protocolVersion: PROTOCOL_VERSION, bootId: this.bootId, generation: this.lease.generation, sequence: this.sequence++, draining: this.draining, activeAttempts: this.active(), profiles: this.profiles(), availableMemoryBytes: Math.min(freemem(), this.hardware.memoryBytes) });
        if (lease.generation !== this.lease.generation) { this.onLeaseLost(); throw new Error('Backend changed generation unexpectedly'); }
        this.lease = lease;
      }
      this.failures = 0;
    } catch {
      this.failures++;
      if (!this.current()) this.onLeaseLost();
      // A fenced boot cannot self-register and steal ownership from a new process.
      // Re-enrollment after a backend restart requires an operator process restart.
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), this.failures ? Math.min(1000 * 2 ** Math.min(this.failures, 5), 30000) : Math.max(250, this.lease?.heartbeatIntervalMs ?? 5000));
  }
  async close() { this.draining = true; clearTimeout(this.timer); if (this.lease && this.config.backendUrl) await this.tick(); this.stopped = true; clearTimeout(this.timer); }
}
