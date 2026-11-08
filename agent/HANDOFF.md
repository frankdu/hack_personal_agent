# Working context

The main working directory is `agent/`. The first colocated implementation is installed and passes build/typecheck/integration checks. Follow `research-docs/` for design and dependencies.

## Accepted decisions

- Jev from TypeSafe AI is the only intelligent routing provider for the initial milestone. Deterministic eligibility, manual pins and safe fallbacks remain backend responsibilities.
- TypeScript backend, PostgreSQL audit/outbox, React/TanStack Start frontend, persistent Pi SDK node agents.
- Nodes run on macOS and Linux CPU/NVIDIA hosts. Nodes own native processes or Docker inference containers, resource admission, readiness and recovery. Native macOS is the Metal path.
- Gemma 4 is preferred. Artifacts/images require operator approval and explicit provisioning; do not download models or call paid APIs automatically.
- Tools default to disabled. Routing cannot grant tools. Persist a decision before dispatch; never automatically replay an uncertain side effect.
- Parallel subagent work was authorized. One owner per directory; the integration owner controls shared contracts, root manifests and lockfile.

## Current implementation session

The first colocated implementation now exists: versioned contracts, PostgreSQL backend/audit/outbox, Jev adapter, node enrollment/runtime supervision/durable Pi executor, and real frontend polling. Local integration uses actual Pi and a scripted OpenAI-compatible endpoint; no real Gemma or paid Jev call has been made. Root `.env` was generated with private random credentials; services are not intended to remain running after validation. Use `README.md` for startup.

Read `VALIDATION.md` and `research-docs/implementation-tasks.md` for the latest measured status. Do not treat the presence of a module as completion of every acceptance criterion.
