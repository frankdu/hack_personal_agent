# Node agent

Persistent Node 24 service embedding `@earendil-works/pi-coding-agent` 1.5.0. It enrolls with the backend, discovers installed Ollama models or supervises an explicitly configured local runtime, and executes one task at a time. It supports native macOS/Linux and Docker deployment; macOS Metal requires a native service.

From the workspace root, run `npm run dev:node`. Build with `npm run build -w @agent/node-agent` after building shared contracts. `src/app.ts` exports `startNode(config)` for integration tests; the returned `close()` drains execution, enrollment, runtime and HTTP resources.

## Configuration

| Variable                       | Default                             | Purpose                                                                                                                                      |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODE`                         | `DEV`                               | Exactly `DEV` or `PROD`                                                                                                                      |
| `HOST`, `PORT`                 | `127.0.0.1`, `3101`                 | HTTP listener; container uses `HOST=0.0.0.0`                                                                                                 |
| `NODE_NAME`                    | OS hostname                         | Display name; durable UUID lives under the state directory                                                                                   |
| `NODE_STATE_DIR`               | `~/.curilo-agent/node-agent`        | Private identity, execution journal, SDK sessions and runtime records outside the workspace                                                  |
| `AGENT_WORKSPACE_DIR`          | `~/.curilo/workspace/chat_sessions` | Existing project root, or default parent for per-conversation directories                                                                    |
| `WORKSPACE_ID`                 | `default`                           | Public workspace identifier                                                                                                                  |
| `ENABLED_TOOLS`                | `read,bash,edit,write,grep,find,ls` | Comma-separated tool allowlist; an explicitly empty value disables all tools                                                                 |
| `BACKEND_URL`                  | Unset                               | Backend HTTP(S) origin; without it the node remains unregistered                                                                             |
| `NODE_ENDPOINT`                | `http://127.0.0.1:3101`             | Advertised origin; must match backend operator allowlist                                                                                     |
| `NODE_SHARED_TOKEN`            | Unset                               | Shared initial bearer credential, at least 32 characters when enrolled                                                                       |
| `RUNTIME_CONFIG`               | Unset                               | Operator-controlled local runtime manifest JSON path                                                                                         |
| `MODEL_PROVIDER`, `MODEL_ID`   | Unset                               | Legacy paired model selector; runtime manifest is authoritative for served model identity, provider can override the local SDK provider name |
| `OLLAMA_AUTO_DISCOVER`         | `true`                              | Discover and benchmark local installed models when `RUNTIME_CONFIG` is unset                                                                 |
| `OLLAMA_URL`                   | `http://127.0.0.1:11434`            | Local loopback HTTP origin; no credentials, paths or remote hosts                                                                            |
| `OLLAMA_MIN_TOKENS_PER_SECOND` | `20`                                | Minimum measured generation speed, at least 20                                                                                               |
| `OLLAMA_MODEL_PRIORITY`        | Empty                               | Optional comma-separated exact IDs, ranked first; speed and capability checks still apply                                                    |
| `OLLAMA_CONTEXT_WINDOW`        | `8192`                              | Upper bound on advertised context; capped by model metadata and configured `num_ctx` (conservative 4096 when unspecified)                    |
| `OLLAMA_BENCHMARK_TIMEOUT_MS`  | `180000`                            | Timeout for each bounded benchmark request, including model loading                                                                          |
| `OLLAMA_BENCHMARK_TTL_MS`      | `21600000`                          | Measurement cache lifetime, six hours by default                                                                                             |
| `OLLAMA_REFRESH_INTERVAL_MS`   | `60000`                             | Idle inventory refresh interval                                                                                                              |

When `AGENT_WORKSPACE_DIR` is unset, empty, or whitespace-only, startup creates `~/.curilo/workspace/chat_sessions`. Each execution creates or reuses its working directory at `<chat_sessions>/<conversation-id>`; the conversation ID is the stable chat session ID, so all turns in that conversation share files on the same node. SDK sessions, file tools and shell tools use that directory. Separate conversations get separate directories. This replaces the earlier `<process cwd>/default-chat-workspace` default; existing files are left in place.

