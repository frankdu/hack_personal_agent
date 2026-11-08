# Personal agent workspace

An npm workspace for a unified agent UI and persistent per-machine Pi service.

## What exists

| Path | Current scope |
|---|---|
| `apps/agent-frontend` | React, TanStack Start/Query, Vite, Tailwind and shadcn foundation; honest disconnected chat/node UI |
| `apps/node-agent` | Persistent HTTP service, liveness/readiness, CPU/memory inspection, explicit tool configuration, lazy Pi SDK session adapter |
| `packages/contracts` | Shared deployment mode, tool names, routing preference schemas |
| `compose.yaml` | PROD images plus PostgreSQL and optional containerized node |
| `compose.dev.yaml` | DEV source watching and local PostgreSQL port |

The backend, node registration/heartbeats, real chat dispatch, GPU probing, Gemma runtime supervision and decision audit database migrations are **planned, not implemented**. PostgreSQL is provisioned for that work; no application writes to it yet. Node readiness deliberately returns 503 until execution support exists. No models download and no model API calls occur on startup.

## Native development

Requires Node 24 (see `.nvmrc`) and npm 11. Exact application dependencies are pinned and the root lockfile is authoritative.

```sh
cd agent
npm ci
npm run dev
```

Frontend: http://localhost:3000. Node liveness: http://127.0.0.1:3101/health/live. Run just one app with `npm run dev:frontend` or `npm run dev:node`. Stop watch processes with Ctrl-C.

Node configuration is read from the process environment. See [node-agent configuration](apps/node-agent/README.md). A native example with an explicit workspace is:

```sh
MODE=DEV AGENT_WORKSPACE_DIR=/absolute/path/to/project npm run dev:node
```

Tools are disabled by default. Setting a working directory is not filesystem isolation. Do not enable shell/write tools for untrusted tasks until the execution isolation task is implemented.

## Docker Compose

Copy `.env.example` to `.env` and replace `POSTGRES_PASSWORD`. This file is ignored by Git and excluded from Docker build context. Both commands below run from `agent/`.

### DEV

```sh
cp .env.example .env
# Edit POSTGRES_PASSWORD in .env.
npm run compose:dev
```

This starts the frontend with hot reload and PostgreSQL. To also run the CPU-only node scaffold in a container:

```sh
docker compose -f compose.yaml -f compose.dev.yaml --profile node up --build
```

Source directories are bind-mounted for watching. Dependency and build-config changes require rebuilding the development image. Keep the macOS node service native (`npm run dev:node`) when using Apple Metal in the future: Docker Desktop's ordinary Linux containers do not provide native Metal to this process.

For a native frontend and node with only PostgreSQL containerized:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres
npm run dev
```

### PROD

```sh
npm run compose:prod
# Optional Linux CPU node scaffold:
docker compose -f compose.yaml --profile node up --build -d
```

PROD uses compiled frontend/server output, `NODE_ENV=production`, `MODE=PROD`, non-root application users, persistent volumes, process init and restart policies. DEV overrides select `MODE=DEV`, development dependencies and source watchers. MODE is an application setting distinct from Vite's own mode and NODE_ENV; use the matching Compose files, not only an environment flag, to select a deployment.

The frontend and node publish to loopback by default; PostgreSQL has no published port in PROD. Put an authenticated HTTPS ingress in front of the future backend/frontend for remote access. `FRONTEND_BIND` can change the bind address explicitly. This deploys the scaffold, not a completed multi-node agent product.

The optional containerized node stores state in `/data` and operates in `/work`; it does not mount the host filesystem or Docker socket. NVIDIA runtime provisioning and specific Gemma images are future tasks, rather than a GPU flag on an image with no inference runtime. PostgreSQL 18 data is mounted at `/var/lib/postgresql`, matching its image layout.

```sh
# Validate without starting services (requires POSTGRES_PASSWORD in .env).
docker compose -f compose.yaml --profile node config --quiet
docker compose -f compose.yaml -f compose.dev.yaml --profile node config --quiet

# Stop services; retain data volumes.
docker compose -f compose.yaml --profile node down
```

## Verification

```sh
npm run check
```

Build runs shared packages before the services. TanStack Start generates its route tree during the frontend build. Node tests cover configuration rejection, disabled-by-default tools, readiness semantics and service endpoints without invoking an LLM.

The TanStack production adapter currently uses the registry's Nitro release candidate; its exact version is pinned in the frontend manifest and lockfile. See the frontend README for adding shadcn components and its server output layout.

See [validation results](VALIDATION.md) for completed checks and remaining coverage.

## Parallel implementation

Start with the [research index](research-docs/README.md), then dispatch the dependency-ready tasks in the implementation backlog. File ownership, prerequisites, deliverables and acceptance criteria belong with each task. Do not assign multiple agents to change the root lockfile concurrently: let one integration owner install dependencies and validate the combined result.
