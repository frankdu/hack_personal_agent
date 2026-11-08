# Curilo Agent workspace

Work from this directory (`agent/`). [HANDOFF.md](HANDOFF.md) preserves the compact project context. The [research documents](research-docs/README.md) describe the target system; [IMPLEMENTATION.md](IMPLEMENTATION.md) tracks implemented behavior and remaining acceptance work.

## Implemented path

The React UI connects to a TypeScript backend, discovers nodes, submits chat with automatic or manual routing, displays the routing reason, and polls durable output. PostgreSQL commits the task, decision and outbox before dispatch. Each node journals acceptance before invoking the actual Pi SDK. Repeated request keys and execution IDs do not create another run. Unknown outcomes hold the conversation for reconciliation.

Jev is the only routing judgment model. Hard eligibility checks, explicit pins and sole eligible placements run without an API call. Hosted judgments require `JEV_API_KEY` and the task's permission; deterministic fallback is separately configurable. Health probes never call Jev.

Nodes inspect hardware and Docker availability. Without a runtime manifest, they discover installed Ollama models and automatically select the highest ranked eligible model measured at 20 tokens/second or better, with no family restriction. Any downloaded local model can also be activated manually, including slower models. An explicit manifest overrides discovery and selects a local external endpoint, native process, or Docker inference container, including vLLM on Linux/NVIDIA. Nodes probe, warm and manage runtime lifecycle. No model or inference image is downloaded automatically.

| Path                  | Responsibility                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- |
| `apps/agent-backend`  | Fleet leases, Jev, conversations, PostgreSQL audit/outbox, dispatch/reconciliation |
| `apps/node-agent`     | Hardware inventory, runtime supervision, execution/tool journal and Pi SDK         |
| `apps/agent-frontend` | Connection, fleet, chat, pinning, cancellation and routing explanations            |
| `packages/contracts`  | Runtime schemas, TypeScript types, generated JSON Schema/OpenAPI                   |
| `tests/integration`   | Actual backend/node/Pi against a scripted local inference endpoint                 |

## Native development

Requires Node 24, npm 11 and Docker for PostgreSQL. Dependencies are pinned in the root lockfile.

```sh
cd agent
npm ci
npm run setup:local
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres18
npm run dev
```

`setup:local` creates an ignored, mode-0600 `.env` with distinct random user/node tokens; it preserves an existing file. Initial ports: frontend **3300**, backend **3100**, node **3101**, PostgreSQL **55432**. These avoid the common 3000/5432 ports already occupied by other local projects. Adjust conflicting ports and `FRONTEND_ORIGINS` together.

Open http://localhost:3300. In the connection form use backend `http://127.0.0.1:3100` and the `API_TOKEN` from your local `.env`. The browser keeps the token in memory; reconnect after refresh. The backend currently serves one trusted operator.

Start Ollama locally with downloaded models. Without `RUNTIME_CONFIG`, the node automatically discovers them, runs bounded synthetic generation benchmarks, and selects the largest parameter count meeting the 20 tokens/second minimum in both samples. The page shows all installed models, measured speeds, selection and exclusion reasons. Benchmarks run while idle, cache for six hours, and never download models or use cloud inference. If no model qualifies for automatic selection, activate a downloaded model manually from its node card. In the composer, Auto model permits any ready model; a specific model limits routing to nodes with that exact model active and ready. One matching node routes directly without Jev. See [node configuration](apps/node-agent/README.md) for ranking overrides, benchmark settings and the optional managed vLLM Docker runtime. An explicit `RUNTIME_CONFIG` takes precedence over discovery.

Set `AGENT_WORKSPACE_DIR` to the project, `NODE_STATE_DIR` to a private directory outside that workspace, and `ENABLED_TOOLS` to allowed tool names. Both the node and each task must allow a tool. Tools default to empty. File paths are checked against the workspace; enabling `bash` grants the service user's shell permissions and is not an OS sandbox.

`npm run dev:backend` and `npm run dev:node` load `.env` independently. `npm run dev:frontend` starts only Vite; pass `FRONTEND_PORT=3300` when running it separately. Migrations run at backend startup under an advisory lock, or explicitly with `npm run db:migrate`. Set `AUTO_MIGRATE=false` after applying them separately if deployment roles require it.

Run the macOS node natively for Metal. To connect a containerized backend to a native node, use `NODE_ENDPOINT=http://host.docker.internal:3101` and bind the node's `HOST=0.0.0.0` on a trusted development network. That endpoint must be in the backend allowlist.

## Docker Compose

```sh
# DEV: backend/frontend source watching plus PostgreSQL
npm run compose:dev

# PROD mode: compiled servers plus PostgreSQL
npm run compose:prod

# Optional node; starts without a model by default
docker compose -f compose.yaml --profile node up --build -d
```

These configurations select `MODE=DEV` or `MODE=PROD` separately from `NODE_ENV`. PROD means compiled deployment mode; production acceptance gates are still open. Published application ports bind to loopback. PostgreSQL is published only in DEV. Changes outside mounted source directories require a rebuild.

The optional node persists `/data` and `/work`. It receives no host Docker socket, workspace or inference manifest automatically. For Docker-managed inference, start with a native node and operator-provisioned Docker CLI/daemon access. Images must already exist locally at immutable digests; model files require a matching SHA-256. Mount paths refer to the daemon host. Configure NVIDIA devices explicitly on suitable Linux hardware. The initial adapter does not manage remote Docker daemons.

Before remote production access, complete TLS, per-node enrollment, ingress and recovery work. Shared fleet credentials and one operator are the current scope.

```sh
docker compose -f compose.yaml --profile node config --quiet
docker compose -f compose.yaml -f compose.dev.yaml --profile node config --quiet
docker compose -f compose.yaml --profile node down
```

`down` retains working data volumes.

## Formatting

Prettier is configured at the workspace root using its default style. Run these commands from this directory to format source code and documentation or check formatting:

```sh
npm run format
npm run format:check
```

Generated files, build output and ignored local files are excluded.

## Verification

```sh
npm run check
npm run test:integration
npm run protocol:generate
```

`check` checks formatting, builds, typechecks and runs unit/fixture tests. Database tests skip there unless `TEST_DATABASE_URL` is provided. `test:integration` creates its own disposable PostgreSQL container on an ephemeral port, runs database failure tests and the real Pi execution path, then removes that container. It does not use an existing database or download a model. Scripted inference proves transport, SDK, tool and cancellation behavior, not Gemma quality/performance.

See [VALIDATION.md](VALIDATION.md) for measured results. Commit generated protocol files alongside schema changes.
