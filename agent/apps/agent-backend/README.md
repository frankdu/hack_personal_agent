# Agent backend

Persistent Node.js HTTP API with PostgreSQL audit/outbox, fleet leases, authenticated chat, resumable SSE and a bounded Jev routing adapter. This is the single-owner vertical slice; per-user accounts and production node enrollment are deferred.

Required environment: `DATABASE_URL`, distinct `API_TOKEN` and `NODE_SHARED_TOKEN` (at least 16 characters). Set `NODE_ENDPOINT_ALLOWLIST` to exact enrolled HTTP(S) origins. `FRONTEND_ORIGINS` is an exact CORS allowlist. PROD requires both allowlists explicitly. `HOST` defaults to `127.0.0.1`; `PORT` to `3100`. Root Compose supplies container-specific addresses.

`npm run dev -w @agent/agent-backend` starts with automatic, transactionally locked migrations. Set `AUTO_MIGRATE=false` after separately running `npm run migrate -w @agent/agent-backend` when deployment separates migration permission. `npm run build -w @agent/agent-backend` produces `dist/index.js`.

## Routing

Configure optional `JEV_API_KEY`, `JEV_MODEL` (default `jev-1.14.0`) and `JEV_TIMEOUT_MS` (default 2000). Pin an exact model revision: a different returned model is rejected, so moving aliases are unsuitable. At most four Jev calls run concurrently per process; excess requests use permitted rules fallback or return busy without queuing. Manual selection and sole eligible placements bypass the API. Without a key, automatic multi-node routing uses deterministic least-reserved placement only when request policy permits rules fallback. Disallowing hosted judgment never invokes Jev. No paid request occurs during startup or health checking.

The adapter follows TypeSafe's [Choice REST contract](https://docs.typesafe.ai/primitives/choice): state, model and named typed questions to `/v1/systemone`. It validates allowed choices and their probability distribution. Candidate metadata and compact task text go to Jev only when policy allows it. Provider failures are sanitized before logging or returning errors.

Eligibility checks fresh leases, model readiness, workspace IDs, tool subsets and available task slots. Optional `routing.modelId` in both auto and manual routing restricts placements to that exact model ID before selection and again under the placement lock. Omitting it means Auto model. A model preference never activates an inactive model or falls back to another model. One matching node bypasses Jev, including when it exposes multiple matching profiles; multiple matching nodes use the usual judgment/fallback policy. Context admission deliberately uses a conservative character-count estimate; it is not a tokenizer. Profiles are node-reported, and initial deterministic scoring is not a learned latency predictor. Actual workspace revision matching, calibrated outcome learning, split inference/tool placement, context compaction and sticky routing are deferred.

The authenticated `GET /v1/conversations` endpoint returns conversation summaries (ID, first-message title, latest-message timestamp and active task ID) ordered by recent activity. It includes conversations created by older clients without messages, using an untitled label. Message histories are loaded separately through `GET /v1/conversations/:id`.

`DELETE /v1/conversations/:id/messages/:messageId` accepts `{ "expectedRevision": number }` and returns the updated conversation. It removes only that message from history and future task context, increments the revision under the conversation row lock, and rejects stale revisions or active/unresolved tasks with 409. Existing task records and execution audit events are retained.

## Durability and recovery

Each node keeps a stable UUID in `NODE_STATE_DIR/identity.json`; preserve that directory across restarts and moves. An enrolled endpoint has one current identity. A different UUID can replace it after its lease expires, and registration serializes competing claims. The previous identity is marked superseded, excluded from the fleet and routing, and cannot renew a lease or register again. Its database row and execution history remain intact. Startup migrations also reconcile older duplicate endpoint records, keeping the most recently seen identity. Display names are not unique identifiers: equal names at different endpoints remain separate nodes.

A transaction writes the user message, routing reason/evidence, task, attempt and outbox before dispatch. The task request key is unique within its conversation. An identical key with different input returns conflict. Dispatch records send intent, then contacts only an allowlisted endpoint without following redirects.

The dispatcher polls durable node snapshots. It may replay the **same attempt ID and digest** after a 404 only while the original boot and lease generation remain current. It never creates another attempt automatically. Uncertain outcomes remain `unknown`, keep the conversation locked and continue reconciliation. There is no operator resolution API yet: investigate the node journal before changing unresolved state. Cancellation is a request, not rollback of a tool side effect.

