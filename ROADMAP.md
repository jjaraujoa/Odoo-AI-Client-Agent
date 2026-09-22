# Hoja de Ruta (Roadmap): Agente Odoo para Cliente Final

## Visión General: Del Agente Reactivo al Orquestador Operativo Empresarial

Este proyecto evoluciona desde un agente conversacional reactivo (consultas puntuales y registros manuales por Telegram) hacia una **plataforma integral de orquestación de flujos de trabajo empresariales en Odoo 19**.

El agente deja de ser únicamente un chatbot para convertirse en un **miembro activo del equipo de trabajo**:
1. **Actuar ante eventos**: Monitorear cambios en la base de datos de Odoo y reaccionar en tiempo real o de forma programada ante sucesos clave.
2. **Alertar y asesorar**: Enviar alertas proactivas, resúmenes periódicos (*digests*) y advertencias operativas tanto en Odoo (Discuss/Chatter) como en canales de mensajería (Telegram).
3. **Ejecutar procesos delegables**: Asumir flujos operativos repetitivos mediante un modelo de gobernanza por niveles de riesgo (acciones autónomas para tareas seguras y confirmación interactiva para acciones críticas).
4. **Asesor de procedimientos y auditor de negocio**: Responder dudas sobre procedimientos internos (SOPs) y evaluar la salud operativa de la empresa (cuellos de botella, inventarios obsoletos, márgenes y calidad de datos).
5. **Creación de flujos asistida por IA**: Permitir que consultores o administradores modelen nuevos flujos a medida en lenguaje natural mediante agentes de código (Claude Code, Codex, Antigravity) o un CLI, manteniéndolos desacoplados del núcleo del sistema.

---

## Decisiones Arquitectónicas Fundamentales y sus Justificaciones

Para mantener el norte del proyecto y asegurar que las futuras implementaciones (humanas o por LLM) respeten las razones de diseño acordadas, se documentan las siguientes decisiones clave:

### 1. Dualidad de Roles: Orquestador Central vs. Copiloto de Empleado
* **Decisión**: El sistema se divide en dos personalidades estrictamente separadas:
  1. *El Orquestador Global (Fondo)*: Monitorea eventos, corre crons y ejecuta automatizaciones. **No tiene chat público en Telegram**. Solo es modificable e instruible por quien tenga acceso local al repositorio/carpeta del proyecto mediante agentes de código (Claude Code, Codex, Antigravity) o el CLI.
  2. *El Copiloto de Empleado (Asistente Personal)*: Atiende consultas individuales y explica procedimientos (SOPs) por Telegram (móvil) o servidor MCP (escritorio), operando exclusivamente bajo la API key y permisos personales de ese empleado.
* **Razón**: Garantizar seguridad por aislamiento físico/entorno. Si el orquestador global tuviera un chat público, cualquier empleado podría manipularlo mediante inyecciones de instrucciones (*prompt injection*) para aprobarse órdenes indebidas.

### 2. Usuario de Servicio Dedicado en Odoo Enterprise
* **Decisión**: El Orquestador Global utiliza su propio usuario interno en Odoo con un rol RBAC de mínimo privilegio y avatar visible ("Agente IA"). El cliente asume el coste de la licencia de Odoo de este usuario.
* **Razón**: En Odoo Enterprise (SaaS u Odoo.sh), los usuarios gratuitos de portal/públicos tienen estrictamente prohibido por el ORM modificar modelos operativos internos (`sale.order`, `stock.picking`). Un usuario interno propio garantiza trazabilidad nativa innegociable en el chatter (*"Acción automática ejecutada por Agente IA"*).

### 3. Modelo Híbrido "BYOS" (Bring Your Own Subscription) vía MCP
* **Decisión**: Se implementa una doble vía de interacción y consumo:
  1. *Canal Móvil / Planta (Telegram)*: Orientado a operarios de bodega y vendedores de campo. Consume APIs de modelos (OpenAI/Anthropic) gestionadas por `control-api`.
  2. *Canal Escritorio / Oficina (Claude Desktop, Claude Code, Codex, Cursor)*: Orientado a directores, compradores, contadores y consultores. Se conectan a través de un servidor **MCP (Model Context Protocol)** que expone las herramientas de `control-api`.
* **Razón**: Reducir radicalmente los costes de tokens de API aprovechando las tarifas planas de suscripciones de IA que la empresa ya paga para su personal de oficina (Claude Pro/Team, ChatGPT Plus/Team).

