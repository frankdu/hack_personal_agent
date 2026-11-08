import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Hardware, ModelProfile } from "@agent/contracts";
import type { OllamaConfig } from "./config.js";
import { durableWrite, readJson } from "./storage.js";
import {
  limitedJson,
  parseRuntimeManifest,
  RuntimeSupervisor,
  type RuntimeManifest,
} from "./runtime.js";
import { RequestError } from "./executions.js";

interface Tag {
  name: string;
  digest: string;
  size: number;
  remote_model?: string;
  remote_host?: string;
  details?: { family?: string; families?: string[]; parameter_size?: string };
}
interface Details {
  remote_model?: string;
  remote_host?: string;
  capabilities?: string[];
  parameters?: string;
  details?: Tag["details"];
  model_info?: Record<string, unknown>;
}
interface Measurement {
  tokensPerSecond: number;
  measuredAt: string;
}
interface Candidate {
  tag: Tag;
  profile: ModelProfile;
  downloaded: boolean;
  eligible: boolean;
  automaticReason?: string;
}
const BENCHMARK_REVISION = 1;
const SAMPLE_TOKENS = 128;
const MIN_SAMPLE_TOKENS = 64;
const prompt =
  "Write a detailed numbered list of 100 practical tips for writing reliable software. Explain every tip in a complete sentence. Begin immediately and keep going until all 100 tips are complete.";

export function parameterCount(
  details: Details,
  name: string,
): number | undefined {
  const reported = details.model_info?.["general.parameter_count"];
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0)
    return reported;
  const text = details.details?.parameter_size ?? "";
  const match =
    text.match(/^(\d+(?:\.\d+)?)\s*([BMT])$/i) ??
    name.match(/[:_-](\d+(?:\.\d+)?)([bmt])(?:[-_:]|$)/i);
  const count = match
    ? Number(match[1]) *
      ({ b: 1e9, m: 1e6, t: 1e12 }[match[2]!.toLowerCase()] ?? 1)
    : 0;
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

export function measuredSpeed(payload: unknown): number {
  const p = payload as {
    done?: boolean;
    eval_count?: number;
    eval_duration?: number;
    message?: { content?: string };
  };
  if (
    p?.done !== true ||
    typeof p.message?.content !== "string" ||
    !p.message.content.trim() ||
    !Number.isSafeInteger(p.eval_count) ||
    p.eval_count! < MIN_SAMPLE_TOKENS ||
    !Number.isFinite(p.eval_duration) ||
    p.eval_duration! <= 0
  )
    throw new Error("Insufficient generation sample");
  const speed = p.eval_count! / (p.eval_duration! / 1e9);
  if (!Number.isFinite(speed)) throw new Error("Invalid generation timing");
  return speed;
}

// Capacity is a deterministic proxy for model strength, not a quality benchmark.
export function rankCandidates(
  candidates: Candidate[],
  priority: string[],
): Candidate[] {
  const position = (name: string) => {
    const p = priority.indexOf(name);
    return p < 0 ? Infinity : p;
  };
  return [...candidates].sort(
    (a, b) =>
      position(a.tag.name) - position(b.tag.name) ||
      (b.profile.discovery?.parameterCount ?? 0) -
        (a.profile.discovery?.parameterCount ?? 0) ||
      b.tag.name.localeCompare(a.tag.name, undefined, { numeric: true }),
  );
}

