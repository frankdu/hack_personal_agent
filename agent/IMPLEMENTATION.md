# Implementation status

Updated 2026-11-08. This is the first working colocated milestone, not completion of all acceptance criteria in the [research backlog](research-docs/implementation-tasks.md).

| Area | Implemented | Remaining |
|---|---|---|
| T01 protocol | Strict versioned schemas/types, JSON Schema/OpenAPI generation, round-trip/rejection tests | Generated client package, evolution fixtures |
| T02–T03 foundation | PostgreSQL migration/transactions, separate bearer scopes, bounded requests, readiness/shutdown | Upgrade fixtures, credential lifecycle, production hardening |
| T04 inventory | CPU/memory, GPU probes, cgroup-v2 limits, Docker host/VM observation | Real Linux/NVIDIA fixtures, periodic sleep/wake reprobes |
| T05 model catalog | Operator manifests with artifact checksum, pinned image, explicit memory estimate | Shared Gemma catalog, automatic selection, measured RAM/VRAM/KV budgets |
| T06 policy | Tools default off, task/node subset checks, workspace checks, isolated Pi resources | OS isolation and hostile concurrent filesystem mutation protection |
| T07–T08 fleet | Stable ID, boot generation, ordered heartbeat leases, endpoint allowlist, offline/retry | Single-use enrollment, rotation/revocation, metadata reprobes, clock-skew handling |
| T09/T25 runtime | Native/Docker/external adapters, probe/warm lifecycle, bounded recovery, explicit provisioning | Real Gemma CPU/Metal/CUDA smoke, OOM downgrade, full resource scheduling |
| T10/T15 execution | Actual Pi SDK, cumulative streams, durable acceptance/tool journal, digest dedupe, lease/scope/deadline checks, cancel, unknown recovery | Authoritative tool-history/checkpoint resume, operator resolution of unknown outcomes |
| T12–T14 routing/audit | Validated Jev REST, bounded concurrency/timeout, hard filters, manual/sole placement, permitted rules fallback, atomic audit/outbox | Sticky-route optimization, latency/cost calibration, adaptive outcomes, credentialed Jev smoke |
| T16–T18 dispatch/chat | Canonical text history, revision/idempotency, durable SSE replay, same-attempt reconciliation, cancel | Retention snapshots, canonical tool checkpoints, multi-user access, longer failure soak |
| T19–T21 frontend | Real fleet/chat/pins, policies, explanations, authenticated cumulative polling, resume by ID | Browser SSE subscription, browser interaction and real Gemma validation |
| T22 evaluation | Local scripted model/real Pi integration, database failure tests, node fixtures | Hardware latency/quality report, database crash/restore, model OOM |
| T23 operations | DEV/PROD Compose with backend, native setup, deployment docs/builds | TLS, service units, per-node credentials, backup/restore, release image digests |
| T24 split placement | First milestone colocates inference/tools | Separate placement and artifact authorization deferred |

## Operating limits

One trusted operator and one shared node credential per fleet are supported. Nodes in that trust boundary can authenticate as fleet nodes. The endpoint allowlist limits dispatch destinations; it is not per-node identity authentication.

Each node accepts one active attempt. Unresolved outcomes block new work until reconciled; possibly executed writes are never silently retried on another node. Unresolved journals are retained for investigation.

Each task reconstructs conversation text in a new Pi session. Local session files and tool journals persist, but canonical tool-call/result migration across nodes is not implemented. Context admission uses a conservative character estimate, not a model tokenizer.

Jev is implemented and mocked in tests. Cloud latency, routing quality and actual Gemma throughput remain unmeasured. Manual/sole placements do not need hosted judgment.

## Next dependency-ready work

1. Complete T05 with approved Gemma artifacts and measured profiles; validate T09/T25 on target Mac/Linux hardware.
2. Complete per-node enrollment/revocation (T07) before expanding the trust boundary.
3. Add canonical tool checkpoints and unknown-outcome operator resolution (T10/T15/T17/T18).
4. Run browser and real Jev/Gemma evaluations (T21/T22), then operations gates (T23).
5. Implement split inference/tool placement (T24) after colocated acceptance.
