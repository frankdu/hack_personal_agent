import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, lstat, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, join } from "node:path";
import { freemem } from "node:os";
import { createConnection } from "node:net";
import type { Hardware, ModelProfile } from "@agent/contracts";
import { command, type Command } from "./probes.js";
import { durableWrite, readJson, Serial } from "./storage.js";

export interface RuntimeManifest {
  kind: "external" | "native" | "docker";
  profileId: string;
  modelId: string;
  endpoint: string;
  contextWindow: number;
  maxTokens: number;
  startupTimeoutMs: number;
  probeIntervalMs: number;
  maxRestarts: number;
  requiredMemoryBytes: number;
  ollama?: boolean;
  native?: {
    executable: string;
    args: string[];
    artifactPath: string;
    artifactSha256: string;
  };
  docker?: {
    image: string;
    command: string[];
    containerPort: number;
    artifactPath: string;
    artifactSha256: string;
    modelMountPath: string;
    memoryBytes: number;
    cpus: number;
    gpus?: string;
    engine?: "vllm";
    shmBytes?: number;
  };
}
const integer = (x: unknown, fallback: number, min: number, max: number) => {
  if (x === undefined) return fallback;
  if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max)
    throw new Error("Invalid runtime numeric limit");
  return x;
};
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || v.includes("\0")) ||
    value.length > 100
  )
    throw new Error("Runtime arguments must be a bounded string array");
  return value;
}
export function parseRuntimeManifest(input: unknown): RuntimeManifest {
  if (!input || typeof input !== "object")
    throw new Error("Runtime configuration must be an object");
  const v = input as Record<string, any>;
  if (!["external", "native", "docker"].includes(v.kind))
    throw new Error("Choose an explicit runtime kind");
  if (
    typeof v.profileId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(v.profileId)
  )
    throw new Error("Invalid profileId");
  if (typeof v.modelId !== "string" || !v.modelId || v.modelId.length > 256)
    throw new Error("Invalid modelId");
  const endpoint = new URL(v.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname.replace(/\/$/, "") !== "/v1"
  )
    throw new Error("Runtime endpoint must be a loopback HTTP /v1 URL");
  const result: RuntimeManifest = {
    kind: v.kind,
    profileId: v.profileId,
    modelId: v.modelId,
    endpoint: endpoint.toString().replace(/\/$/, ""),
    contextWindow: integer(v.contextWindow, 8192, 256, 262144),
    maxTokens: integer(v.maxTokens, 2048, 1, 32768),
    startupTimeoutMs: integer(v.startupTimeoutMs, 120000, 1000, 600000),
    probeIntervalMs: integer(v.probeIntervalMs, 10000, 1000, 300000),
    maxRestarts: integer(v.maxRestarts, 2, 0, 10),
    requiredMemoryBytes: integer(
      v.requiredMemoryBytes,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  if (v.kind !== "external" && result.requiredMemoryBytes < 1)
    throw new Error(
      "Managed runtime requires an operator-measured requiredMemoryBytes budget",
    );
  if (v.ollama === true && v.kind === "external") result.ollama = true;
  if (result.maxTokens >= result.contextWindow)
    throw new Error("maxTokens must be smaller than contextWindow");
  for (const kind of ["native", "docker"] as const)
    if (v.kind === kind) {
      const spec = v[kind];
      if (
        !spec ||
        !isAbsolute(spec.artifactPath ?? "") ||
        !/^[a-f0-9]{64}$/.test(spec.artifactSha256 ?? "")
      )
        throw new Error(
          "Runtime artifacts require an absolute path and SHA256",
        );
      if (kind === "native") {
        if (!isAbsolute(spec.executable ?? ""))
          throw new Error(
            "Native runtime executable must be an approved absolute path",
          );
        result.native = {
          executable: spec.executable,
          args: strings(spec.args),
          artifactPath: spec.artifactPath,
          artifactSha256: spec.artifactSha256,
        };
      } else {
        if (
          typeof spec.image !== "string" ||
          !/^[-a-zA-Z0-9./_:]+@sha256:[a-f0-9]{64}$/.test(spec.image)
        )
          throw new Error("Docker image must be pinned by SHA256 digest");
        if (
          !isAbsolute(spec.modelMountPath ?? "") ||
          spec.modelMountPath.includes(",") ||
          spec.artifactPath.includes(",")
        )
          throw new Error("Invalid Docker model mount");
        if (
          spec.gpus !== undefined &&
          (typeof spec.gpus !== "string" ||
            !/^(all|device=[0-9,]+)$/.test(spec.gpus))
        )
          throw new Error("Invalid explicit GPU assignment");
        result.docker = {
          image: spec.image,
          command: strings(spec.command ?? []),
          containerPort: integer(spec.containerPort, 8080, 1, 65535),
          artifactPath: spec.artifactPath,
          artifactSha256: spec.artifactSha256,
          modelMountPath: spec.modelMountPath,
          memoryBytes: integer(
            spec.memoryBytes,
            8 * 1024 ** 3,
            128 * 1024 ** 2,
            Number.MAX_SAFE_INTEGER,
          ),
          cpus: integer(spec.cpus, 4, 1, 1024),
          gpus: spec.gpus,
        };
        if (spec.engine !== undefined && spec.engine !== "vllm")
          throw new Error("Unsupported Docker inference engine");
        if (spec.engine === "vllm") {
          result.docker.engine = "vllm";
          if (!spec.gpus)
            throw new Error(
              "vLLM Docker requires an explicit NVIDIA GPU assignment",
            );
          if (!result.docker.command.length)
            throw new Error("vLLM Docker requires explicit server arguments");
        }
        if (spec.shmBytes !== undefined || spec.engine === "vllm")
          result.docker.shmBytes = integer(
            spec.shmBytes,
            2 * 1024 ** 3,
            64 * 1024 ** 2,
            result.docker.memoryBytes,
          );
      }
    }
  return result;
}
/** File SHA256, or a stable tree digest of relative POSIX names and file hashes. */
export async function artifactSha256(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink())
    throw new Error("Runtime artifacts must not contain symlinks");
  if (info.isDirectory()) {
    const tree = createHash("sha256");
    const visit = async (directory: string, prefix: string) => {
      const entries = (await readdir(directory)).sort();
      for (const name of entries) {
        const child = join(directory, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        const entry = await lstat(child);
        if (entry.isSymbolicLink())
          throw new Error("Runtime artifacts must not contain symlinks");
        if (entry.isDirectory()) await visit(child, relative);
        else if (entry.isFile())
          tree.update(
            JSON.stringify([relative, await artifactSha256(child)]) + "\n",
          );
        else
          throw new Error(
            "Runtime artifacts must be regular files or directories",
          );
      }
    };
    await visit(path, "");
    return tree.digest("hex");
  }
  if (!info.isFile())
    throw new Error("Runtime artifacts must be regular files or directories");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyArtifact(path: string, expected: string) {
  if ((await artifactSha256(path)) !== expected)
    throw new Error("Runtime artifact checksum mismatch");
}
export function validateRuntimeHardware(
  manifest: RuntimeManifest,
  hardware: Hardware,
) {
  if (
    manifest.docker?.engine === "vllm" &&
    (hardware.platform !== "linux" ||
      !hardware.docker.available ||
      hardware.docker.scope !== "host" ||
      !hardware.gpus.some((gpu) => gpu.vendor === "nvidia"))
  ) {
    throw new Error(
      "vLLM Docker requires a native Linux node with host Docker and NVIDIA GPU access. Apple Silicon uses native Ollama/MLX or an external vLLM-Metal endpoint.",
    );
  }
}
export interface RuntimeAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export class NativeProcessRuntime implements RuntimeAdapter {
  private child?: ChildProcess;
  constructor(private readonly manifest: RuntimeManifest) {}
  async start() {
    const spec = this.manifest.native!;
    await verifyArtifact(spec.artifactPath, spec.artifactSha256);
    await access(spec.executable);
    // Never adopt or kill a PID from a previous boot: its identity cannot be proven safely.
    const child = spawn(spec.executable, spec.args, {
      stdio: "ignore",
      shell: false,
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
        LANG: "C.UTF-8",
      },
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
export function dockerRunArgs(
  manifest: RuntimeManifest,
  nodeId: string,
  digest: string,
): string[] {
  const d = manifest.docker!;
  const port = new URL(manifest.endpoint).port || "80";
  return [
    "run",
    "-d",
    "--name",
    `curilo_agent-${nodeId}-${manifest.profileId}`,
    "--pull=never",
    "--restart=no",
    "--label",
    `curilo_agent.node=${nodeId}`,
    "--label",
    `curilo_agent.profile=${manifest.profileId}`,
    "--label",
    `curilo_agent.manifest=${digest}`,
    "--memory",
    String(d.memoryBytes),
    "--cpus",
    String(d.cpus),
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--publish",
    `127.0.0.1:${port}:${d.containerPort}`,
    "--mount",
    `type=bind,src=${d.artifactPath},dst=${d.modelMountPath},readonly`,
    ...(d.gpus ? ["--gpus", d.gpus] : []),
    ...(d.shmBytes ? ["--shm-size", String(d.shmBytes)] : []),
    ...(d.engine === "vllm"
      ? [
          "--env",
          "HF_HUB_OFFLINE=1",
          "--env",
          "TRANSFORMERS_OFFLINE=1",
          "--env",
          "VLLM_NO_USAGE_STATS=1",
        ]
      : []),
    d.image,
    ...d.command,
  ];
}
export class DockerContainerRuntime implements RuntimeAdapter {
  private containerId?: string;
  private readonly digest: string;
  constructor(
    private readonly manifest: RuntimeManifest,
    private readonly nodeId: string,
    private readonly stateDir: string,
    private readonly run: Command = command,
  ) {
    this.digest = createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex");
  }
  private get journalPath() {
    return join(this.stateDir, `runtime-${this.manifest.profileId}.json`);
  }
  private async owned(id: string): Promise<any> {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Invalid container ID");
    const rows = JSON.parse(await this.run("docker", ["inspect", id]));
    const row = rows[0];
    const labels = row?.Config?.Labels;
    if (
      labels?.["curilo_agent.node"] !== this.nodeId ||
      labels?.["curilo_agent.profile"] !== this.manifest.profileId ||
      labels?.["curilo_agent.manifest"] !== this.digest
    )
      throw new Error("Container ownership does not match");
    if (row.Config.Image !== this.manifest.docker!.image)
      throw new Error("Container image does not match the approved digest");
    return row;
  }
  async start() {
    const d = this.manifest.docker!;
    await verifyArtifact(d.artifactPath, d.artifactSha256);
    const previous = (await readJson(this.journalPath)) as
      { containerId?: string } | undefined;
    // Find by a deterministic name even if the process died between docker run and journaling.
    const name = `curilo_agent-${this.nodeId}-${this.manifest.profileId}`;
    const listed = (
      await this.run("docker", [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `name=^/${name}$`,
        "--format",
        "{{.ID}}",
      ])
    ).trim();
    const candidate = listed || undefined;
    if (
      previous?.containerId &&
      candidate &&
      previous.containerId !== candidate
    )
      throw new Error("Runtime container identity changed");
    if (candidate) {
      const row = await this.owned(candidate);
      this.containerId = candidate;
      if (!row.State?.Running)
        await this.run("docker", ["start", this.containerId]);
      await durableWrite(this.journalPath, { containerId: candidate });
      return;
    }
    // --pull=never and immutable digest make image provisioning an explicit operator action.
    const id = (
      await this.run(
        "docker",
        dockerRunArgs(this.manifest, this.nodeId, this.digest),
      )
    ).trim();
    await this.owned(id);
    this.containerId = id;
    await durableWrite(this.journalPath, { containerId: id });
  }
  async stop() {
    if (!this.containerId) return;
    await this.owned(this.containerId);
    await this.run("docker", ["stop", "--time", "3", this.containerId]);
    await this.run("docker", ["rm", this.containerId]);
    await durableWrite(this.journalPath, {});
    this.containerId = undefined;
  }
}
export class RuntimeSupervisor {
  private adapter: RuntimeAdapter;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  private state: ModelProfile["state"] = "stopped";
  private recovering = false;
  private readonly lifecycle = new Serial();
  private readonly abort = new AbortController();
  onUnavailable: () => void = () => {};
  constructor(
    readonly manifest: RuntimeManifest,
    nodeId: string,
    stateDir: string,
    private readonly admissionMemoryBytes = freemem(),
  ) {
    this.adapter =
      manifest.kind === "native"
        ? new NativeProcessRuntime(manifest)
        : manifest.kind === "docker"
          ? new DockerContainerRuntime(manifest, nodeId, stateDir)
          : { start: async () => {}, stop: async () => {} };
  }
  profile(): ModelProfile {
    return {
      id: this.manifest.profileId,
      modelId: this.manifest.modelId,
      runtime: this.manifest.kind,
      state: this.state,
      contextWindow: this.manifest.contextWindow,
      concurrency: 1,
    };
  }
  async probe() {
    const response = await fetch(`${this.manifest.endpoint}/models`, {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(3000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Model endpoint unavailable");
    const data = (await limitedJson(response)) as { data?: { id: string }[] };
    if (!data.data?.some((m) => m.id === this.manifest.modelId))
      throw new Error("Served model identity mismatch");
  }
  async warm() {
    const response = await fetch(`${this.manifest.endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.manifest.modelId,
        messages: [{ role: "user", content: "Reply OK." }],
        max_tokens: 1,
        stream: false,
        ...(this.manifest.ollama ? { reasoning_effort: "none" } : {}),
      }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Model warmup failed");
    const payload = (await limitedJson(response)) as {
      choices?: { message?: { content?: unknown } }[];
    };
    if (!Array.isArray(payload.choices) || payload.choices.length === 0)
      throw new Error("Invalid model warmup response");
  }
  start(): Promise<void> {
    return this.lifecycle.run(() => this.startInternal());
  }
  private async startInternal(): Promise<void> {
    if (this.stopped) return;
    this.state = "starting";
    try {
      if (
        this.manifest.requiredMemoryBytes >
        Math.min(freemem(), this.admissionMemoryBytes) * 0.8
      )
        throw new Error("Insufficient available memory for runtime reserve");
      if (this.manifest.kind === "native") {
        const occupied = await portOccupied(this.manifest.endpoint);
        if (occupied)
          throw new Error(
            "Native endpoint already in use; choose external explicitly to adopt it",
          );
      }
      await this.adapter.start();
      const deadline = Date.now() + this.manifest.startupTimeoutMs;
      while (!this.stopped) {
        try {
          await this.probe();
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await delay(500, undefined, { signal: this.abort.signal });
        }
      }
      if (this.stopped) return;
      await this.warm();
      this.state = "ready";
      this.schedule();
    } catch {
      if (this.stopped) {
        this.state = "stopped";
        return;
      }
      this.state = "failed";
      this.onUnavailable();
      this.schedule();
    }
  }
  private schedule() {
    if (!this.stopped)
      this.timer = setTimeout(
        () => void this.lifecycle.run(() => this.tick()),
        this.manifest.probeIntervalMs,
      );
  }
  private async tick() {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    try {
      await this.probe();
      if (this.state !== "ready") {
        await this.warm();
        this.state = "ready";
      }
    } catch {
      if (this.stopped) return;
      this.state = "failed";
      this.onUnavailable();
      if (this.failures++ < this.manifest.maxRestarts) {
        try {
          await delay(Math.min(1000 * 2 ** this.failures, 30000), undefined, {
            signal: this.abort.signal,
          });
          if (this.stopped) return;
          if (
            this.manifest.requiredMemoryBytes >
            Math.min(freemem(), this.admissionMemoryBytes) * 0.8
          )
            throw new Error("Insufficient memory");
          await this.adapter.stop();
          await this.adapter.start();
          await this.probe();
          await this.warm();
          this.state = "ready";
        } catch {}
      }
    } finally {
      this.recovering = false;
      this.schedule();
    }
  }
  async close() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
    await this.lifecycle.run(async () => {
      this.state = "stopped";
      await this.adapter.stop();
    });
  }
}
export async function loadRuntime(
  path?: string,
): Promise<RuntimeManifest | undefined> {
  return path
    ? parseRuntimeManifest(JSON.parse(await readFile(path, "utf8")))
    : undefined;
}

export async function limitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty runtime response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 1_000_000) throw new Error("Runtime response too large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}
async function portOccupied(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  return new Promise((resolve) => {
    const socket = createConnection({
      host: url.hostname.replace(/[\[\]]/g, ""),
      port: Number(url.port || 80),
    });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
  });
}
