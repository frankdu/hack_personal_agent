# Working context

The main working directory is `agent/`. The first colocated implementation is installed and passes build/typecheck/integration checks. Follow `research-docs/` for design and dependencies.

## Latest design refinement

The [node services and terminal design](SYSTEM_DESIGN.md) supersedes older deployment assumptions below: always-on control/discovery/shell, optional inference, authenticated Codex/Claude models, externally owned Ollama/vLLM, explicit NVIDIA-only Gemma 4 deployments, and browser PTY/tmux. Browser terminal work T28/T30 now exists: node-pty/tmux, authenticated WebSocket relay, durable metadata/end intent, and xterm.js fleet controls. T26/T27/T29 provider/service/deployment work remains planned. See IMPLEMENTATION.md and the app READMEs.

## Prior milestone decisions (implementation baseline)

- Jev from TypeSafe AI is the only intelligent routing provider for the initial milestone. Deterministic eligibility, manual pins and safe fallbacks remain backend responsibilities.
- TypeScript backend, PostgreSQL audit/outbox, React/TanStack Start frontend, persistent Pi SDK node agents.
- Nodes run on macOS and Linux CPU/NVIDIA hosts. Nodes own native processes or Docker inference containers, resource admission, readiness and recovery. Native macOS is the Metal path.
- Discover installed Ollama models by default; select the largest Gemma 4/Qwen passing two local >=20 tokens/s generation samples, with an optional priority override. Artifacts/images require explicit provisioning; do not download models or call paid APIs automatically. `RUNTIME_CONFIG` overrides discovery, including opt-in vLLM Docker on Linux/NVIDIA.
- Tools default to disabled. Routing cannot grant tools. Persist a decision before dispatch; never automatically replay an uncertain side effect.
- Parallel subagent work was authorized. One owner per directory; the integration owner controls shared contracts, root manifests and lockfile.

## Current implementation session

The first colocated implementation now exists: versioned contracts, PostgreSQL backend/audit/outbox, Jev adapter, node enrollment/runtime supervision/durable Pi executor, and real frontend polling. Ollama discovery now publishes installed models and speed/selection evidence in fleet profiles. Local Gemma 4/Qwen benchmarks ran on the user's M4 Pro; `qwen3.6:latest` was selected at 64.6 tokens/s and completed a real backend/Pi chat smoke test. Jev remains mocked; no paid call was made. The user's existing dev stack remains running. Root `.env` contains private credentials. Use `README.md` for startup and the node README for discovery/vLLM options.

Read `VALIDATION.md` and `research-docs/implementation-tasks.md` for the latest measured status. Do not treat the presence of a module as completion of every acceptance criterion.
