BEGIN;

CREATE TABLE IF NOT EXISTS agent.semantic_entities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    entity_key text NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{1,62}$'),
    catalog_version text NOT NULL DEFAULT 'read-semantic-catalog/1',
    enabled boolean NOT NULL DEFAULT true,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, entity_key)
);

DROP TRIGGER IF EXISTS semantic_entities_touch_updated_at ON agent.semantic_entities;
CREATE TRIGGER semantic_entities_touch_updated_at
BEFORE UPDATE ON agent.semantic_entities
FOR EACH ROW EXECUTE FUNCTION agent.touch_updated_at();

INSERT INTO agent.semantic_entities(client_id, entity_key)
SELECT c.id, entity_key
  FROM agent.clients c
 CROSS JOIN (VALUES
    ('ordenes_venta'),
    ('ordenes_compra'),
    ('facturas_cliente'),
    ('productos'),
    ('inventario'),
    ('clientes')
 ) AS catalog(entity_key)
ON CONFLICT (client_id, entity_key) DO NOTHING;

INSERT INTO agent.tool_policies
    (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
SELECT id, 'consultar_clientes', 1, false,
       '["name","vat","email","phone","mobile","city","country_id","company_type","customer_rank","active"]'::jsonb
  FROM agent.clients
ON CONFLICT (client_id, tool_name) DO UPDATE SET
    allowed_fields = EXCLUDED.allowed_fields;

UPDATE agent.tool_policies
   SET allowed_fields = '["name","partner_id","date_order","state","amount_total","currency_id","user_id","company_id","invoice_status","invoice_ids"]'::jsonb
 WHERE tool_name IN ('consultar_orden_venta', 'consultar_orden_compra');

UPDATE agent.tool_policies
   SET allowed_fields = '["name","display_name","default_code","lst_price","currency_id","uom_id"]'::jsonb
 WHERE tool_name = 'consultar_precio_producto';

UPDATE agent.tool_policies
   SET allowed_fields = '["name","display_name","default_code","qty_available","free_qty","virtual_available","uom_id"]'::jsonb
 WHERE tool_name = 'consultar_inventario';

ALTER TABLE agent.clients
    ALTER COLUMN settings SET DEFAULT '{"read_planner_mode":"shadow"}'::jsonb;

UPDATE agent.clients
   SET settings = jsonb_set(settings, '{read_planner_mode}', '"shadow"'::jsonb, true)
 WHERE NOT (settings ? 'read_planner_mode');

UPDATE agent.clients
   SET settings = jsonb_set(settings, '{read_planner_mode}', '"active"'::jsonb, true)
 WHERE slug = 'piloto-odoo19';

INSERT INTO agent.schema_migrations(version) VALUES ('008_read_planner_v1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
