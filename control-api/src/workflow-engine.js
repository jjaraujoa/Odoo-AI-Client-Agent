import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowYaml, evaluateCondition } from "./workflow-parser.js";
import { requestOrExecuteAction } from "./governance.js";
import { deliverTelegramMessage } from "./telegram.js";
import { AppError } from "./errors.js";

/**
 * Carga flujos de trabajo desde el sistema de archivos local (clients/<slug>/workflows/)
 * y desde la base de datos auxiliar (agent.workflow_definitions).
 */
export async function loadWorkflowsForClient(db, client, baseDir = process.cwd()) {
  const workflows = [];
  const slug = client.slug;

  // 1. Cargar desde sistema de archivos si la carpeta existe
  let workflowsDir = join(baseDir, "clients", slug, "workflows");
  try {
    await readdir(workflowsDir);
  } catch {
    workflowsDir = join(baseDir, "..", "clients", slug, "workflows");
  }

  try {
    const files = await readdir(workflowsDir);
    for (const file of files) {
      if (file.endsWith(".yaml") || file.endsWith(".yml")) {
        try {
          const content = await readFile(join(workflowsDir, file), "utf8");
          const parsed = parseWorkflowYaml(content);
          parsed.source = "file";
          parsed.filename = file;
          workflows.push(parsed);
        } catch (err) {
          process.stderr.write(`[workflow-engine] Error leyendo flujo ${file}: ${err.message}\n`);
        }
      }
    }
  } catch {
    // Directorio de flujos locales no existe para este cliente, continuar
  }

  // 2. Cargar desde base de datos
  try {
    const res = await db.query(
      `SELECT id, slug, name, definition_yaml, parsed_definition
         FROM agent.workflow_definitions
        WHERE client_id = $1 AND active = true`,
      [client.id],
    );
    for (const row of res.rows) {
      const parsed = row.parsed_definition || parseWorkflowYaml(row.definition_yaml);
      parsed.db_id = row.id;
      parsed.source = "db";
      // Si no fue cargado previamente desde archivo con el mismo slug/name
      if (!workflows.some((w) => w.name === parsed.name)) {
        workflows.push(parsed);
      }
    }
  } catch {
    // Si la tabla aún no existe o hay error de conexión a BD
  }

  return workflows;
}

/**
 * Normaliza nombres de acción entre el DSL declarativo y las herramientas de gobernanza
 */
function mapDslActionToToolName(dslAction) {
  const map = {
    "odoo.create_draft_invoice": "crear_borrador_factura_cliente",
    "odoo.create_draft_sale_order": "crear_borrador_orden_venta",
    "odoo.assign_responsible": "asignar_responsable",
    "odoo.change_stage": "cambiar_etapa_registro",
    "odoo.confirm_sale_order": "confirmar_orden_venta",
    "odoo.validate_picking": "validar_albaran_entrega",
    "odoo.request_approval": "confirmar_orden_venta", // Nivel 3 gobernado
  };
  return map[dslAction] || dslAction;
}

/**
 * Renderiza plantillas de texto sencillas reemplazando {record.campo} o {event.campo}
 */
function interpolateTemplate(template, context) {
  if (!template || typeof template !== "string") return "";
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, path) => {
    const parts = path.split(".");
    let curr = context;
    for (const p of parts) {
      if (curr === null || curr === undefined) return "";
      curr = curr[p];
    }
    return curr !== undefined && curr !== null ? String(curr) : "";
  });
}

/**
 * Motor central de ejecución: procesa un evento entrante contra los flujos activos del cliente.
 */
