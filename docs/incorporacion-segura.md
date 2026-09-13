# Incorporación segura mediante paquetes `.odooai`

## Objetivo

Este proceso permite que un consultor prepare un cliente y sus usuarios sin
escribir API keys ni tokens en Excel, correo, chat o SharePoint.

El consultor entrega un único archivo `.odooai`. Su contenido está cifrado para
esta instalación y solo puede abrirse con la clave privada administrativa que
permanece dentro de WSL.

## Kit del consultor

La carpeta `onboarding/consultant-kit` contiene:

- `Plantilla-Incorporacion-Cliente.xlsx`;
- `Crear-PaqueteCliente.ps1`;
- `OdooAiPortableCrypto.cs`;
- `platform-public-key.json`;
- `platform-public-key.pem`.

La herramienta funciona con Windows PowerShell 5.1, no instala componentes y no
requiere permisos administrativos. Usa una implementación .NET portátil de
AES-256-GCM y RSA-3072/OAEP-SHA256.

El script verifica la huella del componente criptográfico y de la clave pública
antes de pedir secretos. Para distribuirlo corporativamente debe firmarse con
Authenticode. La firma real no se incluye en el repositorio porque requiere el
certificado privado corporativo.

## Preparación administrativa

Ejecute una vez:

```powershell
.\scripts\Initialize-OnboardingKeys-Wsl.ps1
.\scripts\Sync-Artifacts-Wsl.ps1
.\scripts\Apply-Migrations-Wsl.ps1
```

La clave privada queda en:

```text
/root/.config/odoo-ai-agent/onboarding-private.pem
```

Sus permisos son `0600` y no se copia al proyecto. Guarde una copia de
recuperación cifrada en el almacén corporativo autorizado. La pérdida de esta
clave impide abrir paquetes que todavía no hayan sido importados.

## Firma corporativa

Con un certificado de firma de código instalado para el usuario:

```powershell
.\scripts\Firmar-KitConsultor.ps1 -Thumbprint "HUELLA_DEL_CERTIFICADO"
```

También se admite un PFX; la contraseña se solicita de forma oculta:

```powershell
.\scripts\Firmar-KitConsultor.ps1 -Pfx .\firma-corporativa.pfx
```

Después de firmar, distribuya el kit completo. En la operación corporativa el
consultor debe usar `-ExigirFirma`:

```powershell
.\Crear-PaqueteCliente.ps1 `
  -Plantilla .\Cliente.xlsx `
  -ExigirFirma
```

Si cambia el script, la firma deja de ser válida. Si cambia la clave pública o el
componente criptográfico, la herramienta detiene la ejecución.

## Instrucciones para el consultor

1. Haga una copia de `Plantilla-Incorporacion-Cliente.xlsx`.
2. Complete `Cliente`, `Telegram`, `Usuarios` y `Configuración`. La plantilla
   actual incluye `consultar_clientes`; manténgala activa solo si ese cliente
   autoriza esta entidad de lectura.
3. En `Usuarios`, ingrese únicamente el **Telegram User ID numérico**. No se
   solicita un Chat ID separado: la plataforma lo deriva porque el piloto solo
   permite conversaciones privadas directas. Puede obtener el ID, por ejemplo,
   con `@userinfobot`; no envíe a ese bot credenciales ni información de Odoo.
4. No escriba secretos en ninguna hoja.
5. Mantenga el mismo `slug` y `row_id` en paquetes posteriores.
6. Abra PowerShell en la carpeta del kit.
7. Ejecute:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Crear-PaqueteCliente.ps1 `
     -Plantilla .\Cliente.xlsx
   ```

8. Ingrese el token del bot y las API keys en los campos ocultos.
9. Revise el resumen sin secretos.
10. Cargue el `.odooai` en la biblioteca restringida de SharePoint.

El Excel nunca se modifica. El `.odooai` es el único archivo con secretos y
estos se encuentran cifrados y autenticados.

## Contrato `.odooai` versión 1

El archivo exterior contiene únicamente metadatos criptográficos:

- `format=odooai` y `version=1`;
- `package_id`;
- identificador de la clave pública;
- algoritmos declarados;
- clave AES envuelta, nonce, tag y ciphertext en Base64;
- hash SHA-256 del contenido autenticado.

El contenido descifrado usa `schema_version=1` y separa `client`, `telegram`,
`users` y `configuration`. Cualquier futura herramienta web debe producir este
mismo contrato; una versión nueva requerirá soporte explícito del importador.

