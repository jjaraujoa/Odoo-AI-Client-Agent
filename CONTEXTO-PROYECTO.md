# Contexto y Decisiones del Proyecto: Agente Odoo para Cliente Final

## Propósito

Construir una plataforma robusta y reutilizable que permita a los empleados autorizados de una empresa consultar información y registrar borradores operativos en Odoo mediante una conversación natural por Telegram.

La prioridad absoluta es la seguridad, la trazabilidad y la precisión:
- El modelo de lenguaje (LLM) interpreta y redacta; nunca ejecuta acciones directas.
- El código de la capa de control (`control-api`) define las herramientas existentes y valida estrictamente las entradas.
- Odoo aplica las reglas de registro, compañías y permisos reales del usuario autenticado mediante su API key individual.

---

## Arquitectura del Agente

```text
Telegram Privado
    -> Túnel HTTPS
    -> n8n (Webhooks y entrega)
    -> control-api (Node.js / Express)
    -> OpenAI o Anthropic
    -> Odoo 19 (JSON-2)

PostgreSQL: Clientes, usuarios, credenciales cifradas, memoria y auditoría.
ClamAV: Escaneo de archivos adjuntos antes de enviarlos a modelos de visión.
```

---

## Decisiones de Diseño y Seguridad

### 1. Canal y Aislamiento
- Únicamente se atienden chats privados individuales de Telegram.
- Se descartan de forma inmediata grupos, supergrupos y canales para prevenir fuga de datos entre usuarios.
- La memoria conversacional está aislada por la tupla: `(cliente_id, chat_id, user_id)`.

### 2. Planificador Semántico (`ReadPlanV1`)
- Las consultas no envían SQL ni nombres de modelos arbitrarios al ERP.
- La IA genera un plan estructurado `ReadPlanV1` usando un catálogo semántico predefinido (ventas, compras, productos, inventario, facturas, clientes).
- Un compilador determinista valida el plan y ejecuta hasta tres pasos de lectura con reintento seguro.
- La planificación y la redacción están separadas: el redactor final solo recibe datos normalizados de Odoo.

### 3. Flujo Documental de Facturas de Proveedor
- Formatos admitidos: PDF, JPG, PNG (máximo 5 MB y 10 páginas).
- Todo archivo se analiza previamente con ClamAV. Si contiene malware, se rechaza.
- Se extrae información con visión (proveedor, número, fecha, moneda, impuestos, líneas y totales).
- Se presenta una vista previa estructurada al usuario en Telegram solicitando confirmación explícita (vence en 5 minutos).
- Tras confirmar, se crea **exclusivamente en estado borrador** en Odoo y se adjunta el archivo original.
- Queda fuera del alcance: pagos, publicación contable automática, eliminación de registros y creación de proveedores no existentes.

### 4. Gestión de Identidad y Secretos
- Cada `telegram_user_id` se vincula con un usuario de Odoo.
- Las API keys de Odoo se almacenan cifradas en PostgreSQL usando AES-256-GCM con una llave maestra (`ODOO_CREDENTIAL_MASTER_KEY_B64`).
- Los tokens de bot de Telegram se cifran por cliente.
- En logs y auditoría se enmascaran parámetros sensibles y nunca se imprimen API keys ni contraseñas.
