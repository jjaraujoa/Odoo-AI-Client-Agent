BEGIN;

CREATE TABLE IF NOT EXISTS agent.active_requests (
    request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    linked_user_id uuid NOT NULL REFERENCES agent.linked_users(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    lease_expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS active_requests_user_idx
    ON agent.active_requests (linked_user_id, lease_expires_at);

INSERT INTO agent.schema_migrations(version) VALUES ('004_concurrency')
ON CONFLICT (version) DO NOTHING;

COMMIT;