Set a nonempty `AGENT_WORKSPACE_DIR` to use an existing project directory for tasks instead. Relative configured paths resolve from the process working directory. Private state stays outside the workspace and is never browsable through the project API.

The authenticated project service automatically exposes the default parent with display name `chat_sessions`, or the explicitly configured project with its directory name. Operators can add other existing project roots; canonical paths and IDs persist in `projects.json` under the private state directory. Adding a sidebar project grants directory browsing, not additional tool permissions or a change to the configured chat working directory. Legacy browser-saved roots are imported by the frontend when the node is online.

Keep state outside the tool workspace. Do not mount a Docker socket or provider credentials into the workspace. This release has a shared provisioning credential; per-node credentials and mTLS remain production work.

## Automatic Ollama selection

With no `RUNTIME_CONFIG`, startup lists `/api/tags` and reads `/api/show` metadata. All installed models appear in fleet profiles. There is no model-family restriction. Automatic selection admits downloaded local models with completion and tool support, a known parameter count, and weights no larger than 80% of total machine memory. Cloud-backed models are excluded. Ollama remains responsible for loading and actual memory admission; a failed/OOM/timeout benchmark is ineligible for automatic selection, never an assumed pass.

Each eligible model gets a one-token warmup followed by two 128-token synthetic chat samples, with thinking disabled. Samples must contain text and at least 64 generated tokens. Speed is `eval_count / (eval_duration / 1e9)`, using Ollama's generation timing, excluding loading and prompt evaluation. Both samples must meet the minimum. The slower result is shown in the UI. The benchmark uses Ollama's default runtime context, as the OpenAI execution API does; it does not change the server's context configuration. Pi requests also disable thinking through `reasoning_effort: none`.

"Most powerful" is implemented as largest total parameter count, then natural model-name order for ties. This is an explicit capacity proxy, not a cross-family quality score (MoE active parameters and quantization can change the tradeoff). Set `OLLAMA_MODEL_PRIORITY` to express a preferred quality order. Only the highest ranked passing model becomes ready; other installed models retain their measurement or exclusion reason. The selected model must also pass the OpenAI-compatible endpoint warmup. An incompatible winner falls back to the next passing model.

Discovery starts after HTTP listening and enrollment, so the node stays visible during benchmarking. Inventory refreshes and benchmarking wait for all active/unknown attempts to clear, and withdraw readiness while changing models. Benchmark weights are unloaded between candidates; the winner is warmed again. Measurements persist under the private state directory, keyed by model digest/name, hardware, Ollama version, context admission and benchmark revision. Changed weights/runtime/hardware or expired measurements trigger new samples. Benchmarks use only synthetic local text and can take several minutes on first startup. They measure short-prompt generation under current load, not a guarantee for every future context or concurrent workload. Failed discovery is reported by `modelDiscovery` in `/v1/node/status` and retried; a failed scan is not reported as an empty successful inventory.

The control UI can manually activate any downloaded local Ollama model, regardless of family, speed, benchmark freshness or automatic-selection metadata/capability/memory checks. The 20 tokens/s minimum applies only to automatic selection. Manual activation still needs a successful endpoint warmup before the node becomes ready; a model that cannot load or serve chat will report a warmup failure. The node withdraws readiness, unloads the previous weights and warms the requested model. A failed warmup attempts to restore the previous model. The operator preference is saved in `ollama-selection.json` under the private state directory and is restored on refresh and restart while the model remains downloaded, even below the automatic speed minimum. Remove that file and restart to restore automatic ranking. Active, admitting and unresolved executions block switching; explicit `RUNTIME_CONFIG` manifests do not support this selector.

Run the node beside Ollama on the host. A container's loopback does not reach the host's Ollama. `OLLAMA_AUTO_DISCOVER=false` disables the behavior. An explicit runtime manifest always takes precedence.

## Local runtime configuration

For an explicit runtime override, set `RUNTIME_CONFIG` to an absolute manifest path and restart the node. Example for an already running local OpenAI-compatible Gemma server:

