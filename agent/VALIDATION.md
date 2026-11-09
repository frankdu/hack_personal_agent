# Validation

Validated 2026-11-08 on macOS, Node 24.22.2, with Docker Desktop running Linux ARM64 containers.

| Check                           | Result                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace build/typecheck       | All four workspaces pass                                                                                                                                           |
| Unit/fixture suite              | Contracts, backend routing, frontend state and node behavior pass; optional integration tests skip without their opt-in variables                                  |
| `npm run test:integration`      | 10 tests pass, including nested PostgreSQL cases and actual Pi execution against a scripted local model                                                            |
| PostgreSQL behavior             | Audit before send, idempotency, concurrent revisions, fencing, heartbeat order, lost ACK, backend restart, SSE replay, unresolved outcomes                         |
| Full execution path             | Registration → route → committed audit/outbox → durable node acceptance → Pi streaming → persisted assistant response                                              |
| Real SDK tools/cancel           | Read tool roundtrip against a temporary workspace; cancellation of a running scripted response                                                                     |
| Node fixtures                   | Lease-loss abort, restart uncertainty, partial side effects, single-slot admission, runtime ownership, path traversal/symlink checks                               |
| Managed native runtime          | Actual child process, artifact checksum, HTTP identity/warmup, owned process shutdown                                                                              |
| Managed Docker runtime          | Actual pinned Node container, readonly artifact mount, loopback publication, warmup, adoption after journal loss, scoped cleanup preserving another test container |
| Protocol generation             | JSON Schema/OpenAPI regenerated; round-trip and version rejection fixtures pass                                                                                    |
| DEV/PROD Compose configuration  | Passed, including optional node                                                                                                                                    |
| Docker builds                   | Production frontend/backend/node and distinct development target built with `npm ci`                                                                               |
| Isolated PROD startup           | PostgreSQL/backend/frontend/node healthy; migrations and real node registration                                                                                    |
| Container HTTP checks           | Frontend SSR200, backend ready200, one online node; unconfigured node execution-ready503                                                                           |
| Browser interaction             | Attempted, but browser access host unavailable; hydration, interaction and visual review remain unverified                                                         |
| Dependency audit in image build | Production: zero reported findings. Development tree: six existing findings (2 low, 4 moderate)                                                                    |

HTTP tests require loopback access outside the execution sandbox; checks passed with that access. The new private-state guard initially rejected the test's state directory inside its tool workspace. The fixture now uses sibling directories and the full suite passes.

The scripted inference server exercises the actual Pi SDK and read tool. Managed-runtime smoke tests use a small synthetic HTTP server in a real process/container. Those tests do not validate real vLLM/CUDA or model quality. Separate local Ollama measurements are recorded below. Jev is mocked; no paid request was made. No model weights or inference images were downloaded. The already-used Node base was made available by its immutable digest for Docker smoke testing.

The frontend uses authenticated polling; backend SSE replay is independently tested. Canonical conversation history is text-only, not a portable tool checkpoint.

The integration script removes its disposable PostgreSQL container. The isolated Compose smoke project and its disposable volumes were removed, and managed-runtime tests stop/remove only their own resources. Unrelated services were untouched. Build caches/images and the ignored, mode-0600 local `.env` remain. The user's existing development stack remains running after the discovery changes.

## Ollama discovery and vLLM option

Validated on the live `frank-mbp.local` node (Apple M4 Pro, 48 GiB unified memory). All five Ollama models are published through the backend fleet API. Each eligible model received a warmup and two 128-token synthetic chat samples with thinking disabled. These are short-prompt decode rates under the observed machine load, excluding model loading/prefill; they do not guarantee speed for every future context or workload.

| Installed model        | Slower sample, tokens/s | Result                                                       |
| ---------------------- | ----------------------: | ------------------------------------------------------------ |
| `qwen3.6:latest`       |                    64.6 | Selected: largest total parameter count among passing models |
| `qwen3.6:35b-mlx`      |                    68.1 | Pass                                                         |
| `qwen3.8:27b-mlx`      |                    24.1 | Pass                                                         |
| `gemma4:31b-mlx`       |                    11.1 | Below 20 tokens/s                                            |
| `muse-glimmer:30b-mlx` |                       — | Outside Gemma 4/Qwen selection policy                        |

The selected model completed a no-tools, hosted-judgment-disabled backend → node → Pi → Ollama chat, returning `OK` with `succeeded` status. The live frontend's authenticated fleet API includes measurements and selection reasons. Browser access remains unavailable, so visual interaction was not verified.

Workspace production build/typechecks and unit/fixture suites passed. The final node suite passes all 26 tests with both native and Docker smoke flags enabled; the full PostgreSQL/backend/Pi integration suite passes all 10 checks. Discovery coverage includes speed boundary/slower-sample enforcement, capacity ranking, exclusions, persistence/digest/version invalidation, idle refresh, manual override, endpoint fallback, explicit-manifest precedence and cancellation during benchmarking/runtime warmup. vLLM configuration coverage checks model-directory integrity, shared-memory bounds, GPU arguments and rejection of incompatible hardware. Actual vLLM/CUDA inference was not run on this Mac; its ordinary Docker containers have no Metal GPU access.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for remaining acceptance gates. Runtime smoke commands are in the [node README](apps/node-agent/README.md).

## Browser terminal verification (2026-11-08)

Implemented in the isolated `feature/browser-terminal` worktree. `npm run check` passed formatting, production builds, typechecks, and 82 unit/fixture tests (17 environment-gated cases skipped in that run). The eight node terminal tests used real node-pty shells and a privately compiled tmux 3.5a in `/private/tmp`; no system tmux installation was changed. `npm run test:integration` passed all 17 integration cases using a disposable PostgreSQL container, including the terminal scenario alongside existing backend/Pi tests.

Terminal evidence covers real input/output and `stty` resize, configured workspace cwd, owner and lease denial, idempotent creation, session limits, idle expiry, slow-reader disconnect, tmux screen/command survival after detach, explicit writer takeover, node-agent restart adoption, broker-side End, Origin binding, single-use and expired tickets, operator/node token separation, client-ticket revocation, metadata-only audit, lease-driven disconnect, and durable offline termination through backend restart. Temporary PTYs terminate on detach. No hosted judgment or inference API was called.

A Chrome smoke test against a separate loopback-only backend/node/frontend and disposable database created a tmux session from **My cloud → Open terminal**, printed `BROWSER_TERMINAL_OK`, and restored that output after detaching and reconnecting. The node had no inference profiles and no model tools. The UI labels host scope, OS user, persistence and expiry. The macOS node-pty helper executable-bit issue was reproduced and repaired with the root postinstall script. Browser smoke resources were separate from the existing development services.

Linux host/service-unit certification, actual OS reboot, container restart policy and remote TLS proxy deployment still require target-environment validation. The terminal remains within the existing single trusted operator/shared node credential boundary.
