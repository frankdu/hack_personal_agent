# Validation

Validated 2026-11-08 on macOS, Node 24.22.2, with Docker Desktop running Linux ARM64 containers.

| Check | Result |
|---|---|
| Workspace build/typecheck | All four workspaces pass |
| Unit/fixture suite | Contracts, backend routing, frontend state and node behavior pass; optional integration tests skip without their opt-in variables |
| `npm run test:integration` | 10 tests pass, including nested PostgreSQL cases and actual Pi execution against a scripted local model |
| PostgreSQL behavior | Audit before send, idempotency, concurrent revisions, fencing, heartbeat order, lost ACK, backend restart, SSE replay, unresolved outcomes |
| Full execution path | Registration → route → committed audit/outbox → durable node acceptance → Pi streaming → persisted assistant response |
| Real SDK tools/cancel | Read tool roundtrip against a temporary workspace; cancellation of a running scripted response |
| Node fixtures | Lease-loss abort, restart uncertainty, partial side effects, single-slot admission, runtime ownership, path traversal/symlink checks |
| Managed native runtime | Actual child process, artifact checksum, HTTP identity/warmup, owned process shutdown |
| Managed Docker runtime | Actual pinned Node container, readonly artifact mount, loopback publication, warmup, adoption after journal loss, scoped cleanup preserving another test container |
| Protocol generation | JSON Schema/OpenAPI regenerated; round-trip and version rejection fixtures pass |
| DEV/PROD Compose configuration | Passed, including optional node |
| Docker builds | Production frontend/backend/node and distinct development target built with `npm ci` |
| Isolated PROD startup | PostgreSQL/backend/frontend/node healthy; migrations and real node registration |
| Container HTTP checks | Frontend SSR200, backend ready200, one online node; unconfigured node execution-ready503 |
| Browser interaction | Attempted, but browser access host unavailable; hydration, interaction and visual review remain unverified |
| Dependency audit in image build | Production: zero reported findings. Development tree: six existing findings (2 low, 4 moderate) |

HTTP tests require loopback access outside the execution sandbox; checks passed with that access. The new private-state guard initially rejected the test's state directory inside its tool workspace. The fixture now uses sibling directories and the full suite passes.

The scripted inference server exercises the actual Pi SDK and read tool. Managed-runtime smoke tests use a small synthetic HTTP server in a real process/container. Neither validates Gemma quality, throughput, context accounting or GPU compatibility. Jev is mocked; no paid request was made. No model weights or inference images were downloaded. The already-used Node base was made available by its immutable digest for Docker smoke testing.

The frontend uses authenticated polling; backend SSE replay is independently tested. Canonical conversation history is text-only, not a portable tool checkpoint.

The integration script removes its disposable PostgreSQL container. The isolated Compose smoke project and its disposable volumes were removed, and managed-runtime tests stop/remove only their own resources. Unrelated services were untouched. Build caches/images and the ignored, mode-0600 local `.env` remain; no development stack is intentionally left running.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for remaining acceptance gates. Runtime smoke commands are in the [node README](apps/node-agent/README.md).
