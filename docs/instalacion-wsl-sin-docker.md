# Instalación nativa en WSL, sin Docker

Esta modalidad reutiliza PostgreSQL instalado en Ubuntu, pero crea una base y
un usuario independientes para el agente. No utiliza el servicio Odoo local.

## Requisitos comprobados

- WSL 2 con Ubuntu 24.04 y `systemd`.
- Al menos 6 GB asignados a WSL.
- PostgreSQL activo.
- Acceso saliente HTTPS para descargar paquetes, Node.js y dependencias npm.

## Instalar

Desde PowerShell, en la raíz del proyecto:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Install-Pilot-Wsl.ps1
```

El instalador:

1. Genera `.env` si todavía no existe.
2. Instala ClamAV y utilidades del sistema.
3. Instala Node.js 24.18.0 en `/opt/odoo-ai-agent/node` sin reemplazar el
   Node.js del sistema.
4. Instala la API de control y n8n 2.30.5.
5. Crea una cuenta Linux sin inicio de sesión llamada `odooagent`.
6. Crea una base PostgreSQL independiente.
7. Aplica las migraciones.
8. Configura servicios `systemd`.
9. Guarda el entorno de ejecución en `/etc/odoo-ai-agent.env`, con permisos
   exclusivos de root.

## Operar

```powershell
.\scripts\Start-Pilot-Wsl.ps1
.\scripts\Status-Pilot-Wsl.ps1
.\scripts\Stop-Pilot-Wsl.ps1
.\scripts\Apply-Migrations-Wsl.ps1
.\scripts\Import-Workflows-Wsl.ps1
.\scripts\Update-Secrets-Wsl.ps1
.\scripts\Start-QuickTunnel-Wsl.ps1
.\scripts\Stop-QuickTunnel-Wsl.ps1
```

Interfaces locales:

- n8n: `http://localhost:5678`
- Control API: `http://localhost:8080/health`

`Start-Pilot-Wsl.ps1` mantiene una sesión silenciosa de WSL mientras el piloto
está en uso. `Stop-Pilot-Wsl.ps1` detiene los dos servicios del piloto y cierra
esa sesión. PostgreSQL y cualquier otra información existente no se eliminan.

## Primer ingreso

1. Abra `http://localhost:5678`.
2. Cree el propietario local de n8n.
3. Los tres workflows base se importan con `Import-Workflows-Wsl.ps1`.
4. Cree y asigne únicamente la credencial interna `Control API Internal`; el
   token del bot no se guarda en n8n.
5. Complete la clave de OpenAI en `.env`, sin compartir el archivo. Anthropic
   puede permanecer vacío durante el piloto.
6. Ejecute `Update-Secrets-Wsl.ps1` para aplicar esos valores al entorno
   protegido sin mostrarlos en la consola.

El token de Telegram y las API keys individuales se incorporan mediante el
paquete cifrado `.odooai`. Active el workflow de Telegram después de asignar la
credencial interna y configurar el túnel seguro.

## Prueba temporal sin dominio

Para comprobar el piloto sin usar un dominio empresarial, puede crear un Quick
Tunnel temporal:

```powershell
.\scripts\Start-QuickTunnel-Wsl.ps1
.\scripts\Retry-TelegramWebhook.ps1 -ClientSlug piloto-odoo19
```

No requiere una cuenta de Cloudflare ni modificar DNS. La salida muestra la URL
pública, pero no muestra el token del bot ni el secreto del webhook. El proxy
local publica solamente `POST /webhook/odoo-ai-telegram`; la interfaz de n8n y
la API administrativa permanecen locales.

La URL `trycloudflare.com` es aleatoria, cambia al reiniciar y no tiene garantía
de disponibilidad. Por eso sirve para una prueba atendida, no para producción.
Deténgala al terminar:

```powershell
.\scripts\Stop-QuickTunnel-Wsl.ps1
```

Después de cada nuevo inicio, vuelva a ejecutar
`Retry-TelegramWebhook.ps1` para que Telegram conozca la nueva URL.

## Seguridad

- No ejecute n8n ni la API como `root`.
- No copie `.env` ni `/etc/odoo-ai-agent.env`.
- ClamAV usa su socket Unix local; no se expone el puerto 3310.
- PostgreSQL conserva el puerto de la instalación existente, pero el agente
  utiliza otra base y otro rol.
- Node.js se instala en una ruta aislada y no modifica `/usr/bin/node`, que
  puede ser requerido por otras aplicaciones.
- El Quick Tunnel temporal no publica n8n completo: solo la ruta exacta del
  webhook de Telegram mediante un proxy cerrado.

## Limitación

WSL y sus servicios solo estarán disponibles mientras la máquina esté
encendida y WSL pueda iniciarse. Este modo es apropiado para el piloto local,
no para disponibilidad 24/7.

n8n 2.30.5 todavía funciona en esta modalidad, pero avisa que versiones futuras
requerirán su imagen oficial de Docker. Por eso la versión queda fijada para el
piloto; no debe actualizarse sin revisar antes el método de instalación.
