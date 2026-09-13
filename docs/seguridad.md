# Seguridad del piloto

## Controles implementados

- API key individual y verificación contra JSON-2 en Odoo 19 o RPC heredado
  cerrado en Odoo 18 al vincular.
- AES-256-GCM con nonce aleatorio de 12 bytes y AAD versionado.
- Paquetes de incorporación cifrados con AES-256-GCM y clave de contenido
  protegida mediante RSA-3072/OAEP-SHA256.
- Token de Telegram cifrado por cliente; n8n nunca recibe ni almacena el token.
- Clave maestra separada de PostgreSQL y del workflow.
- Comparación constante para claves internas/administrativas.
- n8n y control-api accesibles solo por `127.0.0.1`.
- PostgreSQL en una red Docker interna; el puerto de ClamAV no se publica al host
  y su red externa se usa únicamente para actualizar firmas.
- Túnel saliente de Cloudflare hacia n8n.
- Contenedor de control de solo lectura, sin capacidades Linux y con `/tmp`
  efímero/no ejecutable.
- Herramientas, modelos, métodos y campos cerrados.
- `ReadPlanV1` compilado contra un catálogo semántico por cliente; la IA no
  proporciona modelos ni métodos técnicos de Odoo.
- Máximo de tres pasos, 50 registros recuperados, 10 mostrados y un solo
  reintento flexible seguro por solicitud de lectura.
- Permisos definitivos aplicados por Odoo con el usuario real.
- Modelos suministrados desactivados hasta validación API real.
- Archivos limitados por tamaño, MIME, firma mágica y antivirus.
- Vista previa, código de 6 dígitos, caducidad de 5 minutos y no duplicación.
- Sin almacenamiento completo de ejecuciones exitosas en n8n.
- Auditoría con hashes y metadatos.
- El copiloto funcional guarda API keys individuales en Credenciales de Windows,
  separadas por cliente, entorno y login.
- Producción está codificada como solo lectura y las escrituras se bloquean antes
  de abrir una llamada de red.
- El transporte Odoo 18 solo traduce operaciones internas permitidas a
  `authenticate`/`execute_kw`; MCP nunca recibe modelo, método y argumentos RPC
  arbitrarios.
- Las fuentes se limitan a repositorios registrados y commits fijados. Se
  bloquean recorridos de ruta, repositorios privados no autorizados e
  instrucciones incrustadas en documentación o comunidad.
- Los escenarios de demo usan staging, datos ficticios, correos
  `example.invalid`, IDs protegidos con DPAPI y efectos externos inactivos. La
  limpieza no ejecuta `unlink`.
- El MCP del consultor no expone llamadas genéricas. Las vistas generales
  rechazan botones y acciones; una réplica validada puede usar exclusivamente
  `button type="action"` con el marcador `{{SERVER_ACTION_ID}}`, resuelto a la
  acción creada o comprobada por el mismo paquete. `type="object"` continúa
  bloqueado.
- El código ejecutable de una réplica se relee desde una ruta contenida, se
  normaliza y debe coincidir por SHA-256 con el manifiesto justo antes de crear
  la acción. El chat y los argumentos MCP no pueden aportar ese código.
- Los paquetes vencen, comprueban el hash del estado previo y se validan otra vez
  contra una allowlist antes de aplicarse.
- El copiloto generalista solo acepta consultas declarativas con operadores,
  campos y límites compilados. Bloquea modelos de secretos y tipos de campo que
  podrían transportar archivos o HTML.
- Los paquetes de esquema 2 incluyen huellas de contrato, capacidades e
  integridad. Una modificación local, incluso si usa parámetros permitidos,
  invalida la aplicación.
- Los permisos técnicos y la huella de capacidades se comprueban al preparar y
  otra vez inmediatamente antes de escribir.
- Los paquetes de réplica usan esquema 3, admiten múltiples modelos, detienen
  los fallos parciales sin intentar una reversión destructiva y nunca eliminan
  campos. La UAT persiste solo un hash del registro de prueba, no su ID en claro.
- Las réplicas Fase 2 rechazan parámetros desconocidos, componentes sin clave
  lógica, vistas con código o botones ejecutables y actualizaciones sin
  `previous_hash`. Los modelos estándar solo reciben vistas heredadas y los
  registros pertenecientes a módulos estándar no se sobrescriben.
- La reversión Fase 2 restaura únicamente propiedades declarativas admitidas y
  desactiva vistas o menús creados. Los modelos, campos, acciones y datos se
  conservan para evitar pérdidas; cuando no existe una reversión segura el
  paquete queda como `rollback_partial` y exige limpieza manual.
- La Fase 3 mantiene código, dominios y plantillas en archivos separados con
  SHA-256. Los valores previos necesarios para revertir se cifran localmente
  mediante DPAPI del usuario de Windows y no se devuelven por MCP.
- Los correos y webhooks usan referencias tipadas entregadas en memoria. Sus
  automatizaciones se escriben con `active=false`; una acción externa requiere
  `PROBAR-EFECTO <id>` antes de `ACTIVAR-EFECTOS <id>`. El registro UAT solo
  queda representado por un hash.

## Secretos

No deben aparecer en:

- workflows;
- logs;
- auditoría;
- repositorio;
- mensajes de Telegram;
- errores enviados al usuario.

