# Node agent

Persistent Node 24 service embedding `@earendil-works/pi-coding-agent` 1.5.0. It enrolls with the backend, supervises one configured local model runtime, and executes one task at a time. It supports native macOS/Linux and Docker deployment; macOS Metal requires a native service.

From the workspace root, run `npm run dev:node`. Build with `npm run build -w @agent/node-agent` after building shared contracts. `src/app.ts` exports `startNode(config)` for integration tests; the returned `close()` drains execution, enrollment, runtime and HTTP resources.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODE` | `DEV` | Exactly `DEV` or `PROD` |
| `HOST`, `PORT` | `127.0.0.1`, `3101` | HTTP listener; container uses `HOST=0.0.0.0` |
| `NODE_NAME` | OS hostname | Display name; durable UUID lives under the state directory |
| `NODE_STATE_DIR` | `.state/node-agent` | Private identity, execution journal, SDK sessions and runtime records |
| `AGENT_WORKSPACE_DIR` | Process cwd | Approved workspace root, canonicalized at startup |
| `WORKSPACE_ID` | `default` | Public workspace identifier |
| `ENABLED_TOOLS` | Empty | Comma-separated subset of `read,bash,edit,write,grep,find,ls` |
| `BACKEND_URL` | Unset | Backend HTTP(S) origin; without it the node remains unregistered |
| `NODE_ENDPOINT` | `http://127.0.0.1:3101` | Advertised origin; must match backend operator allowlist |
| `NODE_SHARED_TOKEN` | Unset | Shared initial bearer credential, at least 32 characters when enrolled |
| `RUNTIME_CONFIG` | Unset | Operator-controlled local runtime manifest JSON path |
| `MODEL_PROVIDER`, `MODEL_ID` | Unset | Legacy paired model selector; runtime manifest is authoritative for served model identity, provider can override the local SDK provider name |

Keep state outside the tool workspace. Do not mount a Docker socket or provider credentials into the workspace. This release has a shared provisioning credential; per-node credentials and mTLS remain production work.

## Local runtime configuration

The runtime is explicitly operator selected; discovery does not automatically download or launch a model. Example for an already running local OpenAI-compatible Gemma server:

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
    "args": ["--model", "/absolute/path/to/model.gguf", "--host", "127.0.0.1", "--port", "8080"],
    "artifactPath": "/absolute/path/to/model.gguf",
    "artifactSha256": "REPLACE_WITH_REAL_SHA256"
  }
}
```

This fragment is not a valid launch manifest until supplied with a real checksum and the common fields. The artifact is hashed before launch; the operator approves the executable and argument array. No shell interprets launch arguments. Native runtimes cannot be adopted after a crash: an occupied port is rejected, and the service never kills an arbitrary previous PID.

Docker profiles add `docker.image` pinned as `repository@sha256:...`, `command` array, `containerPort`, `artifactPath`, `artifactSha256`, `modelMountPath`, `memoryBytes`, `cpus`, and optional `gpus` (`all` or `device=0`). The image must already exist (`--pull=never`). Model artifact mounts are read-only, host publication is loopback, and container name plus labels include the owning node/profile and manifest digest. Reconciliation can adopt an owned matching container even if a crash preceded its journal commit; ownership or image mismatch prevents adoption/removal. No global prune is used. Current Docker management assumes the service and Docker daemon share host path and loopback namespaces; Docker Desktop or a containerized controller needs explicit operator topology work before managed sibling-container use.

Runtime health probes run periodically. Recovery has bounded attempts with exponential delay. Shutdown serializes against startup/recovery. A failed runtime aborts current work; uncertain attempts are never automatically replayed.

## Execution protocol

- `GET /health/live`: process availability.
- `GET /health/ready`: 200 only with a current enrollment lease, warm runtime, free execution slot and no unresolved unknown attempt.
- `GET /v1/node/status`: public descriptive status; no credentials or local paths.
- `POST /v1/executions`: authenticated shared-contract envelope; returns a bare snapshot and 202 after durable acceptance.
- `GET /v1/executions/:attemptId`: authenticated snapshot polling.
- `POST /v1/executions/:attemptId/cancel`: authenticated cancellation, returning only after execution settles.

Registration is `POST /v1/nodes/register`; renewals use `POST /v1/nodes/:nodeId/heartbeats`. Expired/fenced leases cannot authorize new execution or tool calls. Once a process has received a lease, it does not self-register to steal ownership after fencing; restart it to request enrollment deliberately.

Each attempt verifies its canonical SHA256 digest, node/boot/generation, deadline, workspace, profile and task-tool subset. Same ID/digest returns the existing result; a changed digest is rejected. The journal uses atomic rename and fsync before acknowledgement or tool execution. Restart converts unfinished work to `unknown`, preserving partial output without replay. Unknown attempts consume advertised capacity until operator reconciliation. A side-effecting tool exception/abort is uncertain even if the agent catches it; it cannot become a false success. A completed nonzero exit or structured error result is journaled as a `failed` tool invocation and returned to the agent so it can continue reasoning; this known outcome does not imply rollback. Duplicate invocation IDs are never replayed.

Pi sessions use the explicitly registered local model, disabled ambient extensions/skills, the exact per-task tool subset, a fresh persisted session with restored textual conversation history, and no automatic retry. Streaming output is journaled cumulatively. Tool invocations record input digest and lifecycle state without storing raw arguments in the journal.

Filesystem tool paths are checked for traversal and symlink escapes. This is not an OS sandbox and cannot prevent races caused by concurrent filesystem mutation. `bash` explicitly grants execution under the service user's OS permissions. A dedicated OS identity/container, stronger filesystem isolation, GPU admission, context-size preflight, per-node authentication and operator reconciliation UI remain production gates.

## Validation

`npm test -w @agent/node-agent` checks durable deduplication, fencing, single-slot admission, restart uncertainty, partial side effects, lease-loss abort, configuration, runtime ownership/arguments and path escapes. HTTP tests require loopback socket access. The workspace integration suite additionally exercises real Pi SDK streaming/tool calls against a fake local model and PostgreSQL backend, without paid calls or model downloads.

Managed-runtime smoke tests are opt-in. `RUN_NATIVE_RUNTIME_TESTS=1 npm test -w @agent/node-agent` launches a real local Node process from a checksummed temporary artifact, verifies readiness and warmup, then checks shutdown. `RUN_DOCKER_RUNTIME_TESTS=1 RUNTIME_SMOKE_IMAGE='node@sha256:<approved-local-digest>' npm test -w @agent/node-agent` requires an already provisioned Node image and Docker access; it checks loopback publication, read-only artifact mounting, adoption after journal loss, warmup and cleanup scoped to test-owned containers. Neither test downloads models or pulls images. These exercise lifecycle behavior with a synthetic HTTP model, not actual Gemma inference or GPU support.