```json
{
  "kind": "external",
  "profileId": "gemma-local",
  "modelId": "gemma-4-e2b",
  "endpoint": "http://127.0.0.1:8080/v1",
  "contextWindow": 8192,
  "maxTokens": 2048,
  "startupTimeoutMs": 120000,
  "probeIntervalMs": 10000,
  "maxRestarts": 2
}
```

The endpoint must be loopback HTTP with `/v1`. `/models` must list the exact model ID. Startup probes identity and sends one bounded synthetic nonstream chat request before advertising ready. This can execute inference on the explicitly configured local runtime; it never uses a hosted provider. External runtimes are reported as external and are neither stopped nor launched by this service.

Managed manifests use the same fields with `kind: native` or `kind: docker` and require `requiredMemoryBytes`, an operator-measured peak including context/cache/buffers. Admission reserves 20% of current OS free memory. This is a first RAM gate, not automatic model selection or GPU-memory admission.

Native profiles add:

```json
{
  "native": {
    "executable": "/absolute/path/to/llama-server",
    "args": [
      "--model",
      "/absolute/path/to/model.gguf",
      "--host",
      "127.0.0.1",
      "--port",
      "8080"
    ],
    "artifactPath": "/absolute/path/to/model.gguf",
    "artifactSha256": "REPLACE_WITH_REAL_SHA256"
  }
}
```

This fragment is not a valid launch manifest until supplied with a real checksum and the common fields. The artifact is hashed before launch; the operator approves the executable and argument array. No shell interprets launch arguments. Native runtimes cannot be adopted after a crash: an occupied port is rejected, and the service never kills an arbitrary previous PID.

Docker profiles add `docker.image` pinned as `repository@sha256:...`, `command` array, `containerPort`, `artifactPath`, `artifactSha256`, `modelMountPath`, `memoryBytes`, `cpus`, and optional `gpus` (`all` or `device=0`). The image must already exist (`--pull=never`). Model artifact mounts are read-only, host publication is loopback, and container name plus labels include the owning node/profile and manifest digest. Reconciliation can adopt an owned matching container even if a crash preceded its journal commit; ownership or image mismatch prevents adoption/removal. No global prune is used. Current Docker management assumes the service and Docker daemon share host path and loopback namespaces; Docker Desktop or a containerized controller needs explicit operator topology work before managed sibling-container use.

## Optional managed vLLM Docker runtime

Yes: a native Linux node with host Docker and an NVIDIA GPU can launch, probe, warm, adopt, recover and stop its own vLLM container. Copy [examples/vllm-runtime.json](examples/vllm-runtime.json), replace the image digest, model directory and checksum, and measure appropriate RAM/GPU/context budgets. This is an opt-in override through `RUNTIME_CONFIG`; no vLLM image or model is pulled automatically, and the Ollama speed-selection policy applies only to discovery.

Provision a compatible vLLM image and a complete materialized model directory (config, tokenizer, safetensors weights) beforehand. Ollama tags are not vLLM model paths; MLX artifacts are not CUDA safetensors checkpoints. If downloading from the Hub, use `hf download <repo> --local-dir /absolute/model/path` with an exact revision. The mounted directory must contain regular files with no symlinks. After provisioning, compute its tree checksum:

```sh
npm run runtime:hash -w @agent/node-agent -- /absolute/model/path
```

For a directory, the checksum is SHA256 of sorted depth-first file entries, each encoded as a JSON `[relativePosixPath, fileSha256]` followed by a newline. Any file change invalidates admission. Single-file checksums keep their existing semantics. Hashing large weights adds startup time. Keep the directory stable after hashing.

The vLLM manifest uses `docker.engine: vllm`, explicit `gpus`, and `shmBytes` (default 2 GiB, bounded by container RAM). The node mounts the checksummed model read-only, passes offline Hub/Transformers flags, publishes only loopback, and uses existing ownership/digest checks for recovery and cleanup. Set the server's `--served-model-name`, port and context to match the common manifest fields. The example's `hermes` tool parser targets Qwen3; choose the parser/chat template appropriate for the exact model and image version. No provider token is needed in the offline container.

