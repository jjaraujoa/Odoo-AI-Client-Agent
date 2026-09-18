-- Migración 012: Motor de flujos de trabajo declarativos (Workflow DSL & Executions)

CREATE TABLE IF NOT EXISTS agent.workflow_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    version INT NOT NULL DEFAULT 1,
    definition_yaml TEXT NOT NULL,
    parsed_definition JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_definitions_client_slug_key UNIQUE (client_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workflow_definitions_client_active
    ON agent.workflow_definitions (client_id, active);

CREATE TABLE IF NOT EXISTS agent.workflow_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID REFERENCES agent.workflow_definitions(id) ON DELETE SET NULL,
    client_id UUID NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    event_fingerprint TEXT,
    trigger_model TEXT NOT NULL,
    trigger_res_id INT NOT NULL,
    trigger_event TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed', 'pending_approval', 'failed', 'skipped')),
    step_results JSONB NOT NULL DEFAULT '[]'::jsonb,
    pending_action_id UUID REFERENCES agent.pending_actions(id) ON DELETE SET NULL,
    error_message TEXT,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_client
    ON agent.workflow_executions (client_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_status
    ON agent.workflow_executions (client_id, status);

INSERT INTO agent.schema_migrations (version, description)
VALUES ('012', 'Definiciones de flujos de trabajo declarativos y auditoría de ejecuciones')
ON CONFLICT (version) DO NOTHING;