### 4. Regla de Oro "Zero-Tokens" (Automatización Tradicional vs. Inferencia)
* **Decisión**: Toda condición, notificación o validación que pueda resolverse mediante un `IF` en código, una regla de Odoo o un nodo de n8n tiene **terminantemente prohibido** invocar a un LLM. La IA se reserva exclusivamente para: lectura de documentos no estructurados (visión/OCR), síntesis y priorización en digests periódicos, diálogo en lenguaje natural y auditorías estratégicas complejas.
* **Razón**: Evitar la inviabilidad económica por consumo desbordado de tokens y eliminar la latencia innecesaria en tareas que la informática tradicional resuelve en milisegundos a coste cero.

### 5. Prevención de Bucles Infinitos sin Módulos en Odoo
* **Decisión**: Evitar rebotes de eventos mediante 3 barreras en Odoo y n8n:
  1. *Filtro de usuario en n8n*: Descartar inmediatamente el webhook si `write_uid == BOT_SERVICE_USER_ID`.
  2. *Disparadores específicos en Odoo*: `base.automation` configuradas para disparar solo en cambios de campos concretos (ej. `state` de borrador a confirmado), no en escrituras genéricas.
  3. *Caché de deduplicación (Debounce)*: Descarte de eventos con idéntica huella `(modelo + id + write_date)` en ventanas de 30-60 segundos.
* **Razón**: Proteger la infraestructura y la BD de bucles infinitos respetando la restricción innegociable de no instalar módulos personalizados en Odoo.

### 6. Validación de Flujos en Staging (Descarte de Dry-Run en Producción)
* **Decisión**: Se descarta el modo simulado (*dry-run*) obligatorio en producción. Todo flujo a medida debe modelarse, probarse y validarse en el entorno de Staging o copias de prueba del cliente antes de desplegarse en producción.
* **Razón**: Simplicidad operativa y apego a la metodología estándar de consultoría en Odoo, donde Staging (en Odoo.sh y Online) provee réplicas actualizadas para verificar el comportamiento sin complejidad añadida en el código productivo.

### 7. Consolidación de Notificaciones ("Digest Inteligente" vs. Spam)
* **Decisión**: Prohibir el bombardeo de notificaciones individuales por cada evento rutinario. El agente agrupa novedades en resúmenes estructurados periódicos (matutinos o de cierre) por rol, reservando las alertas inmediatas solo para emergencias o bloqueos críticos.
* **Razón**: Evitar la fatiga de notificaciones que lleva a los empleados a silenciar o ignorar los bots de mensajería.

---

## Hitos Completados (Base del Piloto)

### Versión 0.1.0 – Piloto Base en Telegram
- Conexión del canal privado de Telegram con n8n 2.30.5 y backend `control-api` en Node.js/Express.
- Identidad vinculada por `telegram_user_id` y almacenamiento de API keys individuales de Odoo cifradas con AES-256-GCM.
- Descarte automático e inmediato de grupos, supergrupos y canales de Telegram.
- Consultas base de ventas, compras, productos, inventario, facturas y contactos.
- Planificador semántico declarativo `ReadPlanV1` con compilador determinista hacia JSON-2 de Odoo 19 (sin RPC arbitrario).

### Versión 0.2.0 – Flujo Documental y Seguridad Avanzada
- Recepción de facturas de proveedores en PDF, JPG y PNG (hasta 5 MB y 10 páginas).
- Escaneo antivirus en memoria con ClamAV previo al procesamiento de visión multimodal.
- Extracción de datos con LLM y validación cruzada de proveedores, impuestos, líneas y totales.
- Flujo interactivo de confirmación con expiración a los 5 minutos y creación **exclusivamente en estado borrador** con archivo adjunto en Odoo.
- Aislamiento de memoria de sesión por tupla `(cliente_id, chat_id, user_id)`.
- Compatibilidad dual de ejecución: Docker Compose y WSL 2 nativo sin Docker.

### Versión 0.3.0 – Sistema de Onboarding Cifrado
- Incorporación de clientes mediante paquetes `.odooai` cifrados con RSA-3072 y AES-256-GCM a partir de plantillas Excel para consultores.
- Script automatizado de importación transaccional (`Importar-PaqueteCliente.ps1`).
- Configuración dinámica de límites de peticiones y tokens por cliente y usuario.

---