El registro de un usuario se realiza por localhost. La API key en texto claro
existe solo en memoria durante verificación/cifrado o una llamada JSON-2.

La clave privada de incorporación permanece en WSL bajo `/root/.config`, con
permisos exclusivos de `root`. La plantilla Excel y el resumen del consultor no
contienen secretos. El archivo `.odooai` puede viajar únicamente por el
SharePoint restringido aprobado; una alteración o una clave privada distinta
hacen fallar la autenticación criptográfica.

## Qué decide Odoo y qué decide el agente

Odoo decide si el usuario puede leer o escribir el registro. La capa de control
decide si el canal conversacional ofrece esa operación. Aunque un usuario tenga
permiso contable para publicar una factura, el piloto no expone esa acción.

El planificador decide una intención funcional, no una autorización. El
compilador vuelve a comprobar entidad, campos, operadores, dependencias,
política por cliente y límites. Odoo aplica después ACL, reglas de registro y
compañías usando la API key individual. Un plan de lectura nunca puede invocar
el flujo de escritura.

No se almacena razonamiento libre del modelo. La auditoría conserva hashes,
modo de despliegue, entidades semánticas, uso de reparación o reintento y
referencias resumidas. Los nombres y descripciones recuperados de Odoo se
tratan como datos no confiables y no se incorporan como instrucciones.

## Límites conocidos

- El cálculo de páginas PDF es conservador y puede no contar correctamente PDFs
  con estructuras comprimidas inusuales. El límite de bytes y ClamAV siguen
  aplicándose. Antes de producción debe usarse un parser PDF endurecido.
- JSON-2 realiza cada llamada en su propia transacción. Crear el borrador y
  adjuntar el original son dos llamadas. Si el adjunto falla, la acción queda
  como fallida y la auditoría conserva el ID si Odoo lo alcanzó a devolver.
- La detección de duplicados usa proveedor + referencia de factura. Debe
  adaptarse si un cliente usa otra regla contable.
- La selección de impuestos por porcentaje exige una coincidencia única. Los
  clientes con retenciones, impuestos incluidos, impuestos por compañía o
  localizaciones complejas necesitarán reglas parametrizadas.
- El precio de cliente se obtiene leyendo `lst_price` con contexto de lista de
  precios. Debe verificarse en la base piloto para las personalizaciones del
  cliente.
- El almacenamiento de memoria contiene una ventana acotada de mensajes y
  resúmenes hasta 24 horas para resolver referencias conversacionales. Se aísla
  por cliente, usuario y chat, se presenta al modelo como datos no confiables y
  no puede ampliar herramientas ni permisos. Para datos reales debe aprobarse
  una política de retención por cliente.
- Los resúmenes de órdenes guardan solo referencias y campos funcionales ya
  autorizados (número, fecha, estado, total, moneda y facturación). Las
  comparaciones y filtros conversacionales se aplican sobre un máximo de 10
  resultados; no habilitan modelos, campos ni métodos arbitrarios de Odoo.
- Los resúmenes `read_plan_v1` usan una lista de campos permitidos y omiten
  correo y teléfono de clientes. Caducan con la sesión y `/clear` los elimina.
- Una agregación que alcance el tope de recuperación se marca incompleta; el
  agente no puede presentar una suma parcial como total completo.
- Una consulta de hasta tres pasos puede observar cambios entre llamadas porque
  cada llamada JSON-2 usa su propia transacción. Es aceptable para lectura
  informativa, no para futuras escrituras.
- La tolerancia a errores en productos opera únicamente sobre registros que
  Odoo ya devolvió al usuario autenticado. Examina un máximo de 100 candidatos,
  limita a 200 caracteres cada texto comparado y no elude ACL, reglas de
  registro, compañías ni campos protegidos.
- Las consultas generales de facturas están cerradas a `account.move` con
  `move_type=out_invoice`; solo permiten filtros declarativos de estado, pago,
  cliente y fechas. Pedir “todas” no elimina el límite máximo de resultados ni
  habilita asientos, facturas de proveedor u otros tipos de movimiento.
- Un túnel protege el transporte, no reemplaza el control de acceso de n8n. El
  editor no debe publicarse sin Cloudflare Access o una regla que exponga solo
  las rutas de webhook.
- La auditoría local del copiloto está encadenada con SHA-256, pero no es un
  registro remoto inmutable y un usuario con control del equipo puede retirarla.
- La compatibilidad real de creación de metadatos Studio depende de los métodos
  y permisos expuestos por cada base Odoo 19. Está probada con simulación, no aún
  con una base real.
- El sondeo de `/doc` solo registra disponibilidad y metadatos HTTP; no persiste
  el contenido dinámico. El inventario efectivo se construye con metadatos
  autorizados y `check_access_rights` de métodos internos fijos.
- Revertir un campo podría destruir datos. Por eso el copiloto nunca lo elimina;
  solo desactiva las vistas que él mismo creó.

## Antes de producción

- Confirmar licencia de n8n por escrito.
- Añadir Cloudflare Access al editor y separar hostname de webhooks.
- Usar un gestor de secretos externo y rotación.
- Backups cifrados y restauración probada.
- Escaneo de imágenes y dependencias.
- Pruebas de penetración y prompt injection.
- SIEM y alertas.
- Parser PDF especializado.
- Política legal de tratamiento y transferencia internacional.
- Pruebas automatizadas contra una base Odoo por versión y localización.
