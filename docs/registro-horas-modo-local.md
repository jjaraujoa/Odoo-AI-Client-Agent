# Registro de horas en modo carpeta local

Permite que un consultor registre **sus propias** horas (partes de horas, `account.analytic.line`) desde un cliente MCP como Claude Code, sin montar la base de datos de control (PostgreSQL).

## Herramientas

| Herramienta | Tipo | Qué hace |
|---|---|---|
| `consultar_mis_proyectos_tareas` | Lectura | Proyectos con `allow_timesheets` y sus tareas abiertas (filtros `query`, `proyecto_id`). |
| `consultar_mis_horas` | Lectura | Líneas del empleado del usuario (`employee_id.user_id = uid`) entre `desde` y `hasta`, con totales por día. |
| `registrar_horas` | Escritura (solo modo local) | Crea líneas con `project_id`, `task_id`, `date`, `unit_amount` y `name`. No envía `employee_id`: Odoo usa el empleado del usuario de la API key. |

## Conexión rápida de un solo usuario (Windows, recomendada)

No necesitas una carpeta de cliente. Ejecuta (sin permisos de administrador):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\control-api\scripts\conectar-odoo.ps1 agregar `
  -Nombre mi-conexion -Url "https://mi-odoo.example.com" -Base "nombre_tecnico_bd" `
  -Login "usuario@empresa.com" -PermitirEscritura registrar_horas
```

1. Detecta la versión de Odoo y el transporte (`legacy_rpc` 14–18, que exige `-Base`; `json2` 19+).
2. Abre una **ventana segura** para pegar la API key. Nunca pasa por la consola, los argumentos ni los archivos.
3. Valida la key: obtiene el uid y comprueba que el login coincide.
4. Guarda la key en **Credenciales de Windows** (`OdooAIAgent/<nombre>/<hash-login>`).
5. Crea el perfil **sin secretos** en `%APPDATA%\OdooAIAgent\conexiones\<nombre>.json`.

`-PermitirEscritura` es opcional: sin él, la conexión es de solo lectura. Otros comandos: `listar` y `quitar -Nombre <nombre>`.

Arranque del MCP:

```json
{ "command": "node", "args": ["<repo>/control-api/bin/odoo-mcp.js", "--conexion", "mi-conexion"] }
```

El MCP lee la key de Credenciales de Windows al arrancar. La auditoría queda en `%APPDATA%\OdooAIAgent\conexiones\<nombre>\auditoria\acciones.jsonl`. `local_write_tools` del perfil también se intersecta con `LOCAL_WRITE_ALLOWED`.

## Alternativa: carpeta de cliente (`cliente.yaml` + `.env`)

En `cliente.yaml` de la carpeta del cliente:

```yaml
odoo_base_url: "https://<instancia>"
odoo_database: "<base>"
api_transport: legacy_rpc      # Odoo 14–18; json2 en 19+
odoo_server_version: "18.0"
timezone: "America/Bogota"     # para validar "fechas no futuras"
local_write_tools:
  - registrar_horas
```

`.env` (nunca en git): `ODOO_LOGIN` y `ODOO_SERVICE_API_KEY`.

`local_write_tools` se intersecta con la constante `LOCAL_WRITE_ALLOWED` del código (`mcp-server.js`): aunque el agente edite `cliente.yaml`, no puede habilitar otras escrituras. Con `DATABASE_URL` (modo BD) `registrar_horas` no se ofrece.

## Gobierno de `registrar_horas`

1. **Preparación** (no escribe): valida fechas (no futuras), horas > 0, proyecto con partes de horas, tarea del mismo proyecto, máximo 12 h por día sumando lo ya registrado, y omite líneas ya existentes (misma fecha, proyecto, tarea y descripción, sin distinguir mayúsculas ni espacios).
2. **Aprobación humana**:
   - Si el cliente MCP soporta *elicitation* (protocolo 2025-06-18+), se muestra el resumen y se pide `confirmar` / `cancelar`.
   - Si no, se devuelve `awaiting_confirmation` con un id de 6 caracteres. Solo se ejecuta si se vuelve a llamar con las **mismas líneas** y `confirmacion: "APLICAR <id>"`. El id es de un solo uso y caduca a los 15 minutos. Complementar con un permiso *ask* del cliente MCP sobre la herramienta.
3. **Ejecución**: se vuelve a preparar con datos frescos (idempotencia) y se crean las líneas una a una. Si una falla, se detiene e informa lo creado.
4. **Auditoría**: cada etapa (`preparada`, `aprobada`, `cancelada`, `ejecutada`, `fallida`) se añade a `<carpeta-cliente>/auditoria/acciones.jsonl`, sin secretos.

## Pruebas

`control-api/test/timesheets.test.js` cubre el mapeo de campos, la validación, la idempotencia, el límite diario, la lista blanca en modo local, el flujo de elicitation y el token de dos pasos.
