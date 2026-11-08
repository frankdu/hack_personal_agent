# Node agent service

Persistent Node 24 service scaffold using `@earendil-works/pi-coding-agent` 1.5.0, resolved from npm on November 7, 2026. Run from the workspace with `npm run dev --workspace @agent/node-agent`.

Implemented: explicit configuration validation, CPU/memory observations, liveness endpoint, truthful readiness status, graceful shutdown, and a lazy SDK session factory with persistent session files and an explicit tool allowlist. No inference calls occur at startup.

The API dispatch, backend enrollment and heartbeats, GPU discovery, Gemma runtime supervision, warmup, and recovery are future work in `../../research-docs`. This scaffold is **not yet an executor**: `/health/ready` returns 503 until that work lands. Container health checks should use `/health/live`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODE` | `DEV` | Exactly `DEV` or `PROD` |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` inside a container |
| `PORT` | `3101` | Health/status server port |
| `NODE_NAME` | OS hostname | Display name, not an authenticated node ID |
| `NODE_STATE_DIR` | `.state/node-agent` relative to process cwd | Isolated SDK auth, model catalog and session directory |
| `AGENT_WORKSPACE_DIR` | Process cwd | Directory for built-in tools |
| `ENABLED_TOOLS` | Empty | Comma-separated subset of `read,bash,edit,write,grep,find,ls` |
| `MODEL_PROVIDER`, `MODEL_ID` | Unset | Both required before the SDK factory can create sessions |

`PiSessions.create()` resolves only the configured model; it does not choose an arbitrary provider. Configure local endpoints through Pi's `models.json` under `NODE_STATE_DIR`. The factory disables ambient resource discovery and automatic agent retries. Callers must release sessions. No public prompt route is exposed yet.

The workspace path is a working directory, **not a filesystem sandbox**. Enabling built-in file or shell tools grants the service user's corresponding permissions. Keep them disabled until execution isolation and authenticated dispatch are implemented. Health/status endpoints have no authentication and should stay bound/published to loopback during this scaffold phase. Docker sees its container/VM resources; macOS Metal inference requires a native node agent.

`npm run test --workspace @agent/node-agent` checks configuration restrictions and health semantics. `npm run build --workspace @agent/node-agent` checks the SDK integration against installed declarations.

SDK references: [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [explicit SDK configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts).
