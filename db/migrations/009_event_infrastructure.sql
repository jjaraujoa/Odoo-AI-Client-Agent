BEGIN;

CREATE TABLE IF NOT EXISTS agent.events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    model text NOT NULL,
    res_id bigint NOT NULL,
    event_type text NOT NULL DEFAULT 'on_write',
    write_uid bigint,
    priority text NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('critical', 'high', 'normal', 'low')),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processed', 'ignored_loop', 'ignored_duplicate', 'failed')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    digest_id uuid,
    dispatched_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
    error_message text,
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_client_status_idx
    ON agent.events (client_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS events_model_res_idx
    ON agent.events (client_id, model, res_id);

CREATE TABLE IF NOT EXISTS agent.event_deduplication (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS event_dedup_expires_idx
    ON agent.event_deduplication (expires_at);

CREATE TABLE IF NOT EXISTS agent.digests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'general',
    summary text NOT NULL,
    event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    delivered_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS digests_client_idx
    ON agent.digests (client_id, created_at DESC);

-- Función para verificar y registrar deduplicación atómicamente
CREATE OR REPLACE FUNCTION agent.check_and_record_deduplication(
    p_client_id uuid,
    p_fingerprint text,
    p_ttl_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_now timestamptz := now();
    v_expires timestamptz := v_now + (p_ttl_seconds || ' seconds')::interval;
BEGIN
    -- Intentar insertar la huella
    INSERT INTO agent.event_deduplication (client_id, fingerprint, expires_at)
    VALUES (p_client_id, p_fingerprint, v_expires)
    ON CONFLICT (client_id, fingerprint) DO UPDATE
        SET expires_at = EXCLUDED.expires_at
        WHERE agent.event_deduplication.expires_at < v_now;

    IF FOUND THEN
        RETURN true; -- Huella nueva o renovada tras expirar (procesar evento)
    ELSE
        RETURN false; -- Huella activa existente (es duplicado, descartar)
    END IF;
END;
$$;

INSERT INTO agent.schema_migrations(version)
VALUES ('009_event_infrastructure')
ON CONFLICT (version) DO NOTHING;

COMMIT;
