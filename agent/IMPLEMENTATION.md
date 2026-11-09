# Implementation status

Updated 2026-11-08. This is the first working colocated milestone, not completion of all acceptance criteria in the [research backlog](research-docs/implementation-tasks.md).

The [node services and browser terminal refinement](SYSTEM_DESIGN.md) is design-only in this update. Independent serving enablement, authenticated Codex/Claude discovery and execution, the Gemma 4 deployment picker, and browser PTY/tmux are not implemented. Current automatic Ollama selection and manifest startup remain in place until the migration tasks land.

| Area                  | Implemented                                                                                                                                                                     | Remaining                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| T01 protocol          | Strict versioned schemas/types, JSON Schema/OpenAPI generation, round-trip/rejection tests                                                                                      | Generated client package, evolution fixtures                                                   |
| T02–T03 foundation    | PostgreSQL migration/transactions, separate bearer scopes, bounded requests, readiness/shutdown                                                                                 | Upgrade fixtures, credential lifecycle, production hardening                                   |
| T04 inventory         | CPU/memory, GPU probes, cgroup-v2 limits, Docker host/VM observation                                                                                                            | Real Linux/NVIDIA fixtures, periodic sleep/wake reprobes                                       |
| T05 model catalog     | Ollama inventory, Gemma 4/Qwen selection by parameter count and two measured >=20 tokens/s samples, cached measurements; manifest overrides with artifact checksum/pinned image | Shared downloadable catalog, measured RAM/VRAM/KV budgets, cross-family quality ranking        |
| T06 policy            | Tools default off, task/node subset checks, workspace checks, isolated Pi resources                                                                                             | OS isolation and hostile concurrent filesystem mutation protection                             |
| T07–T08 fleet         | Stable ID, boot generation, ordered heartbeat leases, endpoint allowlist, offline/retry                                                                                         | Single-use enrollment, rotation/revocation, metadata reprobes, clock-skew handling             |
| T09/T25 runtime       | Native/Docker/external adapters, probe/warm lifecycle, bounded recovery, explicit provisioning, optional Linux/NVIDIA vLLM Docker manifest with model-directory verification    | Real vLLM/CUDA smoke, CPU/GPU certification, OOM downgrade, full resource scheduling           |
| T10/T15 execution     | Actual Pi SDK, cumulative streams, durable acceptance/tool journal, digest dedupe, lease/scope/deadline checks, cancel, unknown recovery                                        | Authoritative tool-history/checkpoint resume, operator resolution of unknown outcomes          |
| T12–T14 routing/audit | Validated Jev REST, bounded concurrency/timeout, hard filters, manual/sole placement, permitted rules fallback, atomic audit/outbox                                             | Sticky-route optimization, latency/cost calibration, adaptive outcomes, credentialed Jev smoke |
| T16–T18 dispatch/chat | Canonical text history, revision/idempotency, durable SSE replay, same-attempt reconciliation, cancel                                                                           | Retention snapshots, canonical tool checkpoints, multi-user access, longer failure soak        |
| T19–T21 frontend      | Real fleet/chat/pins, policies, explanations, authenticated cumulative polling, resume by ID, discovered models/speed/selection reasons                                         | Browser SSE subscription, browser interaction and model quality validation                     |
| T22 evaluation        | Local scripted model/real Pi integration, database failure tests, node fixtures                                                                                                 | Hardware latency/quality report, database crash/restore, model OOM                             |
| T23 operations        | DEV/PROD Compose with backend, native setup, deployment docs/builds                                                                                                             | TLS, service units, per-node credentials, backup/restore, release image digests                |
| T24 split placement   | First milestone colocates inference/tools                                                                                                                                       | Separate placement and artifact authorization deferred                                         |

## Operating limits

One trusted operator and one shared node credential per fleet are supported. Nodes in that trust boundary can authenticate as fleet nodes. The endpoint allowlist limits dispatch destinations; it is not per-node identity authentication.

Each node accepts one active attempt. Unresolved outcomes block new work until reconciled; possibly executed writes are never silently retried on another node. Unresolved journals are retained for investigation.

Each task reconstructs conversation text in a new Pi session. Local session files and tool journals persist, but canonical tool-call/result migration across nodes is not implemented. Context admission uses a conservative character estimate, not a model tokenizer.

Jev is implemented and mocked in tests. Cloud latency and routing quality remain unmeasured. Local Gemma 4/Qwen short-prompt generation was measured on an M4 Pro; see `VALIDATION.md`. Manual/sole placements do not need hosted judgment.

## Next dependency-ready work

1. Complete T05 with approved Gemma artifacts and measured profiles; validate T09/T25 on target Mac/Linux hardware.
2. Complete per-node enrollment/revocation (T07) before expanding the trust boundary.
3. Add canonical tool checkpoints and unknown-outcome operator resolution (T10/T15/T17/T18).
4. Run browser and real Jev/Gemma evaluations (T21/T22), then operations gates (T23).
5. Implement split inference/tool placement (T24) after colocated acceptance.
