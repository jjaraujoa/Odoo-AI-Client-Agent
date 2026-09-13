# API administrativa local

Solo escucha en `127.0.0.1`. Todos los endpoints administrativos requieren
`X-Admin-Key`. El workflow usa una clave distinta en `X-Internal-Key`.

| Método | Ruta | Uso |
|---|---|---|
| GET | `/health` | Salud sin secretos |
| POST | `/v1/admin/clients` | Crear/actualizar cliente y valores por defecto |
| POST | `/v1/admin/users` | Verificar, cifrar y vincular API key individual |
| POST | `/v1/admin/users/revoke` | Revocar acceso |
| POST | `/v1/admin/models/validate` | Consultar APIs reales de modelos |
| POST | `/v1/admin/client-models` | Habilitar un modelo validado por cliente |
| POST | `/v1/admin/limits` | Parametrizar límites del cliente |
| POST | `/v1/admin/read-planner` | Cambiar `legacy`, `shadow` o `active` y las entidades semánticas habilitadas |
| POST | `/v1/admin/telegram/webhook` | Reintentar el webhook usando el token cifrado ya almacenado |
| POST | `/v1/maintenance/cleanup` | Limpiar sesiones/acciones vencidas |
| POST | `/v1/telegram/process` | Procesar actualización de Telegram |

No se recomienda exponer estos endpoints administrativos por el túnel. Los
scripts PowerShell son el cliente administrativo temporal del piloto.

El endpoint del planificador recibe `client_slug`, `mode` y opcionalmente
`entities`. La lista solo admite las seis claves conocidas del catálogo;
no permite registrar modelos o métodos de Odoo. Use
`scripts/Set-ReadPlanner.ps1` para evitar manipular cabeceras o claves de forma
manual.

La incorporación masiva segura no se expone como endpoint HTTP. Se realiza
localmente con `Importar-PaqueteCliente.ps1`, que entrega el paquete cifrado al
importador dentro de WSL, muestra primero una vista previa sin secretos y solo
aplica los cambios tras escribir `IMPORTAR`. El contrato `.odooai` está
versionado para que una futura interfaz web reutilice exactamente las mismas
validaciones e importación transaccional.
