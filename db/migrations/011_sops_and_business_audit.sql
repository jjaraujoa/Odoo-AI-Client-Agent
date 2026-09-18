BEGIN;

CREATE TABLE IF NOT EXISTS agent.client_sops (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    sop_key text NOT NULL CHECK (sop_key ~ '^[a-z0-9_-]{2,64}$'),
    title text NOT NULL,
    category text NOT NULL DEFAULT 'operaciones'
        CHECK (category IN ('ventas', 'compras', 'inventario', 'contabilidad', 'operaciones', 'general')),
    content_md text NOT NULL,
    keywords text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (client_id, sop_key)
);

CREATE INDEX IF NOT EXISTS client_sops_search_idx
    ON agent.client_sops (client_id, category);

CREATE TABLE IF NOT EXISTS agent.business_audit_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id uuid NOT NULL REFERENCES agent.clients(id) ON DELETE CASCADE,
    report_type text NOT NULL DEFAULT 'operational_health'
        CHECK (report_type IN ('operational_health', 'data_hygiene', 'sla_bottlenecks', 'margins')),
    summary text NOT NULL,
    findings jsonb NOT NULL DEFAULT '[]'::jsonb,
    severity text NOT NULL DEFAULT 'info'
        CHECK (severity IN ('critical', 'warning', 'info')),
    dispatched_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_audit_client_idx
    ON agent.business_audit_reports (client_id, created_at DESC);

-- Procedimientos semilla para clientes existentes
INSERT INTO agent.client_sops
    (client_id, sop_key, title, category, keywords, content_md)
SELECT c.id,
       'politica-credito',
       'Política de Crédito y Plazos de Pago',
       'ventas',
       ARRAY['credito', 'plazo', 'pago', 'financiamiento', 'dias', 'cartera'],
       E'# Política de Crédito y Plazos de Pago\n\n1. **Plazo Estándar**: Clientes nuevos operan de contado o anticipado.\n2. **Aprobación de Crédito (30 a 60 días)**:\n   - Requiere historial mínimo de 3 compras sin mora.\n   - Debe ser aprobado por el Director Financiero en Odoo.\n3. **Bloqueo por Mora**: Si el cliente tiene facturas vencidas > 15 días, Odoo bloqueará automáticamente nuevas cotizaciones.'
  FROM agent.clients c
ON CONFLICT (client_id, sop_key) DO NOTHING;

INSERT INTO agent.client_sops
    (client_id, sop_key, title, category, keywords, content_md)
SELECT c.id,
       'recepcion-mercancia',
       'Procedimiento de Recepción de Mercancías en Bodega',
       'inventario',
       ARRAY['recepcion', 'camion', 'albaran', 'bodega', 'almacen', 'mercancia', 'descarga'],
       E'# Procedimiento de Recepción de Mercancías\n\n1. **Llegada del Camión**: Solicitar remisión física al transportador.\n2. **Verificación en Odoo**:\n   - Abrir módulo de Inventario > Operaciones > Recepciones.\n   - Buscar por número de orden de compra (PO) o proveedor.\n3. **Conteo Físico**: Contar bultos y verificar empaques antes de descargar.\n4. **Discrepancias**: Si faltan unidades, registrar la cantidad real en Odoo y crear entrega pendiente (Backorder).'
  FROM agent.clients c
ON CONFLICT (client_id, sop_key) DO NOTHING;

INSERT INTO agent.client_sops
    (client_id, sop_key, title, category, keywords, content_md)
SELECT c.id,
       'gestion-devoluciones',
       'Procedimiento para Devoluciones de Clientes',
       'ventas',
       ARRAY['devolucion', 'retorno', 'garantia', 'cambio', 'reclamo', 'defecto'],
       E'# Procedimiento para Devoluciones de Clientes\n\n1. **Recepción del Reclamo**: Comprobar que la factura o entrega tiene menos de 30 días.\n2. **Inspección de Producto**: El producto debe regresar en empaque original y sin daño por mal uso.\n3. **Registro en Odoo**:\n   - En el albarán original de entrega (WH/OUT), hacer clic en \"Devolver\".\n   - Especificar cantidades y ubicación de destino (Bodega de Control de Calidad).\n4. **Nota de Crédito**: Solo se genera tras visto bueno de Calidad.'
  FROM agent.clients c
ON CONFLICT (client_id, sop_key) DO NOTHING;

INSERT INTO agent.schema_migrations(version)
VALUES ('011_sops_and_business_audit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
