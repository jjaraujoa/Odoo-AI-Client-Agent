# Arquitectura de la plataforma

La plataforma tiene dos superficies con identidades y políticas separadas.

```text
Telegram
   │ webhook HTTPS + secreto por cliente
   ▼
Cloudflare Tunnel
   │
   ▼
n8n (Webhook genérico)
   │ actualización + cabecera secreta + credencial interna
   ▼
control-api
   ├── identidad y API key individual cifrada
   ├── límites, sesión y memoria aislada
   ├── selección /model y modo automático
   ├── ReadPlanV1 + catálogo semántico + compilador
   ├── ejecutores de lectura cerrados
   ├── OpenAI / Anthropic
   ├── ClamAV para archivos
   ├── token de Telegram cifrado por cliente
   └── auditoría
   │
   ▼
Odoo 19 JSON-2
```

## Copiloto funcional local

```text
Codex Desktop (carpeta de cliente confiable)
   │ MCP STDIO, sin secretos en argumentos
   ▼
OdooConsultor.dll + OdooConsultor.ps1
   ├── perfiles staging / production
   ├── Credenciales de Windows
   ├── herramientas JSON-2 cerradas
   ├── descubrimiento y consultas declarativas
   ├── compilador de políticas versionado
   ├── paquetes, precondiciones e idempotencia
   ├── réplicas locales, manifiestos y archivos SHA-256
   ├── adaptadores cerrados Studio de Fases 1 y 2
   ├── bloqueo de producción antes de la red
   └── auditoría local encadenada
   │
   ▼
Odoo 19 JSON-2
```

El copiloto no depende de Telegram, n8n, PostgreSQL auxiliar, ClamAV ni las
tablas de memoria del agente público. Comparte principios y contratos de
seguridad, no credenciales ni sesiones.

Las primitivas generalistas y el motor de réplicas son contratos distintos. El
primero no acepta código ni métodos; el segundo solo ejecuta adaptadores fijos
cuando el artefacto está bajo `replicas/<slug>/`, el manifiesto es compatible y
todos sus archivos coinciden por SHA-256. La única llamada funcional ejecutable
de la Fase 1 es `ir.actions.server/run` con modelo, acción y registro derivados
del paquete validado. La Fase 2 solo usa adaptadores de metadatos fijos para
`ir.model`, `ir.model.fields`, `ir.model.fields.selection`, `ir.ui.view`,
`ir.actions.act_window` e `ir.ui.menu`; ninguno se expone al modelo de IA como
método configurable.

La Fase 3 añade adaptadores fijos para `mail.template`, `ir.actions.server`,
`base.automation` y la actualización de `compute`/`depends` en
`ir.model.fields`. Una réplica compila campos calculados, plantillas, acciones,
cadenas, automatizaciones, vínculos y compuertas de activación en ese orden.
Los efectos externos se prueban ejecutando únicamente el ID de acción derivado
del paquete y no se activan automáticamente.

Una réplica de Fase 2 compila en este orden: modelos, campos, opciones de
selección, vistas, acciones de ventana y menús. Las dependencias lógicas se
resuelven con claves del manifiesto y las dependencias externas con XML ID o
referencias declaradas. Los cambios `update` y `deactivate` solo se habilitan si
el snapshot actual coincide con `previous_hash` y el artefacto pertenece a
Studio o no tiene propietario de módulo estándar.

## Responsabilidad de cada capa

### Telegram

Identifica el usuario y chat, recibe texto/archivos y muestra respuestas. No es
la fuente de permisos de Odoo.

### n8n

Recibe el webhook genérico y reenvía la actualización y la cabecera secreta a la
API interna. No contiene tokens de Telegram, credenciales individuales de Odoo
ni lógica funcional crítica. La respuesta a Telegram la envía `control-api` con
el token descifrado únicamente en memoria.

### control-api

- vincula Telegram con un usuario individual de Odoo;
- descifra la API key solo durante la llamada;
- elige un modelo validado;
- planifica la lectura con entidades y campos funcionales;
- compila el plan contra catálogo, políticas, permisos adicionales y límites;
- consulta Odoo con ejecutores JSON-2 cerrados;
- normaliza resultados y redacta una respuesta fundamentada;
- administra confirmaciones e idempotencia;
- registra auditoría resumida.

### Odoo

Aplica derechos de acceso, reglas de registro, restricciones por compañía y
trazabilidad del usuario autenticado. La plataforma no usa `sudo()` ni un usuario
genérico.

## Herramientas cerradas

| Herramienta | Modelo principal | Escritura |
|---|---|---|
| `consultar_orden_venta` | `sale.order` | No |
| `consultar_orden_compra` | `purchase.order` | No |
| `consultar_precio_producto` | `product.product` | No |
| `consultar_inventario` | `product.product` | No |
| `consultar_facturas_pendientes` | `account.move` (facturas de cliente por estado/pago) | No |
| `consultar_clientes` | `res.partner` (solo clientes) | No |
| `crear_factura_proveedor_borrador` | `account.move` / `ir.attachment` | Borrador confirmado |

No existe una herramienta `ejecutar(modelo, método, parámetros)` accesible al
modelo de IA.

## Lecturas semánticas `ReadPlanV1`

