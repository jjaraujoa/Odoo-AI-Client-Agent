BEGIN;

-- 1. Actualización de agent.pending_actions para soporte multi-canal y motor de aprobaciones
-- Permitir acciones no vinculadas a un usuario o chat de Telegram directo (e.g., originadas por API admin o workflows)
ALTER TABLE agent.pending_actions
    ALTER COLUMN linked_user_id DROP NOT NULL,
    ALTER COLUMN telegram_chat_id DROP NOT NULL;

-- Incorporar nuevas columnas para trazabilidad de canal, detalle de items, aprobador y resoluciones
ALTER TABLE agent.pending_actions
    ADD COLUMN IF NOT EXISTS channel text,
    ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS approver_linked_user_id uuid REFERENCES agent.linked_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS telegram_message_id bigint,
    ADD COLUMN IF NOT EXISTS decided_via text,
    ADD COLUMN IF NOT EXISTS decision_note text;

-- Restricción de canales válidos para acciones pendientes
ALTER TABLE agent.pending_actions
    DROP CONSTRAINT IF EXISTS pending_actions_channel_check;

ALTER TABLE agent.pending_actions
    ADD CONSTRAINT pending_actions_channel_check
    CHECK (channel IS NULL OR channel IN ('mcp_elicitation', 'telegram', 'admin', 'workflow'));

-- Reemplazar CHECK de status en agent.pending_actions para incluir 'partial'
ALTER TABLE agent.pending_actions
    DROP CONSTRAINT IF EXISTS pending_actions_status_check;

ALTER TABLE agent.pending_actions
    ADD CONSTRAINT pending_actions_status_check
    CHECK (status IN (
        'pending',
        'confirmed',
        'executing',
        'completed',
        'cancelled',
        'expired',
        'failed',
        'partial'
    ));

-- 2. Actualización de CHECK de status en agent.action_executions para incluir 'executed_staging', 'cancelled' y 'partial'
ALTER TABLE agent.action_executions
    DROP CONSTRAINT IF EXISTS action_executions_status_check;

ALTER TABLE agent.action_executions
    ADD CONSTRAINT action_executions_status_check
    CHECK (status IN (
        'executed',
        'awaiting_approval',
        'approved',
        'rejected',
        'failed',
        'executed_staging',
        'cancelled',
        'partial'
    ));

-- 3. Índice para búsquedas eficientes por aprobador y estado
CREATE INDEX IF NOT EXISTS pending_actions_approver_idx
    ON agent.pending_actions (client_id, approver_linked_user_id, status);

-- 4. Expiración de acciones operativas pendientes en formato anterior (sin canal asignado)
UPDATE agent.pending_actions
SET status = 'expired'
WHERE action_type = 'operational_action'
  AND status = 'pending'
  AND channel IS NULL;

-- Registro de la migración en agent.schema_migrations
INSERT INTO agent.schema_migrations (version)
VALUES ('013_approval_engine')
ON CONFLICT (version) DO NOTHING;

COMMIT;