export async function processEventThroughWorkflows({
  db,
  config,
  odoo,
  client,
  event,
  baseDir = process.cwd(),
}) {
  const started = Date.now();
  const workflows = await loadWorkflowsForClient(db, client, baseDir);
  const results = [];

  if (workflows.length === 0) {
    return { triggered: 0, executions: [] };
  }

  // Obtener datos del registro en Odoo para evaluar condiciones
  let record = event.record || null;
  if (!record && odoo && odoo.searchRead && event.model && event.res_id) {
    try {
      const records = await odoo.searchRead(
        event.model,
        [["id", "=", Number(event.res_id)]],
        [],
        { limit: 1 },
      );
      record = records[0] || {};
    } catch (err) {
      process.stderr.write(`[workflow-engine] No se pudo obtener el registro ${event.model}:${event.res_id}: ${err.message}\n`);
      record = {};
    }
  }

  const evalContext = {
    record: record || {},
    event: event || {},
    client: client || {},
  };

  for (const workflow of workflows) {
    // 1. Filtrar por modelo
    if (workflow.trigger.model !== event.model) {
      continue;
    }

    // 2. Filtrar por evento si se especifica
    if (workflow.trigger.event && event.event && workflow.trigger.event !== event.event) {
      continue;
    }

    // 3. Evaluar condición declarativa (Zero-Tokens)
    const matchesCondition = evaluateCondition(workflow.trigger.condition, evalContext);
    if (!matchesCondition) {
      continue;
    }

    // Ejecutar flujo
    const stepResults = [];
    let flowStatus = "completed";
    let pendingActionId = null;
    let errorMessage = null;

    for (const step of workflow.actions) {
      const actionName = mapDslActionToToolName(step.action);
      const params = {
        model: event.model,
        resId: Number(event.res_id),
        partnerId: record?.partner_id ? (Array.isArray(record.partner_id) ? record.partner_id[0] : record.partner_id) : undefined,
        ...(step.params || {}),
      };

      try {
        const actionResult = await requestOrExecuteAction({
          db,
          config,
          client,
          actionName,
          params,
          odoo,
        });

        stepResults.push({
          step: step.step || stepResults.length + 1,
          action: actionName,
          status: actionResult.status,
          result: actionResult,
        });

        if (actionResult.status === "awaiting_approval" || actionResult.status === "pending_approval") {
          flowStatus = "pending_approval";
          pendingActionId = actionResult.action_id;
          // Detener pasos automáticos siguientes hasta aprobación humana
          break;
        }
      } catch (err) {
        flowStatus = "failed";
        errorMessage = err.message;
        stepResults.push({
          step: step.step || stepResults.length + 1,
          action: actionName,
          status: "failed",
          error: err.message,
        });
        break;
      }
    }

    // 4. Despachar notificaciones si el flujo no falló
    if (flowStatus !== "failed" && workflow.notifications) {
      // Notificación Chatter
      if (workflow.notifications.chatter && odoo?.postChatterMessage) {
        const chatterTarget = workflow.notifications.chatter.target || event.model;
        const msg = interpolateTemplate(workflow.notifications.chatter.template, evalContext);
        try {
          await odoo.postChatterMessage(chatterTarget, Number(event.res_id), msg);
          stepResults.push({ notification: "chatter", target: chatterTarget, message: msg, delivered: true });
        } catch (err) {
          stepResults.push({ notification: "chatter", error: err.message, delivered: false });
        }
      }
    }

    // 5. Auditar ejecución en base de datos si existe la tabla
    try {
      await db.query(
        `INSERT INTO agent.workflow_executions
           (client_id, trigger_model, trigger_res_id, trigger_event,
            status, step_results, pending_action_id, error_message, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          client.id,
          event.model,
          Number(event.res_id),
          event.event || "on_write",
          flowStatus,
          JSON.stringify(stepResults),
          pendingActionId,
          errorMessage,
          Date.now() - started,
        ],
      );
    } catch {
      // Continuar si la tabla no está creada en tests unitarios sin migración
    }

    results.push({
      workflow_name: workflow.name,
      status: flowStatus,
      steps: stepResults,
      pending_action_id: pendingActionId,
      error: errorMessage,
    });
  }

  return {
    triggered: results.length,
    executions: results,
    duration_ms: Date.now() - started,
  };
}