```text
Pregunta + contexto del chat
        │
        ▼
Planificador IA: objetivo, entidad, campos, filtros, orden y operación
        │ nombres funcionales; sin registros completos de Odoo
        ▼
Compilador determinista: catálogo + políticas + campos + límites
        │
        ▼
Ejecutor: 1–3 llamadas JSON-2 cerradas y un reintento seguro
        │ resultados normalizados
        ▼
Redactor IA: respuesta limitada a la evidencia recibida
```

El catálogo inicial traduce `ordenes_venta`, `ordenes_compra`,
`facturas_cliente`, `productos`, `inventario` y `clientes` a ejecutores
revisados. Los nombres técnicos no forman parte del contrato que genera la IA.
El compilador rechaza entidades deshabilitadas, campos desconocidos o sensibles,
operadores fuera de la lista, dependencias futuras y planes de más de tres
pasos. El límite absoluto es 50 registros recuperados y 10 mostrados.

Los conteos se realizan con `search_count`. Las agregaciones se calculan en
código y se separan por moneda. Si no es posible demostrar que se recuperó el
conjunto completo, el resultado se marca incompleto y no se presenta como un
total. Una secuencia puede observar cambios intermedios porque cada llamada
JSON-2 tiene su propia transacción; por ello esta flexibilidad solo se usa para
lectura informativa.

La activación por cliente admite `legacy`, `shadow` y `active`. En sombra se
genera y audita el plan, pero responde el flujo anterior. Las herramientas
anteriores permanecen como ejecutores compatibles durante la transición.

El mismo principio se aplica al MCP del consultor. Su catálogo generalista
expone descubrimiento, inspección, consultas declarativas, comparación,
validación y compilación de cambios, aplicación, verificación, reversión segura
y runbooks. Puede recibir el modelo como dato en primitivas de lectura, pero no
un método: el host traduce cada contrato a una de sus llamadas internas fijas.
La ejecución automática sigue limitada a la creación de campos declarativos y
vistas heredadas aditivas en staging.

```text
Necesidad funcional
   -> contrato declarativo
   -> clasificación de riesgo
   -> descubrimiento de modelo y permisos
   -> compilador de políticas
      ├── lectura/validación: ejecución automática limitada
      ├── cambio aditivo staging: paquete + confirmación
      └── alto riesgo o producción: runbook
```

## Selección automática

1. Respeta la selección manual de la sesión.
2. Exige visión para PDF/JPG/PNG.
3. Filtra por modelo validado, activo y habilitado para el cliente.
4. Prefiere OpenAI en modo automático.
5. Elige el menor coste que alcance la capacidad estimada.
6. Si no hay modelo válido, falla de forma cerrada.

## Memoria

La clave lógica es:

```text
client_id + linked_user_id + telegram_chat_id
```

En este piloto `telegram_chat_id` se deriva del `telegram_user_id`, porque solo
se aceptan conversaciones privadas directas. El valor se conserva internamente
para aislar sesiones y acciones pendientes, pero el consultor no debe capturarlo
en la plantilla.

El modelo recibe una ventana acotada de mensajes recientes y resúmenes
estructurados `read_plan_v1` con el plan ejecutado, filtros, referencias y
resultados seleccionados para resolver expresiones como “las dos”, “esa
orden” o “consultar”. Cada entrada conserva la misma clave lógica y caducidad;
no existe memoria compartida entre usuarios, chats o clientes. El contexto se
presenta al modelo como datos no confiables y nunca amplía el catálogo de
herramientas, modelos, campos o límites permitidos.

Dentro de una herramienta autorizada, el lenguaje natural puede expresar
consultas limitadas sin filtros artificiales. Por ejemplo, “las últimas 2
órdenes” se compila a `sale.order`, orden descendente por fecha y límite 2. La
ausencia de un número o cliente no abre una consulta ilimitada: el máximo del
cliente y el tope absoluto de 10 registros siguen aplicándose.

Las preguntas de seguimiento modifican el plan anterior en vez de reiniciar una
clasificación rígida. Las comparaciones usan campos recibidos de Odoo; no
comparan el número visible del documento ni dejan que el modelo invente fechas.
`/clear` elimina mensajes, planes y referencias de la sesión y restablece la
selección automática de modelo.

Para productos, primero se ejecuta una búsqueda literal por nombre o referencia.
Si no hay resultados, la API obtiene como máximo 100 candidatos autorizados a
partir de prefijos y calcula localmente similitud normalizada. Una coincidencia
solo se selecciona automáticamente si supera el umbral y se separa claramente
de la segunda alternativa. Los candidatos no se envían al modelo.

La búsqueda consulta primero `res.users.lang` para la identidad de la API key y
combina ese idioma con el contexto de almacén o lista de precios. Los campos
traducibles de producto se devuelven así con el mismo nombre que muestra Odoo.

La herramienta de facturas conserva su nombre técnico por compatibilidad, pero
admite consultas declarativas de `out_invoice` por estado (`posted`, `draft` o
todos) y pago (`pending`, `paid` o todos). Cliente y fechas son opcionales. La
consulta permanece limitada por el cliente y por el tope absoluto de 10
registros mostrados.
