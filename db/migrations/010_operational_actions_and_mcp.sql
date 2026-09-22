BEGIN;

-- 1. Ampliar el CHECK constraint de agent.pending_actions.action_type
ALTER TABLE agent.pending_actions
    DROP CONSTRAINT IF EXISTS pending_actions_action_type_check;

ALTER TABLE agent.pending_actions
    ADD CONSTRAINT pending_actions_action_type_check
    CHECK (action_type IN (
        'create_vendor_bill_draft',
        'confirm_sale_order',
        'validate_stock_picking',
        'change_record_stage',
        'operational_action'
    ));

-- Permitir session_id nulo para acciones originadas por el Orquestador o MCP
ALTER TABLE agent.pending_actions
    ALTER COLUMN session_id DROP NOT NULL;

-- 2. Tabla para auditoría y trazabilidad de ejecuciones operativas
CREATE TABLE IF NOT EXISTS agent.action_executions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    linked_user_id uuid REFERENCES agent.linked_users(id) ON DELETE SET NULL,
    action_name text NOT NULL,
    model text NOT NULL,
    res_id bigint,
    risk_level smallint NOT NULL CHECK (risk_level BETWEEN 1 AND 3),
    status text NOT NULL
        CHECK (status IN ('executed', 'awaiting_approval', 'approved', 'rejected', 'failed')),
    input_params jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_executions_client_idx
    ON agent.action_executions (client_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS action_executions_model_idx
    ON agent.action_executions (client_id, model, res_id);

-- 3. Políticas por defecto para nuevas acciones operativas
INSERT INTO agent.tool_policies
    (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
SELECT id, 'crear_borrador_orden_venta', 1, false,
       '["partner_id","order_line","user_id","company_id","note","payment_term_id"]'::jsonb
  FROM agent.clients
ON CONFLICT (client_id, tool_name) DO NOTHING;

INSERT INTO agent.tool_policies
    (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
SELECT id, 'crear_borrador_factura_cliente', 1, false,
       '["partner_id","invoice_date","invoice_line_ids","currency_id","ref"]'::jsonb
  FROM agent.clients
ON CONFLICT (client_id, tool_name) DO NOTHING;

INSERT INTO agent.tool_policies
    (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
SELECT id, 'asignar_responsable', 1, false,
       '["user_id"]'::jsonb
  FROM agent.clients
ON CONFLICT (client_id, tool_name) DO NOTHING;

INSERT INTO agent.tool_policies
    (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
SELECT id, 'cambiar_etapa_registro', 2, false,
       '["stage_id","state"]'::jsonb
  FROM agent.clients
ON CONFLICT (client_id, tool_name) DO NOTHING;

INSERT INTO agent.tool_policies
    (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
SELECT id, 'confirmar_orden_venta', 3, true,
       '["id"]'::jsonb
  FROM agent.clients
ON CONFLICT (client_id, tool_name) DO NOTHING;

INSERT INTO agent.tool_policies
    (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
SELECT id, 'validar_albaran_entrega', 3, true,
       '["id"]'::jsonb
  FROM agent.clients
ON CONFLICT (client_id, tool_name) DO NOTHING;

INSERT INTO agent.schema_migrations(version)
VALUES ('010_operational_actions_and_mcp')
ON CONFLICT (version) DO NOTHING;

COMMIT;
