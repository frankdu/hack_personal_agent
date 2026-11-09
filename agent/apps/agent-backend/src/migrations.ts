/** SQL kept in the compiled module so npm/Docker builds need no extra file copy. */
export const migration = `
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS nodes (
 id uuid PRIMARY KEY, boot_id uuid NOT NULL, generation uuid NOT NULL, registration jsonb NOT NULL,
 retired_boot_ids jsonb NOT NULL DEFAULT '[]', heartbeat_sequence bigint NOT NULL DEFAULT -1,
 last_seen timestamptz NOT NULL, lease_expires timestamptz NOT NULL, draining boolean NOT NULL DEFAULT false,
 active_attempts jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS conversations (
 id uuid PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tasks (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), request_key text NOT NULL,
 input_hash text NOT NULL, body jsonb NOT NULL, cancel_requested boolean NOT NULL DEFAULT false,
 accepted_revision integer NOT NULL, UNIQUE(conversation_id, request_key)
);
CREATE TABLE IF NOT EXISTS routing_decisions (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), body jsonb NOT NULL,
 evidence jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_attempts (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES tasks(id), decision_id uuid NOT NULL REFERENCES routing_decisions(id),
 node_id uuid NOT NULL REFERENCES nodes(id), endpoint text NOT NULL, request jsonb NOT NULL,
 last_sequence bigint NOT NULL DEFAULT -1, sent_at timestamptz, last_contact timestamptz,
 uncertain_since timestamptz
);
CREATE TABLE IF NOT EXISTS dispatch_outbox (
 attempt_id uuid PRIMARY KEY REFERENCES execution_attempts(id), created_at timestamptz NOT NULL DEFAULT now(),
 completed boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS execution_events (
 id bigserial PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), task_id uuid REFERENCES tasks(id),
 type text NOT NULL CHECK(type IN ('message','task','decision')), data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_conversation_cursor ON execution_events(conversation_id,id);
CREATE INDEX IF NOT EXISTS nodes_lease ON nodes(lease_expires);
CREATE INDEX IF NOT EXISTS pending_outbox ON dispatch_outbox(created_at) WHERE NOT completed;
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES nodes(id);
CREATE INDEX IF NOT EXISTS nodes_current_endpoint ON nodes ((registration->>'endpoint')) WHERE superseded_by IS NULL;

-- Keep the most recently seen identity at each endpoint. Retain every old row:
-- execution attempts and routing audit records still refer to its original UUID.
WITH owners AS (
 SELECT DISTINCT ON (registration->>'endpoint') id, registration->>'endpoint' AS endpoint
 FROM nodes WHERE superseded_by IS NULL
 ORDER BY registration->>'endpoint', last_seen DESC, id
)
UPDATE nodes n SET superseded_by=o.id, lease_expires=LEAST(n.lease_expires, now()), draining=true
FROM owners o
WHERE n.superseded_by IS NULL AND n.registration->>'endpoint'=o.endpoint AND n.id<>o.id;
INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS terminal_sessions (
 id uuid PRIMARY KEY, node_id uuid NOT NULL REFERENCES nodes(id), owner_id text NOT NULL,
 body jsonb NOT NULL, end_requested boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE terminal_sessions ADD COLUMN IF NOT EXISTS end_requested boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS terminal_owner_node ON terminal_sessions(owner_id, node_id);
CREATE TABLE IF NOT EXISTS terminal_lifecycle (
 id bigserial PRIMARY KEY, session_id uuid NOT NULL REFERENCES terminal_sessions(id),
 event text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
`;
