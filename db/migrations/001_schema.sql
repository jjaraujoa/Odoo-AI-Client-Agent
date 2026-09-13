BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS n8n;
CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE IF NOT EXISTS agent.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION agent.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS agent.clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
    name text NOT NULL,
    odoo_base_url text NOT NULL CHECK (odoo_base_url ~ '^https?://'),
    odoo_database text,
    timezone text NOT NULL DEFAULT 'America/Bogota',
    active boolean NOT NULL DEFAULT true,
    response_style text NOT NULL DEFAULT 'directo',
    prohibited_fields jsonb NOT NULL DEFAULT
        '["password","api_key","token","bank_ids","sanitized_acc_number","message_ids"]'::jsonb,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER clients_touch_updated_at
BEFORE UPDATE ON agent.clients
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.linked_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    telegram_user_id bigint NOT NULL,
    telegram_chat_id bigint,
    telegram_username text,
    odoo_login text NOT NULL,
    odoo_user_id bigint,
    active boolean NOT NULL DEFAULT true,
    linked_by text,
    linked_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, telegram_user_id)
);

CREATE INDEX IF NOT EXISTS linked_users_telegram_idx
    ON agent.linked_users (telegram_user_id) WHERE active;

CREATE TRIGGER linked_users_touch_updated_at
BEFORE UPDATE ON agent.linked_users
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.odoo_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    linked_user_id uuid NOT NULL UNIQUE REFERENCES agent.linked_users(id) ON DELETE CASCADE,
    algorithm text NOT NULL DEFAULT 'aes-256-gcm'
        CHECK (algorithm = 'aes-256-gcm'),
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
    key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
    api_key_fingerprint text NOT NULL,
    last_four text NOT NULL CHECK (char_length(last_four) <= 8),
    created_at timestamptz NOT NULL DEFAULT now(),
    rotated_at timestamptz,
    last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS agent.models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL UNIQUE,
    provider text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
    api_model_id text NOT NULL,
    supports_vision boolean NOT NULL DEFAULT false,
    capability_rank smallint NOT NULL DEFAULT 1 CHECK (capability_rank BETWEEN 1 AND 10),
    cost_rank smallint NOT NULL DEFAULT 1 CHECK (cost_rank BETWEEN 1 AND 10),
    active boolean NOT NULL DEFAULT false,
    validation_status text NOT NULL DEFAULT 'pending'
        CHECK (validation_status IN ('pending', 'valid', 'invalid', 'error')),
    validation_message text,
    validated_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, api_model_id)
);

CREATE TRIGGER models_touch_updated_at
BEFORE UPDATE ON agent.models
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.client_models (
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    model_id uuid NOT NULL REFERENCES agent.models(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    auto_priority smallint NOT NULL DEFAULT 100 CHECK (auto_priority > 0),
    daily_token_budget bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, model_id)
);

CREATE TRIGGER client_models_touch_updated_at
BEFORE UPDATE ON agent.client_models
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.agent_limits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    linked_user_id uuid REFERENCES agent.linked_users(id) ON DELETE CASCADE,
    requests_per_minute integer NOT NULL DEFAULT 10 CHECK (requests_per_minute > 0),
    requests_per_day integer NOT NULL DEFAULT 100 CHECK (requests_per_day > 0),
    concurrent_requests integer NOT NULL DEFAULT 3 CHECK (concurrent_requests > 0),
    request_timeout_seconds integer NOT NULL DEFAULT 30 CHECK (request_timeout_seconds BETWEEN 1 AND 300),
    max_odoo_records integer NOT NULL DEFAULT 50 CHECK (max_odoo_records BETWEEN 1 AND 1000),
    max_display_records integer NOT NULL DEFAULT 10 CHECK (max_display_records BETWEEN 1 AND 100),
    max_input_chars integer NOT NULL DEFAULT 4000 CHECK (max_input_chars BETWEEN 1 AND 50000),
    max_output_chars integer NOT NULL DEFAULT 3500 CHECK (max_output_chars BETWEEN 1 AND 50000),
    max_document_bytes integer NOT NULL DEFAULT 5242880 CHECK (max_document_bytes > 0),
    max_document_pages integer NOT NULL DEFAULT 10 CHECK (max_document_pages BETWEEN 1 AND 100),
    max_context_messages integer NOT NULL DEFAULT 20 CHECK (max_context_messages BETWEEN 1 AND 100),
    inactivity_minutes integer NOT NULL DEFAULT 30 CHECK (inactivity_minutes BETWEEN 1 AND 1440),
    absolute_session_hours integer NOT NULL DEFAULT 24 CHECK (absolute_session_hours BETWEEN 1 AND 168),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_limits_client_default_uq
    ON agent.agent_limits (client_id) WHERE linked_user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_limits_user_uq
    ON agent.agent_limits (client_id, linked_user_id) WHERE linked_user_id IS NOT NULL;