/** Discovers locally installed weights only. Never pulls models or calls a hosted provider. */
export class OllamaDiscovery {
  private candidates: Candidate[] = [];
  private runtime?: RuntimeSupervisor;
  private selecting = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private readonly abort = new AbortController();
  private cache: Record<string, Measurement> = {};
  private fingerprint = "";
  private lastInventory = "";
  private refreshAt = 0;
  private preferredProfile?: string;
  onUnavailable: () => void = () => {};
  status = "Waiting for Ollama discovery";
  constructor(
    private readonly config: OllamaConfig,
    private readonly hardware: Hardware,
    private readonly nodeId: string,
    private readonly stateDir: string,
    private readonly busy: () => boolean,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  get manifest(): RuntimeManifest | undefined {
    return this.selecting ? undefined : this.runtime?.manifest;
  }
  readyProfile() {
    return !this.selecting && this.runtime?.profile().state === "ready"
      ? this.runtime.profile().id
      : undefined;
  }
  profiles(): ModelProfile[] {
    return this.candidates.map(({ profile }) => {
      const selected = this.runtime?.manifest.profileId === profile.id;
      return {
        ...profile,
        state:
          selected && !this.selecting
            ? this.runtime!.profile().state
            : profile.state,
        discovery: {
          ...profile.discovery!,
          selected: selected && !this.selecting,
          selectable:
            !this.stopped && !this.selecting && this.canSelect(profile.id),
        },
      };
    });
  }
  private canSelect(profileId: string) {
    // Manual activation only requires locally downloaded weights. Speed, metadata and
    // capability checks determine automatic selection; warmup validates manual activation.
    return Boolean(
      this.candidates.find((c) => c.profile.id === profileId)?.downloaded,
    );
  }
  /** Reserve the runtime synchronously before returning an asynchronous warmup acknowledgement. */
  select(profileId: string) {
    if (this.stopped || this.pending || this.selecting || this.busy())
      throw new RequestError(
        409,
        "node_busy",
        "Wait for model discovery and active or unresolved tasks to finish.",
      );
    if (!this.canSelect(profileId))
      throw new RequestError(
        409,
        "model_not_selectable",
        "This model is not downloaded locally. Refresh the node status.",
      );
    if (this.readyProfile() === profileId) return;
    const candidate = this.candidates.find((c) => c.profile.id === profileId)!;
    const previous = this.candidates.find(
      (c) => c.profile.id === this.runtime?.manifest.profileId,
    );
    this.selecting = true;
    candidate.profile.state = "starting";
    candidate.profile.discovery!.reason = "Warming model";
    this.status = `Switching to ${candidate.tag.name}`;
    clearTimeout(this.timer);
    this.pending = this.switchModel(candidate, previous)
      .catch(() => {
        candidate.profile.state = "failed";
        candidate.profile.discovery!.reason =
          "Model switch failed; retry after discovery refresh";
        this.status = "Model switch failed; retry or select another model";
      })
      .finally(() => {
        this.selecting = false;
        this.pending = undefined;
        if (!this.stopped)
          this.timer = setTimeout(
            () => void this.refresh(),
            this.config.refreshIntervalMs,
          );
      });
  }
  private async activate(
    candidate: Candidate,
    reason: string,
  ): Promise<boolean> {
    if (this.stopped) return false;
    const manifest = parseRuntimeManifest({
      kind: "external",
      profileId: candidate.profile.id,
      modelId: candidate.tag.name,
      endpoint: `${this.config.url}/v1`,
      contextWindow: candidate.profile.contextWindow,
      maxTokens: Math.min(
        2048,
        Math.floor(candidate.profile.contextWindow / 2),
      ),
      ollama: true,
    });
    this.runtime = new RuntimeSupervisor(manifest, this.nodeId, this.stateDir);
    this.runtime.onUnavailable = () => this.onUnavailable();
    await this.runtime.start();
    candidate.profile.state = "stopped";
    if (this.stopped) return false;
    if (this.runtime.profile().state === "ready") {
      candidate.profile.discovery!.reason = reason;
      this.status = `Active model: ${candidate.tag.name}`;
      return true;
    }
    await this.runtime.close();
    this.runtime = undefined;
    candidate.profile.state = "failed";
    candidate.profile.discovery!.reason =
      "OpenAI-compatible endpoint failed warmup";
    return false;
  }
  private async switchModel(candidate: Candidate, previous?: Candidate) {
    await durableWrite(join(this.stateDir, "ollama-selection.json"), {
      profileId: candidate.profile.id,
    });
    this.preferredProfile = candidate.profile.id;
    await this.runtime?.close();
    this.runtime = undefined;
    if (previous) {
      previous.profile.discovery!.reason =
        previous.automaticReason ??
        "Downloaded; available for manual activation";
      await this.request("/api/generate", {
        model: previous.tag.name,
        keep_alive: 0,
      }).catch(() => {});
    }
    if (this.stopped) return;
    if (await this.activate(candidate, "Active model chosen by operator"))
      return;
    if (
      !this.stopped &&
      previous &&
      (await this.activate(previous, "Restored after model switch failed"))
    ) {
      this.status = `Could not warm ${candidate.tag.name}; restored ${previous.tag.name}`;
    } else if (!this.stopped)
      this.status = `Could not warm ${candidate.tag.name}; select another model`;
  }
  private async request(
    path: string,
    body?: unknown,
    timeout = 5000,
  ): Promise<any> {
    const response = await this.fetcher(`${this.config.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(timeout),
      ]),
    });
    if (!response.ok) throw new Error("Ollama request failed");
    return limitedJson(response);
  }
  private cacheKey(candidate: Candidate) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          BENCHMARK_REVISION,
          this.fingerprint,
          this.config.url,
          candidate.tag.digest,
          candidate.tag.name,
          candidate.profile.contextWindow,
        ]),
      )
      .digest("hex");
  }
  private async benchmark(candidate: Candidate): Promise<Measurement> {
    const key = this.cacheKey(candidate);
    const previous = this.cache[key];
    const age = Date.now() - Date.parse(previous?.measuredAt ?? "");
    if (
      previous &&
      Number.isFinite(previous.tokensPerSecond) &&
      previous.tokensPerSecond >= 0 &&
      age >= 0 &&
      age < this.config.benchmarkTtlMs
    )
      return previous;
    candidate.profile.state = "starting";
    candidate.profile.discovery!.reason = "Measuring local generation speed";
    // Use Ollama's default runtime context, as the OpenAI execution endpoint does.
    // Thinking is disabled here and in Pi's Ollama execution payload.
    const sample = async (tokens: number, keepAlive: string | number) =>
      this.request(
        "/api/chat",
        {
          model: candidate.tag.name,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          think: false,
          keep_alive: keepAlive,
          options: { num_predict: tokens, temperature: 0 },
        },
        this.config.benchmarkTimeoutMs,
      );
    try {
      await sample(1, "5m"); // Exclude cold loading and compilation from decode measurements.
      const speeds = [
        measuredSpeed(await sample(SAMPLE_TOKENS, "5m")),
        measuredSpeed(await sample(SAMPLE_TOKENS, "5m")),
      ];
      const result = {
        tokensPerSecond: Math.min(...speeds),
        measuredAt: new Date().toISOString(),
      };
      this.cache[key] = result;
      await durableWrite(
        join(this.stateDir, "ollama-benchmarks.json"),
        this.cache,
      );
      return result;
    } finally {
      candidate.profile.state = "stopped";
      // Release benchmark weights before loading the next candidate. Never stop Ollama itself.
      if (!this.stopped)
        await this.request("/api/generate", {
          model: candidate.tag.name,
          keep_alive: 0,
        }).catch(() => {});
    }
  }
  async start() {
    const stored = await readJson(
      join(this.stateDir, "ollama-benchmarks.json"),
    ).catch(() => undefined);
    if (stored && typeof stored === "object" && !Array.isArray(stored))
      this.cache = stored as Record<string, Measurement>;
    const selection = (await readJson(
      join(this.stateDir, "ollama-selection.json"),
    ).catch(() => undefined)) as { profileId?: unknown } | undefined;
    if (typeof selection?.profileId === "string")
      this.preferredProfile = selection.profileId;
    await this.refresh();
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.pending = this.scan().finally(() => {
      this.pending = undefined;
      if (!this.stopped)
        this.timer = setTimeout(
          () => void this.refresh(),
          this.config.refreshIntervalMs,
        );
    });
    return this.pending;
  }
  private async scan() {
    if (this.stopped || this.busy()) return;
    try {
      const tags = await this.request("/api/tags");
      if (!Array.isArray(tags.models))
        throw new Error("Invalid Ollama inventory");
      const inventory: Tag[] = tags.models;
      if (
        inventory.length > 256 ||
        inventory.some(
          (t) =>
            typeof t.name !== "string" ||
            !t.name ||
            t.name.length > 256 ||
            typeof t.digest !== "string" ||
            !Number.isFinite(t.size) ||
            t.size < 0,
        )
      )
        throw new Error("Invalid Ollama inventory");
      const version = await this.request("/api/version");
      this.fingerprint = JSON.stringify([
        this.hardware.platform,
        this.hardware.arch,
        this.hardware.cpuModel,
        this.hardware.cpuCores,
        this.hardware.memoryBytes,
        this.hardware.gpus,
        version.version,
      ]);
      const signature = JSON.stringify([
        this.fingerprint,
        inventory.map((t) => [t.name, t.digest]).sort(),
      ]);
      if (
        signature === this.lastInventory &&
        Date.now() < this.refreshAt &&
        this.runtime?.profile().state === "ready"
      )
        return;
      // Recheck after the inventory requests. Withdrawing readiness synchronously prevents
      // a new execution from starting while a benchmark can replace its loaded weights.
      if (this.stopped || this.busy()) return;
      this.selecting = true;
      this.status = "Inspecting and benchmarking installed Ollama models";
      await this.runtime?.close();
      this.runtime = undefined;
      this.candidates = inventory.map((tag) => ({
        tag,
        downloaded: tag.size > 0 && !tag.remote_model && !tag.remote_host,
        eligible: false,
        profile: {
          id: `ollama-${createHash("sha256").update(tag.name).digest("hex").slice(0, 24)}`,
          modelId: tag.name,
          runtime: "external",
          state: "stopped",
          contextWindow: this.config.contextWindow,
          concurrency: 1,
          discovery: {
            source: "ollama",
            selected: false,
            reason: "Inspecting installed model",
          },
        },
      }));
      for (const c of this.candidates) {
        if (this.stopped) return;
        try {
          const details: Details = await this.request("/api/show", {
            model: c.tag.name,
          });
          c.downloaded =
            c.downloaded && !details.remote_model && !details.remote_host;
          c.profile.discovery!.parameterCount = parameterCount(
            details,
            c.tag.name,
          );
          const requestedContext = Number(
            details.parameters?.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1] ??
              4096,
          );
          const context =
            Number.isSafeInteger(requestedContext) && requestedContext >= 256
              ? requestedContext
              : 4096;
          const architecture = details.model_info?.["general.architecture"];
          const maxContext =
            typeof architecture === "string"
              ? details.model_info?.[`${architecture}.context_length`]
              : undefined;
          c.profile.contextWindow = Math.min(
            this.config.contextWindow,
            context,
            typeof maxContext === "number" &&
              Number.isSafeInteger(maxContext) &&
              maxContext >= 256
              ? maxContext
              : context,
          );
          const reason = !c.downloaded
            ? "Model is not downloaded locally"
            : !Array.isArray(details.capabilities) ||
                !details.capabilities.includes("completion") ||
                !details.capabilities.includes("tools")
              ? "Automatic selection requires chat completion and tools"
              : !c.profile.discovery!.parameterCount
                ? "Automatic selection requires a known parameter count"
                : c.tag.size > this.hardware.memoryBytes * 0.8
                  ? "Model weights exceed the automatic selection memory limit"
                  : undefined;
          c.eligible = !reason;
          c.profile.discovery!.reason = c.automaticReason =
            reason ?? "Waiting for automatic selection speed benchmark";
        } catch {
          c.profile.state = "failed";
          c.profile.discovery!.reason = c.automaticReason =
            "Could not inspect model metadata for automatic selection";
        }
      }
      for (const c of rankCandidates(
        this.candidates.filter((c) => c.eligible),
        this.config.modelPriority,
      )) {
        if (this.stopped) return;
        try {
          const result = await this.benchmark(c);
          Object.assign(c.profile.discovery!, result);
          c.profile.discovery!.reason = c.automaticReason =
            result.tokensPerSecond >= this.config.minTokensPerSecond
              ? "Automatic selection speed requirement met"
              : `Below ${this.config.minTokensPerSecond} tokens/s automatic selection minimum`;
        } catch {
          c.eligible = false;
          c.profile.state = "failed";
          c.profile.discovery!.reason = c.automaticReason =
            "Automatic selection benchmark failed, timed out, or generated too few tokens";
        }
      }
      if (this.stopped) return;
      const passing = rankCandidates(
        this.candidates.filter(
          (c) =>
            c.eligible &&
            (c.profile.discovery?.tokensPerSecond ?? 0) >=
              this.config.minTokensPerSecond,
        ),
        this.config.modelPriority,
      );
      // A saved manual choice stays active even when it is ineligible for automatic selection.
      const preferred = this.candidates.find(
        (c) => c.downloaded && c.profile.id === this.preferredProfile,
      );
      let selectedModel: string | undefined;
      for (const selected of preferred
        ? [preferred, ...passing.filter((c) => c !== preferred)]
        : passing) {
        if (this.stopped) return;
        if (
          await this.activate(
            selected,
            selected === preferred
              ? "Active model chosen by operator"
              : "Active: highest ranked model meeting the speed requirement",
          )
        ) {
          selectedModel = selected.tag.name;
          break;
        }
      }
      if (!selectedModel)
        this.status =
          "No downloaded model is ready for automatic selection; activate a model manually";
      this.lastInventory = signature;
      this.refreshAt = Date.now() + this.config.benchmarkTtlMs;
      console.info(
        JSON.stringify({
          event: "ollama_selection",
          status: this.status,
          selectedModel,
        }),
      );
    } catch {
      this.status =
        "Ollama unavailable or returned an invalid inventory; retrying";
      // An inaccessible inventory is not a successful empty discovery.
    } finally {
      this.selecting = false;
    }
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort();
    await this.runtime?.close();
    await this.pending;
  }
}
