BEGIN;

-- IDs suministrados por el usuario. Se registran, pero permanecen desactivados
-- y con validación pendiente hasta comprobarlos contra cada cuenta API.
INSERT INTO agent.models
    (display_name, provider, api_model_id, supports_vision, capability_rank, cost_rank, active, validation_status, metadata)
VALUES
    ('claude-opus-5', 'anthropic', 'claude-opus-5', true, 10, 10, false, 'pending',
     '{"source":"user_provided","must_validate_before_activation":true}'::jsonb),
    ('claude-sonnet-5', 'anthropic', 'claude-sonnet-5', true, 8, 6, false, 'pending',
     '{"source":"user_provided","must_validate_before_activation":true}'::jsonb),
    ('claude-haiku-4-5-20251001', 'anthropic', 'claude-haiku-4-5-20251001', true, 5, 2, false, 'pending',
     '{"source":"user_provided","must_validate_before_activation":true}'::jsonb),
    ('gpt-5.6-sol', 'openai', 'gpt-5.6-sol', true, 10, 10, false, 'pending',
     '{"source":"user_provided","must_validate_before_activation":true}'::jsonb),
    ('gpt-5.6-luna', 'openai', 'gpt-5.6-luna', true, 8, 6, false, 'pending',
     '{"source":"user_provided","must_validate_before_activation":true}'::jsonb),
    ('gpt-5.6-terra', 'openai', 'gpt-5.6-terra', true, 6, 4, false, 'pending',
     '{"source":"user_provided","must_validate_before_activation":true}'::jsonb),
    ('gpt-5.4-nano-2026-03-17', 'openai', 'gpt-5.4-nano-2026-03-17', true, 3, 1, false, 'pending',
     '{"source":"user_provided","must_validate_before_activation":true}'::jsonb)
ON CONFLICT (provider, api_model_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    metadata = agent.models.metadata || EXCLUDED.metadata;

INSERT INTO agent.schema_migrations(version) VALUES ('002_seed_models')
ON CONFLICT (version) DO NOTHING;

COMMIT;

