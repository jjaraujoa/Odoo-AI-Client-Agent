BEGIN;

UPDATE agent.tool_policies
   SET allowed_fields = '["name", "move_type", "state", "partner_id", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "currency_id", "payment_state", "company_id"]'::jsonb
 WHERE tool_name = 'consultar_facturas_pendientes';

INSERT INTO agent.schema_migrations(version) VALUES ('007_customer_invoice_queries')
ON CONFLICT (version) DO NOTHING;

COMMIT;