## Fases de Implementación Futura

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          FASES DE IMPLEMENTACIÓN                        │
├─────────────────┬─────────────────┬──────────────────┬─────────────────┤
│     FASE 1      │     FASE 2      │      FASE 3      │     FASE 4      │
│  Infraestructura│ Motor Operativo │ Asistente Digital│ Ecosistema de   │
│   de Eventos y  │  Gobernanza y   │ y Auditoría de   │ Flujos Asistido │
│  Digest Periódico│ Servidor MCP   │     Negocio      │por Agentes / CLI│
└─────────────────┴─────────────────┴──────────────────┴─────────────────┘
```

---

### Fase 1: Infraestructura de Eventos, Prevención de Bucles y Alertas Consolidadas

**Objetivo**: Habilitar la captura de eventos en Odoo y el despacho eficiente de alertas proactivas sin generar bucles infinitos ni saturar de notificaciones a los empleados.

#### 1.1 Captura de Eventos Híbrida (Odoo + n8n)
- **Webhooks con `base.automation`**: Configuración de automatizaciones estándar en Odoo que despachan webhooks HTTP al ocurrir transiciones clave (creación o cambio de campo específico).
- **Crons en n8n**: Tareas periódicas para auditar condiciones temporales (órdenes estancadas, vencimientos próximos).
- **Bus interno y cola en `control-api`**: Recepción, validación criptográfica y procesamiento asíncrono de eventos por cliente.

#### 1.2 Mecanismos Anti-Bucle Estrictos
- **Filtro de usuario en n8n**: Nodo de entrada que evalúa `write_uid !== BOT_SERVICE_USER_ID`; descarte en 0 ms si el cambio lo originó el bot.
- **Deduplicación por huella**: Registro de firma `(modelo + res_id + write_date)` en memoria/Postgres para suprimir eventos duplicados recibidos en menos de 60 segundos.

#### 1.3 Sistema de Notificaciones y "Digest Inteligente"
- **Odoo Discuss y Chatter**:
  - Registro de notas internas (`mail.message`) y menciones (`@usuario`) para trazabilidad del equipo.
- **Telegram (Deep Links)**:
  - Alertas inmediatas únicamente para eventos críticos o bloqueantes con enlace directo al registro en Odoo.
- **Digest Operativo Periódico**:
  - Resumen estructurado programado (ej. 8:00 AM y 5:00 PM) para supervisores y responsables de área (órdenes prioritarias, riesgos de entrega, tareas del día).

#### 1.4 Criterios de Éxito de la Fase 1
- Eventos de Odoo procesados y filtrados en menos de 2 segundos.
- Cero bucles infinitos en pruebas de estrés de escrituras automatizadas.
- Entrega paralela y coordinada en Chatter y Telegram sin duplicidades.

---

### Fase 2: Motor Operativo, Gobernanza de Autonomía y Servidor MCP

**Objetivo**: Dotar al agente de capacidad de ejecución de acciones en Odoo bajo gobernanza de riesgo, y habilitar el servidor MCP para aprovechar suscripciones de IA de escritorio (BYOS).

#### 2.1 Identidad y Permisos del Agente de Servicio
- Configuración y parametrización del usuario interno del agente en Odoo con permisos mínimos estrictos (RBAC).
- Registro de firma del agente en el contexto de llamada de Odoo para auditoría nativa.

#### 2.2 Catálogo de Primitivas Operativas Seguras
- Operaciones de escritura controladas vía JSON-2:
  - Creación de borradores vinculados (órdenes, presupuestos, facturas, movimientos de stock).
  - Transiciones de estado permitidas (confirmar, validar recepciones/entregas, cancelar).
  - Actualización de fechas, ubicaciones y asignación de responsables.
- Mantenimiento del bloqueo de acciones destructivas (`unlink`, publicación directa de asientos contables reales sin política explícita).

#### 2.3 Matriz de Gobernanza y Aprobaciones (Human-in-the-Loop)
- **Nivel 1 – Acciones Rutinarias (Autónomas)**: Creación de borradores, notas de chatter, asignaciones.
- **Nivel 2 – Acciones Reversibles (Autonomía con Aviso)**: Modificación de estados con notificación al responsable para posible reversión.
- **Nivel 3 – Acciones Críticas (Aprobación Obligatoria con Timeout)**: Solicitud interactiva en Telegram / Odoo con botones de confirmación y caducidad automática.

#### 2.4 Servidor MCP para Escritorio (Bring Your Own Subscription)
- Exposición de herramientas de `control-api` como un servidor **MCP (Model Context Protocol)** estándar.
- Conexión directa desde clientes de escritorio (Claude Desktop, Claude Code, Cursor, Codex, ChatGPT Work) usando las credenciales y suscripciones pagadas de cada empleado de oficina.
- Aplicación de permisos del usuario conectado al servidor MCP para respetar las reglas de Odoo.

#### 2.5 Criterios de Éxito de la Fase 2
- Ejecución correcta de acciones compuestas respetando la matriz de gobernanza.
- Conexión exitosa desde Claude Desktop / Claude Code vía MCP sin incurrir en costes de API por token.

---

### Fase 3: Asistente Operativo Empresarial, SOPs y Auditoría de Negocio

**Objetivo**: Transformar al agente en un asesor experto en procedimientos internos de la empresa para empleados y en un auditor analítico de procesos para directores.

#### 3.1 Base de Conocimiento de Procedimientos (SOPs) por Cliente
- Directorio de procedimientos estándar en lenguaje natural por cliente (`clients/<slug>/sops/*.md`):
  - Políticas de crédito, tiempos de despacho, criterios de devolución, pasos de recepción en bodega.
- Asesoría contextual en chat privado de Telegram: el operario consulta cómo realizar un procedimiento y el agente lo guía paso a paso adaptado a las pantallas y reglas de la empresa.

#### 3.2 Auditoría Proactiva de Salud Operativa y Negocio
- Rutinas periódicas (semanales/mensuales) o bajo demanda ejecutadas por el orquestador:
  - **Detección de Cuellos de Botella (SLA)**: Identificación de órdenes o tickets estancados en etapas intermedias por encima del promedio histórico.
  - **Higiene de Datos**: Detección de contactos sin identificación fiscal, productos sin costo configurado, precios desactualizados o inventario negativo.
  - **Análisis de Márgenes y Rotación**: Detección de ventas con margen inferior al estándar y reporte de productos con baja rotación.
- Generación de reportes ejecutivos dirigidos a gerentes de área con recomendaciones de optimización.

#### 3.3 Criterios de Éxito de la Fase 3
- Guía de procedimientos con cero alucinaciones de políticas externas a la empresa.
- Detección precisa de anomalías de negocio y generación de informes ejecutivos de alto valor.

---

### Fase 4: Ecosistema de Creación de Flujos Asistido por Agentes de Código y CLI

**Objetivo**: Facilitar que consultores y administradores modelen, simulen, prueben e implementen flujos de trabajo a la medida de cada cliente a partir de lenguaje natural, gobernados desde el repositorio local.

#### 4.1 Especificación Declarativa de Flujos (Workflow DSL en YAML)
- Formato estructurado desacoplado del núcleo del sistema:
  ```yaml
  name: "orden_urgente_a_factura_borrador"
  description: "Flujo para procesar órdenes con marca de urgencia"
  trigger:
    source: "odoo.base_automation"
    model: "sale.order"
    event: "on_write"
    field: "state"
    condition: "record.state == 'sale' and record.priority == '1'"
  actions:
    - step: 1
      action: "odoo.create_draft_invoice"
      policy: "autonomous"
    - step: 2
      action: "odoo.request_approval"
      approver_role: "supervisor_ventas"
      timeout_minutes: 30
  notifications:
    chatter:
      target: "sale.order"
      template: "Se ha generado la factura borrador por orden urgente."
    telegram:
      recipient: "assigned_user"
  ```

#### 4.2 Gobernanza por Acceso a Repositorio (`Cerebro Global`)
- El Orquestador Global solo es administrable por usuarios con acceso al workspace del proyecto.
- Los flujos se almacenan en `clients/<slug>/workflows/*.yaml` bajo control de versiones Git, garantizando que nadie pueda alterar las reglas de negocio desde un chat abierto.

#### 4.3 CLI de Consultoría y Asistencia por IA (`odoo-agent-cli`)
- Herramienta para uso conjunto de consultores y agentes de código (Claude Code, Codex, Antigravity):
  - `odoo-agent-cli schema dump`: Extrae los modelos, campos personalizados (`x_studio_...`) y selecciones del Odoo del cliente para darle contexto real al LLM.
  - `odoo-agent-cli flow new`: Creación guiada de recetas DSL a partir de la descripción en lenguaje natural del consultor.
  - `odoo-agent-cli flow test`: Ejecución de pruebas automatizadas contra la base de datos de Staging del cliente antes de promover a producción.
  - `odoo-agent-cli flow export`: Empaquetado seguro en formato cifrado `.odooai`.

#### 4.4 Criterios de Éxito de la Fase 4
- Creación y prueba de un nuevo flujo de trabajo a medida en menos de 30 minutos.
- Cero alteraciones de flujos en producción sin validación previa en Staging y control de versiones Git.

---

## Principios Rectores Innegociables

1. **Sin Módulos Personalizados Obligatorios en Odoo**:
   - Todo se construye sobre capacidades estándar de Odoo 19 (JSON-2, `base.automation`, Chatter y API keys individuales), garantizando portabilidad absoluta entre Odoo Online (SaaS), Odoo.sh y On-Premise.
2. **Seguridad y Permisos Reales de Odoo**:
   - Cada acción en Odoo se ejecuta con las credenciales y reglas de registro (`record rules`) del usuario que representa (empleado u orquestador de servicio).
3. **Cero Secretos Expuestos**:
   - Criptografía estricta (AES-256-GCM / RSA-3072), tokens enmascarados y logs limpios.
4. **Trazabilidad Absoluta en Odoo**:
   - Toda acción, nota o borrador creado por el agente indica con claridad su origen y autorización.
