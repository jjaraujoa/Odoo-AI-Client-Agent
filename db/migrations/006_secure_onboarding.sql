BEGIN;

ALTER TABLE agent.linked_users
    ADD COLUMN IF NOT EXISTS onboarding_row_id text;

CREATE UNIQUE INDEX IF NOT EXISTS linked_users_onboarding_row_uq
    ON agent.linked_users (client_id, onboarding_row_id)
    WHERE onboarding_row_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent.import_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id uuid NOT NULL UNIQUE,
    package_version integer NOT NULL CHECK (package_version > 0),
    package_sha256 text NOT NULL CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
    consultant text NOT NULL,
    client_slug text NOT NULL,
    status text NOT NULL
        CHECK (status IN ('applied', 'rejected')),
    user_count integer NOT NULL DEFAULT 0 CHECK (user_count >= 0),
    active_user_count integer NOT NULL DEFAULT 0 CHECK (active_user_count >= 0),
    draft_user_count integer NOT NULL DEFAULT 0 CHECK (draft_user_count >= 0),
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    applied_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_batches_client_idx
    ON agent.import_batches (client_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS agent.import_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_batch_id uuid NOT NULL REFERENCES agent.import_batches(id) ON DELETE CASCADE,
    row_id text NOT NULL,
    entity_type text NOT NULL CHECK (entity_type IN ('client', 'telegram', 'user', 'configuration')),
    outcome text NOT NULL CHECK (outcome IN ('created', 'updated', 'unchanged', 'draft')),
    changes jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (import_batch_id, entity_type, row_id)
);

CREATE TABLE IF NOT EXISTS agent.channel_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL UNIQUE REFERENCES agent.clients(id) ON DELETE CASCADE,
    channel text NOT NULL DEFAULT 'telegram' CHECK (channel = 'telegram'),
    bot_id bigint NOT NULL,
    bot_username text NOT NULL,
    bot_display_name text,
    algorithm text NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm = 'aes-256-gcm'),
    token_ciphertext bytea NOT NULL,
    token_nonce bytea NOT NULL CHECK (octet_length(token_nonce) = 12),
    token_auth_tag bytea NOT NULL CHECK (octet_length(token_auth_tag) = 16),
    token_key_version integer NOT NULL DEFAULT 1 CHECK (token_key_version > 0),
    token_fingerprint text NOT NULL,
    token_last_four text NOT NULL CHECK (char_length(token_last_four) <= 8),
    webhook_secret_ciphertext bytea NOT NULL,
    webhook_secret_nonce bytea NOT NULL CHECK (octet_length(webhook_secret_nonce) = 12),
    webhook_secret_auth_tag bytea NOT NULL CHECK (octet_length(webhook_secret_auth_tag) = 16),
    webhook_secret_key_version integer NOT NULL DEFAULT 1 CHECK (webhook_secret_key_version > 0),
    webhook_secret_fingerprint text NOT NULL UNIQUE,
    webhook_url text,
    webhook_verified_at timestamptz,
    credential_verified_at timestamptz NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER channel_credentials_touch_updated_at
BEFORE UPDATE ON agent.channel_credentials
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.onboarding_client_drafts (
    client_slug text PRIMARY KEY CHECK (client_slug ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
    package_id uuid NOT NULL,
    consultant text NOT NULL,
    requested_active boolean NOT NULL DEFAULT false,
    name text,
    odoo_base_url text,
    odoo_database text,
    timezone text NOT NULL DEFAULT 'America/Bogota',
    validation_status text NOT NULL DEFAULT 'pending'
        CHECK (validation_status IN ('pending', 'valid', 'invalid', 'unreachable')),
    validation_message text,
    last_reviewed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER onboarding_client_drafts_touch_updated_at
BEFORE UPDATE ON agent.onboarding_client_drafts
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

CREATE TABLE IF NOT EXISTS agent.onboarding_user_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug text NOT NULL,
    row_id text NOT NULL,
    package_id uuid NOT NULL,
    consultant text NOT NULL,
    requested_active boolean NOT NULL DEFAULT false,
    odoo_login text,
    odoo_user_id bigint,
    telegram_user_id bigint,
    telegram_chat_id bigint,
    telegram_username text,
    credential_algorithm text CHECK (credential_algorithm IS NULL OR credential_algorithm = 'aes-256-gcm'),
    credential_ciphertext bytea,
    credential_nonce bytea CHECK (credential_nonce IS NULL OR octet_length(credential_nonce) = 12),
    credential_auth_tag bytea CHECK (credential_auth_tag IS NULL OR octet_length(credential_auth_tag) = 16),
    credential_key_version integer CHECK (credential_key_version IS NULL OR credential_key_version > 0),
    api_key_fingerprint text,
    api_key_last_four text CHECK (api_key_last_four IS NULL OR char_length(api_key_last_four) <= 8),
    credential_status text NOT NULL DEFAULT 'missing'
        CHECK (credential_status IN ('missing', 'valid', 'invalid', 'unreachable')),
    validation_message text,
    verified_at timestamptz,
    last_reviewed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_slug, row_id),
    CHECK (
        (credential_status = 'valid' AND credential_ciphertext IS NOT NULL
          AND credential_nonce IS NOT NULL AND credential_auth_tag IS NOT NULL
          AND credential_key_version IS NOT NULL AND api_key_fingerprint IS NOT NULL)
        OR
        (credential_status <> 'valid' AND credential_ciphertext IS NULL
          AND credential_nonce IS NULL AND credential_auth_tag IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS onboarding_user_drafts_stale_idx
    ON agent.onboarding_user_drafts (last_reviewed_at)
    WHERE requested_active = false;

CREATE TRIGGER onboarding_user_drafts_touch_updated_at
BEFORE UPDATE ON agent.onboarding_user_drafts
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

INSERT INTO agent.schema_migrations(version) VALUES ('006_secure_onboarding')
ON CONFLICT (version) DO NOTHING;

COMMIT;
