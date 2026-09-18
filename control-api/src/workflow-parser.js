import YAML from "yaml";
import { AppError } from "./errors.js";

const VALID_TRIGGERS = new Set(["on_write", "on_create", "on_unlink", "on_time"]);
const VALID_POLICIES = new Set(["autonomous", "assisted", "critical"]);

export function parseWorkflowYaml(yamlString) {
  if (!yamlString || typeof yamlString !== "string" || !yamlString.trim()) {
    throw new AppError(400, "invalid_workflow_yaml", "El contenido YAML del flujo no puede estar vacío.");
  }

  let doc;
  try {
    doc = YAML.parse(yamlString);
  } catch (err) {
    throw new AppError(400, "workflow_syntax_error", `Error de sintaxis YAML en el flujo: ${err.message}`);
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new AppError(400, "invalid_workflow_shape", "El flujo debe ser un objeto YAML.");
  }

  // Validar campos raíz
  if (!doc.name || typeof doc.name !== "string") {
    throw new AppError(400, "missing_workflow_name", "El flujo requiere un 'name' válido (string).");
  }

  // Validar trigger
  if (!doc.trigger || typeof doc.trigger !== "object") {
    throw new AppError(400, "missing_workflow_trigger", "El flujo requiere una sección 'trigger'.");
  }

  if (!doc.trigger.model || typeof doc.trigger.model !== "string") {
    throw new AppError(400, "invalid_trigger_model", "El trigger debe especificar un 'model' de Odoo (ej. 'sale.order').");
  }

  if (doc.trigger.event && !VALID_TRIGGERS.has(doc.trigger.event)) {
    throw new AppError(
      400,
      "invalid_trigger_event",
      `Evento de trigger inválido: ${doc.trigger.event}. Permitidos: ${[...VALID_TRIGGERS].join(", ")}`,
    );
  }

  // Validar acciones
  if (!Array.isArray(doc.actions) || doc.actions.length === 0) {
    throw new AppError(400, "missing_workflow_actions", "El flujo debe contener una lista de 'actions'.");
  }

  for (let i = 0; i < doc.actions.length; i++) {
    const act = doc.actions[i];
    if (!act || typeof act !== "object") {
      throw new AppError(400, "invalid_action", `La acción #${i + 1} debe ser un objeto.`);
    }
    if (!act.action || typeof act.action !== "string") {
      throw new AppError(400, "invalid_action_name", `La acción #${i + 1} requiere un campo 'action'.`);
    }
    if (act.policy && !VALID_POLICIES.has(act.policy)) {
      throw new AppError(
        400,
        "invalid_action_policy",
        `Política inválida en acción #${i + 1}: ${act.policy}. Permitidas: ${[...VALID_POLICIES].join(", ")}`,
      );
    }
  }

  return doc;
}

/**
 * Extrae el valor de una ruta de propiedad segura como "record.state" o "record.amount_total"
 */
function resolvePath(path, context) {
  const parts = path.split(".");
  let current = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Parsea un literal (número, string, booleano, array, null) o resuelve una variable
 */
function parseTokenValue(token, context) {
  const trimmed = token.trim();

  // String con comillas simples o dobles
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }

  // Booleano
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "None") return null;

  // Número
  if (!Number.isNaN(Number(trimmed)) && trimmed !== "") {
    return Number(trimmed);
  }

  // Array simple literal: ['a', 'b'] o [1, 2]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const items = trimmed.slice(1, -1).split(",").map((s) => parseTokenValue(s, context));
    return items;
  }

  // Variable de contexto (ej. record.state o event.user_id)
  return resolvePath(trimmed, context);
}

/**
 * Evalúa una única comparación atómica, ej: record.state == 'sale'
 */
function evaluateComparison(expr, context) {
  const opRegex = /(==|!=|<=|>=|<|>|\bin\b)/;
  const match = expr.match(opRegex);

  if (!match) {
    // Si es solo una variable booleana, ej. "record.urgent"
    const val = parseTokenValue(expr, context);
    return Boolean(val);
  }

  const op = match[1];
  const parts = expr.split(op);
  const left = parseTokenValue(parts[0], context);
  const right = parseTokenValue(parts.slice(1).join(op), context);

  switch (op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
      return Number(left) < Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case ">":
      return Number(left) > Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "in":
      if (Array.isArray(right)) {
        return right.includes(left);
      }
      if (typeof right === "string") {
        return right.includes(String(left));
      }
      return false;
    default:
      return false;
  }
}

/**
 * Evaluador determinista de expresiones lógicas (Zero-Tokens & sin eval)
 * Soporta 'and', 'or', 'not' y comparaciones relacionales.
 */
export function evaluateCondition(conditionStr, context = {}) {
  if (!conditionStr || typeof conditionStr !== "string" || !conditionStr.trim()) {
    return true; // Sin condición = siempre aplica
  }

  const raw = conditionStr.trim();

  // Dividir por cláusulas 'or' de menor precedencia
  const orClauses = raw.split(/\s+\bor\b\s+|\s*\|\|\s*/i);
  for (const orClause of orClauses) {
    // Cada cláusula OR se evalúa como AND de sub-expresiones
    const andClauses = orClause.split(/\s+\band\b\s+|\s*&&\s*/i);
    let andResult = true;

    for (const andClause of andClauses) {
      let trimmedAnd = andClause.trim();
      let negate = false;

      if (trimmedAnd.startsWith("not ") || trimmedAnd.startsWith("!")) {
        negate = true;
        trimmedAnd = trimmedAnd.replace(/^(not\s+|!\s*)/i, "").trim();
      }

      const cmpResult = evaluateComparison(trimmedAnd, context);
      const finalVal = negate ? !cmpResult : cmpResult;

      if (!finalVal) {
        andResult = false;
        break; // Cortocircuito AND
      }
    }

    if (andResult) {
      return true; // Cortocircuito OR
    }
  }

  return false;
}