This managed CUDA option rejects macOS/Docker Desktop and nodes without detected NVIDIA/host Docker support before launch. On Apple Silicon, keep native Ollama/MLX or configure an external native vLLM-Metal endpoint. Docker Model Runner also offers a vLLM-Metal backend, but it executes natively on macOS, not inside a Metal-enabled Linux container. See [vLLM Docker deployment](https://docs.vllm.ai/en/latest/deployment/docker/), [Ollama model metadata](https://docs.ollama.com/api-reference/show-model-details), [Ollama generation timing](https://docs.ollama.com/api/chat), and [Docker's macOS vLLM-Metal explanation](https://www.docker.com/blog/docker-model-runner-vllm-metal-macos/).

Runtime health probes run periodically. Recovery has bounded attempts with exponential delay. Shutdown serializes against startup/recovery. A failed runtime aborts current work; uncertain attempts are never automatically replayed.

## Execution protocol

- `GET /health/live`: process availability.
- `GET /health/ready`: 200 only with a current enrollment lease, warm runtime, free execution slot and no unresolved unknown attempt.
- `GET /v1/node/status`: public descriptive status; no credentials or local paths.
- `GET /v1/node/projects`: node-authenticated project roots, including the automatic default parent; private paths are visible only through this operator-facing service.
- `POST /v1/node/projects`: node-authenticated `{directory}`; validate and persist an existing project root (supports `~/`); duplicate canonical roots return the same project.
- `GET /v1/node/projects/:projectId/tree?path=.&offset=0`: node-authenticated directory entries relative to an approved root, at most 200 per page. `nextOffset` loads the next page. Traversal, private state and symlink expansion are rejected. Symlinks are displayed as leaves; file contents are not returned.
- `POST /v1/node/model`: authenticated `{profileId, bootId, generation}`; returns 202 with profiles after reserving an asynchronous switch. The backend exposes this as operator-authenticated `POST /v1/nodes/:nodeId/model` with `{profileId}` and rejects queued or unresolved tasks under the placement lock.
- `POST /v1/executions`: authenticated shared-contract envelope; returns a bare snapshot and 202 after durable acceptance.
- `GET /v1/executions/:attemptId`: authenticated snapshot polling.
- `POST /v1/executions/:attemptId/cancel`: authenticated cancellation, returning only after execution settles.

Registration is `POST /v1/nodes/register`; renewals use `POST /v1/nodes/:nodeId/heartbeats`. Expired/fenced leases cannot authorize new execution or tool calls. Once a process has received a lease, it does not self-register to steal ownership after fencing; restart it to request enrollment deliberately.

Each attempt verifies its canonical SHA256 digest, node/boot/generation, deadline, workspace, profile and task-tool subset. Same ID/digest returns the existing result; a changed digest is rejected. The journal uses atomic rename and fsync before acknowledgement or tool execution. Restart converts unfinished work to `unknown`, preserving partial output without replay. Unknown attempts consume advertised capacity until operator reconciliation. A side-effecting tool exception/abort is uncertain even if the agent catches it; it cannot become a false success. A completed nonzero exit or structured error result is journaled as a `failed` tool invocation and returned to the agent so it can continue reasoning; this known outcome does not imply rollback. Duplicate invocation IDs are never replayed.

Pi sessions use the explicitly registered local model, disabled ambient extensions/skills, the exact per-task tool subset, a fresh persisted session with restored textual conversation history, and no automatic retry. Inference uses OpenAI-compatible `POST /v1/chat/completions` with `stream: true`; warmup uses the same endpoint with `stream: false` and a one-token budget. Each inference request sets its own reply budget from the configured maximum, estimated full prompt/tool size and proportional context headroom. This avoids Pi 1.5's fixed 4096-token reserve reducing 4K models to single-token replies. The estimate is not a tokenizer; the runtime remains responsible for actual context admission. Streaming output is journaled cumulatively. The backend polls node snapshots every 500 ms, and the frontend polls active tasks every 750 ms. Tool invocations record input digest and lifecycle state without storing raw arguments in the journal.

The system prompt names the tools enabled for the current task. With no tools enabled, the agent is instructed to answer from supplied context and explain when it cannot inspect or change the workspace. Text from separate assistant/tool turns retains paragraph boundaries. Token-limited responses fail with an explicit incomplete-response error, preserving the received text (including the final streamed tail) without automatically retrying or continuing truncated tool calls.

Filesystem tool paths are checked for traversal and symlink escapes. This is not an OS sandbox and cannot prevent races caused by concurrent filesystem mutation. `bash` explicitly grants execution under the service user's OS permissions. A dedicated OS identity/container, stronger filesystem isolation, GPU admission, context-size preflight, per-node authentication and operator reconciliation UI remain production gates.

## Validation

`npm test -w @agent/node-agent` checks durable deduplication, fencing, single-slot admission, restart uncertainty, partial side effects, lease-loss abort, configuration, runtime ownership/arguments and path escapes. HTTP tests require loopback socket access. The workspace integration suite additionally exercises real Pi SDK streaming/tool calls against a fake local model and PostgreSQL backend, without paid calls or model downloads.

Managed-runtime smoke tests are opt-in. `RUN_NATIVE_RUNTIME_TESTS=1 npm test -w @agent/node-agent` launches a real local Node process from a checksummed temporary artifact, verifies readiness and warmup, then checks shutdown. `RUN_DOCKER_RUNTIME_TESTS=1 RUNTIME_SMOKE_IMAGE='node@sha256:<approved-local-digest>' npm test -w @agent/node-agent` requires an already provisioned Node image and Docker access; it checks loopback publication, read-only artifact mounting, adoption after journal loss, warmup and cleanup scoped to test-owned containers. Neither test downloads models or pulls images. These exercise lifecycle behavior with a synthetic HTTP model, not actual Gemma inference or GPU support.

## Browser terminals

The node brokers native PTYs independently of model readiness or coding-tool permissions. Run it as a non-root user on macOS or Linux. Install `tmux` on the node for persistent sessions (`brew install tmux` on macOS, or your Linux package manager). Without tmux, the UI offers an explicitly selected **Temporary** shell that ends on disconnect. `npm ci` installs node-pty; the root postinstall repairs the executable bit on its macOS spawn helper. Linux source builds require Python 3, make, and a C++ compiler; the Docker dependency stage supplies these.

| Setting                    | Default    | Meaning                                                                    |
| -------------------------- | ---------- | -------------------------------------------------------------------------- |
| `TERMINAL_ENABLED`         | `true`     | Set `false` to deny new sessions and attachments                           |
| `TERMINAL_MAX_SESSIONS`    | `8`        | Maximum live sessions across owners on this node (1–32)                    |
| `TERMINAL_IDLE_TIMEOUT_MS` | `1800000`  | Expire after this time without keyboard input, including detached sessions |
| `TERMINAL_MAX_LIFETIME_MS` | `86400000` | Absolute session lifetime; activity does not extend it                     |

The browser chooses a configured workspace ID or a registered project ID, never an OS username, executable, or arbitrary working directory. The shell uses the node service user's login-shell executable and a small environment allowlist. Service API keys and enrollment credentials are not injected. This is direct shell access with that user's OS permissions; the starting directory and model tool allowlist do not confine commands.

Each tmux session uses a generated name on a dedicated socket under the mode-0700 private node state directory. Session metadata is persisted with mode 0600; keystrokes and terminal output are not journaled. tmux keeps its own bounded in-memory screen history. Closing a view detaches the tmux client. **End session** kills the owned tmux session; it cannot guarantee termination of programs that daemonize. Idle and absolute expiry also terminate sessions. Temporary PTYs end on disconnect and cannot be taken over by another writer.

On node-agent restart, reconcile recorded tmux sessions only if the OS boot identity is unchanged and the private tmux session still exists. Unknown boot identity disables restart adoption. OS reboot or a missing server is reported as `lost`; an exited shell is reported as `ended`. No input is replayed. tmux persistence also depends on the service manager preserving its processes; configuring a unit to kill its whole process group ends these sessions. Container shells are labeled **Container shell** and survive only while that container and its tmux process survive. Unix socket paths at or above 100 bytes disable tmux mode; use a shorter `NODE_STATE_DIR` in that case.
