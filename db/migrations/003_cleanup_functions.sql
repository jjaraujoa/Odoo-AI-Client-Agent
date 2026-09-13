BEGIN;

CREATE OR REPLACE FUNCTION agent.cleanup_expired_data()
RETURNS TABLE(memory_deleted bigint, sessions_cleared bigint, actions_expired bigint, rate_events_deleted bigint)
LANGUAGE plpgsql
AS $$
DECLARE
    v_memory bigint;
    v_sessions bigint;
    v_actions bigint;
    v_rate bigint;
BEGIN
    DELETE FROM agent.memory_entries WHERE expires_at <= now();
    GET DIAGNOSTICS v_memory = ROW_COUNT;

    UPDATE agent.chat_sessions
       SET cleared_at = COALESCE(cleared_at, now()), state = '{}'::jsonb
     WHERE cleared_at IS NULL
       AND (expires_at <= now() OR absolute_expires_at <= now());
    GET DIAGNOSTICS v_sessions = ROW_COUNT;

    UPDATE agent.pending_actions
       SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= now();
    GET DIAGNOSTICS v_actions = ROW_COUNT;

    DELETE FROM agent.rate_events WHERE created_at < now() - interval '2 days';
    GET DIAGNOSTICS v_rate = ROW_COUNT;

    RETURN QUERY SELECT v_memory, v_sessions, v_actions, v_rate;
END;
$$;

INSERT INTO agent.schema_migrations(version) VALUES ('003_cleanup_functions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