## Estados

### Cliente o usuario activo

`activo=TRUE` exige:

- cliente con nombre, URL y base coherentes;
- token válido y perteneciente al username esperado;
- Telegram User ID entero, positivo y no duplicado;
- conversación privada directa; grupos, supergrupos y canales están bloqueados;
- API key válida mediante JSON-2;
- login igual al devuelto por Odoo, o login derivado desde Odoo;
- todas las filas activas correctas.

Un error impide aplicar el paquete completo. No hay importación parcial de
usuarios activos.

### Usuario en borrador

`activo=FALSE` admite campos faltantes. El registro se guarda en
`agent.onboarding_user_drafts`, nunca en `agent.linked_users`.

- No puede usar el bot.
- No se elimina automáticamente.
- Conserva `last_reviewed_at`.
- Se considera pendiente de revisión después de 30 días.
- Puede completarse con otro paquete que use el mismo `slug` y `row_id`.

Si se suministra una API key, siempre se valida. Una clave inválida o una
conexión fallida no guarda ciphertext. Una clave válida se vuelve a cifrar con
la clave maestra AES-256-GCM de la plataforma.

## Importación administrativa

Descargue el `.odooai` desde SharePoint a una carpeta local controlada:

```powershell
.\scripts\Importar-PaqueteCliente.ps1 `
  -Archivo .\cliente-fecha.odooai
```

La vista previa muestra cliente, base, autor, huella, bot, usuarios, estados,
identidades derivadas y últimos cuatro caracteres. Nunca muestra tokens, API
keys, ciphertext, nonce ni tag.

La vista previa no modifica PostgreSQL. Para aplicar es obligatorio escribir
exactamente `IMPORTAR`. El importador comprueba nuevamente la huella antes de
aplicar. `package_id` garantiza idempotencia.

## Telegram sin token en n8n

El token validado se cifra en `agent.channel_credentials`. n8n no lo recibe ni
lo almacena.

El workflow usa:

```text
/webhook/odoo-ai-telegram
```

Durante la importación se genera y cifra un secreto de webhook, se registra el
webhook en Telegram y la capa de control responde directamente mediante la API
de Telegram. n8n solo reenvía la actualización y el encabezado secreto. El
workflow no persiste ejecuciones exitosas ni fallidas.

El Chat ID operativo se deriva del Telegram User ID. Antes de buscar al usuario
o consultar Odoo, la capa de control comprueba que Telegram haya marcado la
conversación como `private` y que ambos identificadores coincidan. Un mensaje en
un grupo, supergrupo o canal se rechaza sin acceder a información empresarial.

Si `N8N_WEBHOOK_URL` todavía no apunta a un túnel válido, la importación conserva
una advertencia de webhook pendiente.

Cuando se configure la URL después de importar el paquete, no es necesario
volver a importar ni volver a suministrar el token. Registre el webhook usando
la credencial cifrada que ya está almacenada:

```powershell
.\scripts\Retry-TelegramWebhook.ps1 -ClientSlug piloto-odoo19
```

El endpoint administrativo correspondiente solo escucha localmente, exige la
clave administrativa y nunca devuelve el token ni el secreto del webhook.

## Auditoría

`agent.import_batches` conserva:

- `package_id` y hash del paquete;
- consultor declarado;
- cliente y conteos;
- resultado, fecha y estado del webhook.

`agent.import_rows` conserva cambios funcionales sin secretos.

Nunca se registran el cuerpo descifrado, token, API keys, ciphertext, nonce, tag,
claves de contenido ni clave privada.

## Rotación

Un paquete posterior puede completar o activar un borrador, cambiar datos de
Telegram, rotar credenciales y modificar límites, herramientas o modelos. Use
siempre el mismo `row_id`.

Una credencial nueva e inválida no reemplaza una credencial válida ya
almacenada.

## SharePoint

Use una biblioteca dedicada:

- acceso solo a consultores asignados y al importador;
- MFA y cuentas corporativas;
- historial y auditoría;
- enlaces anónimos deshabilitados;
- retención definida por seguridad de la información.

SharePoint aporta transporte y trazabilidad, pero el cifrado `.odooai` sigue
siendo obligatorio.

## Pruebas

```powershell
.\scripts\Test-ConsultantCrypto.ps1
```

La suite del control API valida apertura, alteración, clave equivocada,
borradores, bloqueo de activos incompletos, derivación de identidad y ausencia de
secretos en la vista previa.
