# Protocol v1

Runtime schemas and inferred TypeScript types are the boundary between the frontend, backend and nodes. `npm run generate -w @agent/contracts` emits JSON Schema and OpenAPI from these schemas. Commit generated outputs together with schema changes.

Run `npm run build:packages` before consuming changed contracts. Every registration, heartbeat, submission and execution carries `protocolVersion: "1"`; incompatible versions are rejected. Additive optional fields require all deployed strict consumers to be upgraded before producers send them. New required fields, changed enum meanings or removal of fields require a new protocol version and explicit reader migration. Never silently coerce a new execution state to success.

HTTP user endpoints and node endpoints use distinct bearer credentials. Never put credentials in event URLs. The initial operator-provisioned fleet shares a node credential; per-node enrollment/rotation remains a production milestone.

Execution digests use SHA-256 over UTF-8 `canonicalJson(requestWithoutInputDigest)`. Durable duplicate attempts must match the digest. An `unknown` outcome means execution may have caused effects and cannot be automatically replayed. `output` in task and execution snapshots is cumulative text; consumers replace that attempt's output, rather than appending each poll.
