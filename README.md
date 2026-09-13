# Agente Odoo para Cliente Final (Piloto Telegram)

Plataforma conversacional que permite a los empleados y usuarios finales de una empresa interactuar con Odoo 19 mediante Telegram de forma segura, acotada y trazable.

---

## Qué incluye

- **Canal exclusivo**: Telegram mediante conversaciones privadas directas (grupos y canales se rechazan automáticamente antes de interactuar con Odoo).
- **Orquestador**: n8n (versión 2.30.5) para la recepción visual de webhooks y entrega de respuestas.
- **Backend y Capa de Control (`control-api`)**: Servicio en Node.js/Express que gestiona identidad, credenciales cifradas, límites de consumo, auditoría, invocación a LLMs y ejecución determinista hacia Odoo.
- **Planificador Semántico (`ReadPlanV1`)**: Interpreta consultas en lenguaje natural, genera planes declarativos validados contra un catálogo administrado y ejecuta únicamente lecturas permitidas mediante JSON-2. Nunca ejecuta métodos arbitrarios de Odoo.
- **Procesamiento Documental Seguro**: Recepción de facturas de proveedor en PDF, JPG o PNG; análisis antivirus con ClamAV previo a la visión; extracción de datos con LLM; previsualización con confirmación explícita (vence a los 5 minutos); y creación exclusiva en estado **borrador** en Odoo.
- **Almacenamiento Auxiliar**: PostgreSQL para la base de datos de n8n, sesiones de memoria aisladas por `cliente + chat + usuario`, registro de auditoría y credenciales.
- **Integración con Odoo**: Conexión nativa a Odoo 19 mediante JSON-2 utilizando la API key individual de cada usuario de Odoo (respetando permisos, compañías y trazabilidad nativa de Odoo).
- **Criptografía Robusta**: Claves de Odoo cifradas en base de datos con AES-256-GCM. Paquetes de incorporación `.odooai` cifrados con RSA-3072 y AES-256-GCM.
- **Modelos de IA**: OpenAI como preferencia predeterminada y Anthropic como alternativa configurable por comando (`/model`).

---

## Arquitectura

```text
Telegram (Chat Privado)
    │
    ▼ (Túnel HTTPS / Webhook)
n8n (Orquestador de Flujos)
    │
    ▼ (HTTP Interno con API Key)
API de Control (Node.js / Express)
    ├── Antivirus (ClamAV) ── Escaneo previo de archivos PDF/JPG/PNG
    ├── Base de Datos (PostgreSQL) ── Identidad, límites, auditoría, memoria
    ├── Modelos LLM (OpenAI / Anthropic) ── Planificación ReadPlanV1 y Visión
    └── Conector Odoo 19 ── JSON-2 con API Key individual del usuario
```

---

## Casos de Uso del Piloto

1. **Consultar órdenes de venta**: Búsqueda por cliente, estado, fecha o número de pedido.
2. **Consultar órdenes de compra**: Consulta de pedidos de compra y estado de recepción.
3. **Consultar precios de productos**: Búsqueda por nombre o referencia interna con tarifas vigentes.
4. **Consultar inventario por producto y almacén**: Consulta de existencias disponibles y a mano.
5. **Consultar facturas de cliente**: Estado de facturas, vencimientos y saldos pendientes.
6. **Consultar clientes**: Búsqueda de contactos comerciales autorizados.
7. **Recepción de facturas de proveedor**: Escaneo con ClamAV, extracción con visión, validación de duplicados y totales, confirmación interactiva y creación **únicamente en borrador** con el documento adjunto.

> [!IMPORTANT]
> El agente **no** publica facturas en firme, no registra pagos, no elimina registros, no crea proveedores automáticamente ni ejecuta pagos o transacciones bancarias.

---

## Modalidades de Instalación

### Opción 1: Docker Compose (Recomendado para Servidores)

Requisitos: Docker Engine y Docker Compose v2.

1. Configurar variables de entorno:
   ```bash
   cp .env.example .env
   # Editar .env con las claves de OpenAI, Telegram, Postgres y llaves maestras
   ```
2. Levantar la pila completa:
   ```bash
   docker compose up -d
   ```
3. Importar los workflows en n8n desde `n8n/workflows/`.

---

### Opción 2: WSL 2 sin Docker (Entornos Windows con Restricciones)

Para estaciones Windows donde no se cuenta con permisos de Docker Desktop:

1. Instalar dependencias en WSL (Ubuntu):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\Install-Pilot-Wsl.ps1
   ```
2. Iniciar servicios en segundo plano:
   ```powershell
   .\scripts\Start-Pilot-Wsl.ps1
   ```
3. Importar workflows de n8n:
   ```powershell
   .\scripts\Import-Workflows-Wsl.ps1
   ```
4. Actualizar secretos desde `.env` sin exponerlos en consola:
   ```powershell
   .\scripts\Update-Secrets-Wsl.ps1
   ```
5. Iniciar túnel de desarrollo para Telegram:
   ```powershell
   .\scripts\Start-QuickTunnel-Wsl.ps1
   ```

---

## Incorporación de Clientes (Onboarding)

Para incorporar un cliente de forma segura:

1. El consultor genera el archivo `.odooai` a partir de la plantilla Excel usando la clave pública de la plataforma.
2. El operador del servidor importa el paquete en la base de datos:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\Importar-PaqueteCliente.ps1 -Paquete ".\ruta\al\paquete.odooai"
   ```
3. El paquete descifra los datos en memoria, registra el cliente, almacena las credenciales cifradas con AES-256-GCM y activa los límites configurados.

---

## Documentación Técnica Adicional

Consulte la carpeta [`docs/`](docs/) para detalles profundos:
- [Arquitectura Detallada](docs/arquitectura.md)
- [Seguridad y Criptografía](docs/seguridad.md)
- [Incorporación Segura (.odooai)](docs/incorporacion-segura.md)
- [Instalación en WSL sin Docker](docs/instalacion-wsl-sin-docker.md)
- [API Administrativa de Control](docs/api-administrativa.md)