Events are persisted in PostgreSQL and replayed by `GET /v1/conversations/:id/events?after=N` or `Last-Event-ID`. Bearer auth is required, including for streams; use fetch streaming rather than an unauthenticated EventSource URL. Task events carry cumulative output. Token deltas are coalesced by polling the node, so this first implementation updates about every 500 ms rather than forwarding each token immediately.

## Scope and deployment limitations

- `API_TOKEN` identifies one trusted owner; all holders share the same conversations. Node credentials are a distinct fleet-wide shared token, not individual enrollments. Use only a trusted private deployment until per-node credentials and user authorization are implemented.
- Endpoint allowlists are operator-managed exact origins. Their DNS and network must be trusted; this release does not pin DNS resolution or verify TLS client certificates.
- Authentication keys and model prompts are not logged. Durable messages still contain user input and model output; backup and retention controls are deployment responsibilities.
- Registration can change a boot generation, but does not revoke a process's OS privileges. Heartbeat expiry cannot undo an already running external action.
- Event retention, artifact storage, outcome metrics and production revocation are not implemented. Models and tools execute on the separate node service.

## Tests

`npm test -w @agent/agent-backend` runs configuration/routing/provider tests without live inference. Set `TEST_DATABASE_URL` to an expendable PostgreSQL database to also run integration checks. The suite creates and drops a uniquely named schema; it never drops the database or public schema. It verifies audit-before-send, idempotency, scope separation, CORS, leases, event replay and conservative unknown outcomes.

## Project browsing

Operator-authenticated `GET /v1/nodes/:nodeId/projects`, `POST /v1/nodes/:nodeId/projects` with `{directory}`, and `GET /v1/nodes/:nodeId/projects/:projectId/tree?path=.&offset=0` relay to the enrolled node. The backend rejects offline nodes and destinations outside its endpoint allowlist, bounds upstream requests/responses, and validates project/tree schemas. The browser never receives the node credential. Paths appear only in authenticated project responses, not public node status. The node owns project-root persistence and enforces traversal, private-state and symlink checks.

## Terminal relay

Operator-authenticated `GET/POST /v1/nodes/:nodeId/terminals` lists or creates sessions without invoking routing or a model. Creation requires a client UUID, registered `workspaceId`, `backend` (`tmux` or explicitly chosen `pty`), `cols` and `rows`. Reuse the same creation UUID after an uncertain response. `POST /v1/terminals/:sessionId/end` durably records termination intent and retries it while a node is offline; a 202 response means `ending`. `DELETE /v1/terminal-connections/:clientId` revokes that browser connection's pending tickets and detaches its active writers.

`POST /v1/terminals/:sessionId/ticket` takes `{clientId, takeover:false}`. Tickets last 30 seconds, are single-use, and are bound to the operator, allowed browser Origin, session, node boot and lease generation. Connect to `/v1/terminals/attach` with WebSocket, then send `{type:"attach", ticket, cols, rows}` as the first frame within five seconds. Tickets and bearer tokens never enter WebSocket URLs. The backend alone opens the node WebSocket using the fleet credential. The node validates every attachment and continues to enforce the current lease. Only explicit takeover replaces a tmux writer. Browser disconnect, connection revocation, lease loss, session end, or attachment expiry closes the relay; attachments last at most 15 minutes and reconnect explicitly.

All terminal HTTP and WebSocket calls require an allowlisted Origin. HTTP is accepted only for a loopback frontend; remote frontends and remote node endpoints require HTTPS/WSS. A TLS reverse proxy must connect to this HTTP backend over loopback. Forwarded headers are not trusted. The current authentication scope remains one trusted operator; the owner identity is derived from its operator credential. Changing that credential changes ownership and invalidates old attachments; it does not transfer detached sessions to a new operator.

Flow control ACKs UTF-8 bytes after xterm renders them, pauses node PTY reads above 64 KiB pending output, resumes below 32 KiB, and disconnects slow readers after ten seconds or a 256 KiB queue limit. Input frames and resize dimensions are bounded; input is rate limited to 64 KiB/s. WebSocket compression is disabled, and ping/pong detects abandoned relays. PostgreSQL stores session metadata, lifecycle events, and pending termination intent, never raw terminal bytes. A database outage denies or closes terminal access. This does not provide an SSH service or an outbound NAT tunnel.