CREATE TRIGGER agent_limits_touch_updated_at
BEFORE UPDATE ON agent.agent_limits
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.tool_policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    tool_name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    risk_level smallint NOT NULL DEFAULT 1 CHECK (risk_level BETWEEN 1 AND 4),
    confirmation_required boolean NOT NULL DEFAULT false,
    allowed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, tool_name)
);

CREATE TRIGGER tool_policies_touch_updated_at
BEFORE UPDATE ON agent.tool_policies
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.chat_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    linked_user_id uuid NOT NULL REFERENCES agent.linked_users(id) ON DELETE CASCADE,
    telegram_chat_id bigint NOT NULL,
    model_mode text NOT NULL DEFAULT 'auto' CHECK (model_mode IN ('auto', 'manual')),
    selected_model_id uuid REFERENCES agent.models(id) ON DELETE SET NULL,
    active_company_id bigint,
    state jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    cleared_at timestamptz,
    UNIQUE (client_id, linked_user_id, telegram_chat_id)
);

CREATE INDEX IF NOT EXISTS chat_sessions_expiry_idx
    ON agent.chat_sessions (expires_at, absolute_expires_at);

CREATE TABLE IF NOT EXISTS agent.memory_entries (
    id bigserial PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES agent.chat_sessions(id) ON DELETE CASCADE,
    linked_user_id uuid NOT NULL REFERENCES agent.linked_users(id) ON DELETE CASCADE,
    telegram_chat_id bigint NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    kind text NOT NULL DEFAULT 'message'
        CHECK (kind IN ('message', 'entity', 'tool_result', 'summary')),
    content jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_entries_session_idx
    ON agent.memory_entries (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_entries_expiry_idx
    ON agent.memory_entries (expires_at);

CREATE TABLE IF NOT EXISTS agent.pending_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES agent.chat_sessions(id) ON DELETE CASCADE,
    linked_user_id uuid NOT NULL REFERENCES agent.linked_users(id) ON DELETE CASCADE,
    telegram_chat_id bigint NOT NULL,
    action_type text NOT NULL CHECK (action_type IN ('create_vendor_bill_draft')),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'executing', 'completed', 'cancelled', 'expired', 'failed')),
    preview jsonb NOT NULL,
    source_file jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key text NOT NULL UNIQUE,
    confirmation_code text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    confirmed_at timestamptz,
    completed_at timestamptz,
    result jsonb,
    error_code text
);

CREATE INDEX IF NOT EXISTS pending_actions_lookup_idx
    ON agent.pending_actions (client_id, linked_user_id, telegram_chat_id, status);

CREATE TABLE IF NOT EXISTS agent.audit_events (
    id bigserial PRIMARY KEY,
    event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    client_id uuid REFERENCES agent.clients(id) ON DELETE SET NULL,
    linked_user_id uuid REFERENCES agent.linked_users(id) ON DELETE SET NULL,
    session_id uuid REFERENCES agent.chat_sessions(id) ON DELETE SET NULL,
    telegram_chat_id bigint,
    telegram_message_id bigint,
    event_type text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'success', 'error', 'pending')),
    tool_name text,
    provider text,
    model_id text,
    odoo_model text,
    odoo_record_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    duration_ms integer,
    input_tokens integer,
    output_tokens integer,
    error_code text,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_client_time_idx
    ON agent.audit_events (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_user_time_idx
    ON agent.audit_events (linked_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent.rate_events (
    id bigserial PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    linked_user_id uuid NOT NULL REFERENCES agent.linked_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_events_window_idx
    ON agent.rate_events (linked_user_id, created_at DESC);

INSERT INTO agent.schema_migrations(version) VALUES ('001_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;

