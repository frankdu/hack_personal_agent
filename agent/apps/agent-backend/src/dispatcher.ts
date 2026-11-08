import {
  executionSnapshotSchema,
  type ExecutionSnapshot,
} from "@agent/contracts";
import { Store, type PendingAttempt } from "./store.js";
import { limitedText } from "./http-client.js";

/** A database advisory lock permits only one dispatch/poll sweep across backend processes. */
export class Dispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly store: Store,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  start(): void {
    this.timer = setInterval(() => this.tick(), 500);
    this.timer.unref();
    this.tick();
  }
  private tick(): void {
    if (this.stopping || this.running) return;
    this.running = this.sweep()
      .catch(() => {
        console.error(JSON.stringify({ event: "dispatch_sweep_failed" }));
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }
  async sweep(): Promise<void> {
    const lock = await this.store.pool.connect();
    let acquired = false;
    try {
      acquired = (
        await lock.query(
          "SELECT pg_try_advisory_lock(hashtext(current_database() || ':' || current_schema() || ':agent-dispatch')) AS locked",
        )
      ).rows[0].locked;
      if (!acquired) return;
      const attempts = await this.store.pending();
      // Bounded concurrency avoids one sleeping machine blocking the whole fleet.
      for (let i = 0; i < attempts.length && !this.stopping; i += 4)
        await Promise.all(attempts.slice(i, i + 4).map((a) => this.process(a)));
    } finally {
      if (acquired)
        await lock.query(
          "SELECT pg_advisory_unlock(hashtext(current_database() || ':' || current_schema() || ':agent-dispatch'))",
        );
      lock.release();
    }
  }
  private async request(
    attempt: PendingAttempt,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; snapshot?: ExecutionSnapshot }> {
    const response = await this.fetcher(`${attempt.endpoint}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.store.config.nodeToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status };
    }
    const text = await limitedText(response, 2_000_000);
    return {
      status: response.status,
      snapshot: executionSnapshotSchema.parse(JSON.parse(text)),
    };
  }
  private async process(attempt: PendingAttempt): Promise<void> {
    try {
      if (!this.store.config.nodeOrigins.has(attempt.endpoint)) {
        await this.store.localOutcome(
          attempt,
          attempt.sent_at ? "unknown" : "failed",
          "The enrolled endpoint is no longer allowed.",
        );
        return;
      }
      if (!attempt.sent_at) {
        if (attempt.cancel_requested) {
          await this.store.localOutcome(
            attempt,
            "cancelled",
            "Cancelled before dispatch.",
          );
          return;
        }
        if (
          Date.parse(attempt.request.deadline) <= Date.now() ||
          !(await this.store.currentLease(attempt.request))
        ) {
          await this.store.localOutcome(
            attempt,
            "failed",
            "Execution lease or deadline expired before dispatch.",
          );
          return;
        }
        // Persist intent before network I/O; restart first reconciles the same attempt ID.
        await this.store.markSent(attempt.id);
        const result = await this.request(
          attempt,
          "/v1/executions",
          "POST",
          attempt.request,
        );
        if (result.snapshot)
          await this.store.applySnapshot(attempt, result.snapshot);
        else
          await this.store.localOutcome(
            attempt,
            "unknown",
            "Dispatch did not return a valid acknowledgement; reconciling the same attempt.",
          );
        return;
      }
      const expired = Date.parse(attempt.request.deadline) <= Date.now();
      const path = `/v1/executions/${attempt.id}`;
      const result = await this.request(
        attempt,
        `${path}${attempt.cancel_requested || expired ? "/cancel" : ""}`,
        attempt.cancel_requested || expired ? "POST" : "GET",
      );
      if (result.snapshot) {
        await this.store.applySnapshot(attempt, result.snapshot);
        return;
      }
      // Only replay the identical durable ID while the original boot/generation is current.
      // A replacement boot or expired lease cannot establish absence of earlier side effects.
      if (
        result.status === 404 &&
        !attempt.cancel_requested &&
        !expired &&
        (await this.store.currentLease(attempt.request))
      ) {
        const replay = await this.request(
          attempt,
          "/v1/executions",
          "POST",
          attempt.request,
        );
        if (replay.snapshot) {
          await this.store.applySnapshot(attempt, replay.snapshot);
          return;
        }
      }
      await this.store.localOutcome(
        attempt,
        "unknown",
        "Node could not confirm the execution outcome; conversation remains locked pending reconciliation.",
      );
    } catch {
      await this.store.localOutcome(
        attempt,
        "unknown",
        "Node connection or response failed; the outcome is unknown and no new attempt will be created.",
      );
    }
  }
}
