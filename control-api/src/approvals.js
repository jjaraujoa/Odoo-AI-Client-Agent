import { randomBytes, randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { executeOperationalAction } from "./operational-actions.js";

/**
 * Límite máximo de elementos procesables en una solicitud por lotes.
 */
export const MAX_BATCH_ITEMS = 50;

/**
 * Tiempo de vida (TTL) predeterminado para las solicitudes de aprobación: 5 minutos.
 */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_CHANNELS = new Set(["mcp_elicitation", "telegram", "admin", "workflow"]);

/**
 * Catálogo administrado de acciones operativas sujetas a aprobación humana (Nivel 3).
 */
export const APPROVAL_TARGETS = Object.freeze({
  confirmar_orden_venta: Object.freeze({
    model: "sale.order",
    idParam: "resId",
    fields: ["name", "partner_id", "amount_total", "currency_id", "state", "write_date"],
    allowedStates: ["draft", "sent"],
    extraParams: [],
    batch: true,
  }),
  cancelar_orden_venta: Object.freeze({
    model: "sale.order",
    idParam: "resId",
    fields: ["name", "partner_id", "amount_total", "currency_id", "state", "write_date"],
    allowedStates: ["draft", "sent", "sale"],
    extraParams: [],
    batch: true,
  }),
  validar_albaran_entrega: Object.freeze({
    model: "stock.picking",
    idParam: "resId",
    fields: ["name", "partner_id", "state", "scheduled_date", "write_date"],
    allowedStates: ["confirmed", "waiting", "assigned"],
    extraParams: [],
    batch: true,
  }),
  cancelar_albaran_entrega: Object.freeze({
    model: "stock.picking",
    idParam: "resId",
    fields: ["name", "partner_id", "state", "scheduled_date", "write_date"],
    allowedStates: ["draft", "confirmed", "waiting", "assigned"],
    extraParams: [],
    batch: true,
  }),
  cancelar_factura: Object.freeze({
    model: "account.move",
    idParam: "resId",
    fields: ["name", "partner_id", "amount_total", "currency_id", "state", "write_date"],
    allowedStates: ["draft"],
    extraParams: [],
    batch: true,
  }),
  crear_nota_credito: Object.freeze({
    model: "account.move",
    idParam: "moveId",
    fields: ["name", "partner_id", "amount_total", "currency_id", "state", "write_date"],
    allowedStates: ["posted"],
    extraParams: ["reason", "date", "journalId"],
    batch: false,
  }),
  registrar_pago_factura: Object.freeze({
    model: "account.move",
    idParam: "invoiceId",
    fields: ["name", "partner_id", "amount_total", "currency_id", "state", "write_date"],
    allowedStates: ["posted"],
    extraParams: ["amount", "journalId", "paymentDate", "paymentMethodLineId"],
    batch: false,
  }),
});

/**
 * Normaliza y valida los elementos a ser incluidos en una solicitud de aprobación.
 *
 * @param {string} actionName - Nombre de la acción operativa.
 * @param {object} params - Parámetros de entrada con identificadores y campos adicionales.
 * @returns {Array<{resId: number, params: object}>}
 */
export function normalizeApprovalItems(actionName, params) {
  const target = APPROVAL_TARGETS[actionName];
  if (!target) {
    throw new AppError(
      400,
      "approval_not_supported",
      "Esta acción no admite aprobación humana en este canal."
    );
  }

  const inputParams = params && typeof params === "object" ? params : {};

  let rawIds;
  if (Array.isArray(inputParams.resIds)) {
    rawIds = inputParams.resIds;
  } else if (inputParams[target.idParam] !== undefined && inputParams[target.idParam] !== null) {
    rawIds = [inputParams[target.idParam]];
  } else if (inputParams.resId !== undefined && inputParams.resId !== null) {
    rawIds = [inputParams.resId];
  } else {
    rawIds = [];
  }

  if (rawIds.length === 0) {
    throw new AppError(400, "empty_items", "Debe proporcionar al menos un registro para aprobación.");
  }

  for (const id of rawIds) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(400, "invalid_res_id", `Identificador de registro inválido: ${id}`);
    }
  }

  // Eliminar duplicados conservando el orden de aparición original
  const uniqueIds = [];
  const seen = new Set();
  for (const id of rawIds) {
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  if (uniqueIds.length > MAX_BATCH_ITEMS) {
    throw new AppError(
      400,
      "too_many_items",
      `La cantidad de registros (${uniqueIds.length}) supera el límite permitido de ${MAX_BATCH_ITEMS}.`
    );
  }

  if (!target.batch && uniqueIds.length > 1) {
    throw new AppError(
      400,
      "batch_not_supported",
      "Esta acción no admite ejecución en lote."
    );
  }

  // Filtrado de parámetros mediante lista blanca según target.extraParams
  const allowedExtra = target.extraParams || [];
  const filteredParams = {};
  for (const key of allowedExtra) {
    if (Object.prototype.hasOwnProperty.call(inputParams, key) && inputParams[key] !== undefined) {
      filteredParams[key] = inputParams[key];
    }
  }

  return uniqueIds.map((resId) => ({
    resId,
    params: { ...filteredParams },
  }));
}

/**
 * Extrae la huella digital de un registro para verificar que no haya sido alterado.
 *
 * @param {object} record
 * @returns {{state: any, amount_total: any, write_date: any}}
 */
function fingerprint(record) {
  return {
    state: record?.state ?? null,
    amount_total: record?.amount_total ?? null,
    write_date: record?.write_date ?? null,
  };
}

/**
 * Compara dos huellas digitales o registros determinando si sus atributos críticos son idénticos.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function fingerprintsEqual(a, b) {
  if (!a || !b) return false;
  const fpA = fingerprint(a);
  const fpB = fingerprint(b);
  return (
    fpA.state === fpB.state &&
    fpA.amount_total === fpB.amount_total &&
    fpA.write_date === fpB.write_date
  );
}

/**
 * Sanitiza valores de texto para visualización segura en interfaces humanas y Telegram.
 * Quita caracteres de control, saltos de línea, colapsa espacios y recorta al límite con elipsis.
 *
 * @param {any} value - Valor original o tupla many2one [id, nombre].
 * @param {number} [max=60] - Longitud máxima permitida.
 * @returns {string}
 */
export function sanitizeText(value, max = 60) {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  let str;
  if (Array.isArray(value)) {
    str = value.length > 1 ? String(value[1] ?? "") : String(value[0] ?? "");
  } else {
    str = String(value);
  }

  str = str.replace(/[\u0000-\u001f\u007f]/g, " ");
  str = str.replace(/\s+/g, " ").trim();

  if (str.length > max) {
    return str.slice(0, max) + "…";
  }
  return str;
}

/**
 * Genera un resumen legible en español de una solicitud de aprobación y sus registros.
 *
 * @param {object} options
 * @param {string} options.actionName
 * @param {string} options.model
 * @param {Array<object>} options.items
 * @param {Array<object>} [options.excluded]
 * @param {string} [options.expiresAt]
 * @returns {string}
 */
export function renderApprovalSummary({ actionName, model, items = [], excluded = [], expiresAt }) {
  const count = items.length;
  const lines = [
    `Aprobación requerida: ${actionName} (${count} ${count === 1 ? "registro" : "registros"})`,
  ];

  const displayedItems = items.slice(0, 50);
  for (const item of displayedItems) {
    const disp = item.display || {};
    const parts = [];
    parts.push(disp.name || `#${item.resId}`);
    if (disp.partner) {
      parts.push(disp.partner);
    }
    if (disp.amount_total != null && disp.amount_total !== "") {
      const money = disp.currency ? `${disp.amount_total} ${disp.currency}` : `${disp.amount_total}`;
      parts.push(money);
    }
    let itemLine = `• ${parts.join(" — ")}`;
    if (disp.state) {
      itemLine += ` [${disp.state}]`;
    }
    lines.push(itemLine);
  }

  if (excluded && excluded.length > 0) {
    const excludedStr = excluded
      .map((ex) => `#${ex.resId} (${ex.reason}${ex.state ? `: ${ex.state}` : ""})`)
      .join(", ");
    lines.push(`Excluidos: ${excludedStr}`);
  }

  if (expiresAt) {
    lines.push(`Vence: ${expiresAt}`);
  }

  return lines.join("\n");
}

/**
 * Crea una solicitud formal de aprobación humana para una acción operativa crítica.
 * Valida estado previo en Odoo, registra auditoría y nunca expone el confirmation_code.
 */
export async function createApprovalRequest({
  db,
  odoo,
  client,
  linkedUser = null,
  approverLinkedUserId = null,
  actionName,
  params,
  channel,
  telegramChatId = null,
}) {
  if (!channel || !VALID_CHANNELS.has(channel)) {
    throw new AppError(400, "invalid_channel", "Canal de aprobación no válido.");
  }

  const clientId = client?.id || client;
  if (!clientId) {
    throw new AppError(400, "client_required", "Se requiere el identificador del cliente.");
  }

  const items = normalizeApprovalItems(actionName, params);
  const target = APPROVAL_TARGETS[actionName];
  const ids = items.map((it) => it.resId);

  const records = await odoo.searchRead(
    target.model,
    [["id", "in", ids]],
    target.fields,
    { limit: ids.length }
  );

  const recordsById = new Map();
  for (const rec of (records || [])) {
    recordsById.set(Number(rec.id), rec);
  }

  const included = [];
  const excluded = [];

  for (const item of items) {
    const rec = recordsById.get(item.resId);
    if (!rec) {
      excluded.push({ resId: item.resId, reason: "not_found" });
      continue;
    }
    if (!target.allowedStates.includes(rec.state)) {
      excluded.push({ resId: item.resId, reason: "invalid_state", state: rec.state });
      continue;
    }

    const itemFingerprint = fingerprint(rec);
    const display = {
      name: sanitizeText(rec.name),
      partner: sanitizeText(rec.partner_id),
      amount_total: rec.amount_total != null && rec.amount_total !== false
        ? sanitizeText(rec.amount_total)
        : null,
      currency: rec.currency_id ? sanitizeText(rec.currency_id) : null,
      state: sanitizeText(rec.state),
    };

    included.push({
      resId: item.resId,
      params: item.params,
      fingerprint: itemFingerprint,
      display,
    });
  }

  if (included.length === 0) {
    throw new AppError(
      409,
      "no_valid_items",
      "Ningún registro está en un estado válido para esta acción.",
      { excluded }
    );
  }

  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  const preview = { actionName, model: target.model, excluded };
  const confirmationCode = randomBytes(16).toString("hex");
  const idempotencyKey = randomUUID();

  const insertResult = await db.query(
    `INSERT INTO agent.pending_actions (
       client_id, linked_user_id, approver_linked_user_id, telegram_chat_id,
       action_type, status, preview, items, idempotency_key, confirmation_code,
       expires_at, channel
     ) VALUES ($1, $2, $3, $4, 'operational_action', 'pending', $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      clientId,
      linkedUser?.id ?? null,
      approverLinkedUserId ?? null,
      telegramChatId ?? null,
      JSON.stringify(preview),
      JSON.stringify(included),
      idempotencyKey,
      confirmationCode,
      expiresAt.toISOString(),
      channel,
    ]
  );

  const actionId = insertResult.rows[0].id;

  await db.query(
    `INSERT INTO agent.action_executions
       (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      clientId,
      linkedUser?.id ?? null,
      actionName,
      target.model,
      ids[0],
      3,
      "awaiting_approval",
      JSON.stringify({ resIds: ids }),
      JSON.stringify({ action_id: actionId }),
    ]
  );

  const summaryText = renderApprovalSummary({
    actionName,
    model: target.model,
    items: included,
    excluded,
    expiresAt: expiresAt.toISOString(),
  });

  return {
    actionId,
    actionName,
    model: target.model,
    items: included,
    excluded,
    expiresAt: expiresAt.toISOString(),
    summaryText,
  };
}

/**
 * Resuelve una solicitud de aprobación pendiente ejecutando la decisión tomada.
 */
export async function decideApproval({
  db,
  odoo,
  clientId,
  actionId,
  decision,
  deciderLinkedUserId = null,
  via,
  note = null,
}) {
  if (!clientId) {
    throw new AppError(400, "client_required", "El identificador del cliente es requerido.");
  }

  if (!["confirm", "cancel", "modify"].includes(decision)) {
    throw new AppError(400, "invalid_decision", "Decisión inválida (debe ser confirm, cancel o modify).");
  }

  if (!actionId || typeof actionId !== "string" || !UUID_REGEX.test(actionId)) {
    throw new AppError(404, "approval_not_found", "La solicitud de aprobación no existe o el identificador es inválido.");
  }

  const trimmedNote = note != null ? String(note).slice(0, 500) : null;

  if (decision === "cancel" || decision === "modify") {
    const updateRes = await db.query(
      `UPDATE agent.pending_actions
          SET status = 'cancelled',
              decided_via = $4,
              decision_note = $5
        WHERE id = $1
          AND client_id = $2
          AND status = 'pending'
          AND action_type = 'operational_action'
          AND ($3::uuid IS NULL OR approver_linked_user_id = $3)
        RETURNING *`,
      [actionId, clientId, deciderLinkedUserId, via, trimmedNote]
    );

    if (updateRes.rows.length === 0) {
      throw new AppError(404, "approval_not_found", "La solicitud no existe, ya fue decidida o venció.");
    }

    return {
      status: decision === "modify" ? "modification_requested" : "cancelled",
      actionId,
      note: trimmedNote,
    };
  }

  // Decisión "confirm": transición atómica a estado 'executing'
  const updateRes = await db.query(
    `UPDATE agent.pending_actions
        SET status = 'executing',
            confirmed_at = now(),
            decided_via = $4
      WHERE id = $1
        AND client_id = $2
        AND status = 'pending'
        AND action_type = 'operational_action'
        AND expires_at > now()
        AND ($3::uuid IS NULL OR approver_linked_user_id = $3)
      RETURNING *`,
    [actionId, clientId, deciderLinkedUserId, via]
  );

  const row = updateRes.rows[0];
  if (!row) {
    const checkRes = await db.query(
      `SELECT status, expires_at, approver_linked_user_id
         FROM agent.pending_actions
        WHERE id = $1
          AND client_id = $2
          AND action_type = 'operational_action'`,
      [actionId, clientId]
    );

    const existing = checkRes.rows[0];
    if (existing && existing.status === "pending" && new Date() >= new Date(existing.expires_at)) {
      await db.query(
        `UPDATE agent.pending_actions SET status = 'expired' WHERE id = $1`,
        [actionId]
      );
      throw new AppError(410, "approval_expired", "La solicitud de aprobación ha expirado.");
    }

    throw new AppError(404, "approval_not_found", "La solicitud no existe, ya fue decidida o venció.");
  }

  const preview = typeof row.preview === "string" ? JSON.parse(row.preview) : (row.preview || {});
  const actionName = preview.actionName;
  const target = APPROVAL_TARGETS[actionName];
  const items = Array.isArray(row.items) ? row.items : JSON.parse(row.items || "[]");

  const results = [];
  for (const item of items) {
    const resId = item.resId;

    try {
      // La relectura va dentro del try: si Odoo falla, el item queda como fallido
      // y la solicitud nunca se queda atascada en 'executing'.
      const readRes = await odoo.searchRead(
        target.model,
        [["id", "=", resId]],
        target.fields,
        { limit: 1 }
      );
      const currentRec = readRes?.[0];

      if (!currentRec || !fingerprintsEqual(item.fingerprint, currentRec)) {
        results.push({
          resId,
          status: "skipped",
          reason: "changed_since_approval",
        });
        continue;
      }

      const actionParams = {
        [target.idParam]: resId,
        resId,
        ...(item.params || {}),
      };
      const execResult = await executeOperationalAction(actionName, odoo, actionParams);
      results.push({
        resId,
        status: "executed",
        summary: execResult.summary,
      });
    } catch (err) {
      results.push({
        resId,
        status: "failed",
        error: String(err?.message || "Error desconocido").slice(0, 300),
      });
    }
  }

  const executedCount = results.filter((r) => r.status === "executed").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  let finalStatus;
  if (executedCount === results.length) {
    finalStatus = "completed";
  } else if (executedCount === 0) {
    finalStatus = "failed";
  } else {
    finalStatus = "partial";
  }

  await db.query(
    `UPDATE agent.pending_actions
        SET status = $2,
            completed_at = now(),
            result = $3
      WHERE id = $1`,
    [actionId, finalStatus, JSON.stringify(results)]
  );

  const execStatusMap = {
    completed: "approved",
    partial: "partial",
    failed: "failed",
  };
  const execStatus = execStatusMap[finalStatus] || "failed";
  const resIds = items.map((it) => it.resId);

  await db.query(
    `INSERT INTO agent.action_executions
       (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      clientId,
      deciderLinkedUserId ?? null,
      actionName,
      target.model,
      resIds[0] ?? null,
      3,
      execStatus,
      JSON.stringify({ resIds }),
      JSON.stringify({ results }),
    ]
  );

  const skippedText = skippedCount === 1
    ? "1 omitida (cambió desde la aprobación)"
    : `${skippedCount} omitidas (cambiaron desde la aprobación)`;
  const summaryText = `${executedCount} ejecutadas, ${skippedText}, ${failedCount} fallidas`;

  return {
    status: finalStatus,
    actionId,
    actionName,
    results,
    summaryText,
  };
}

/**
 * Consulta el estado actual de una solicitud de aprobación verificando permisos de acceso.
 * Nunca expone confirmation_code.
 */
export async function getApprovalStatus({ db, clientId, actionId, linkedUserId = null }) {
  if (!clientId) {
    throw new AppError(400, "client_required", "El identificador del cliente es requerido.");
  }

  if (!actionId || typeof actionId !== "string" || !UUID_REGEX.test(actionId)) {
    throw new AppError(404, "approval_not_found", "Solicitud de aprobación no encontrada.");
  }

  const res = await db.query(
    `SELECT id, status, preview, result, expires_at
       FROM agent.pending_actions
      WHERE id = $1
        AND client_id = $2
        AND action_type = 'operational_action'
        AND ($3::uuid IS NULL OR approver_linked_user_id = $3 OR linked_user_id = $3)`,
    [actionId, clientId, linkedUserId]
  );

  const row = res.rows[0];
  if (!row) {
    throw new AppError(404, "approval_not_found", "Solicitud de aprobación no encontrada.");
  }

  const preview = typeof row.preview === "string" ? JSON.parse(row.preview) : (row.preview || {});
  const result = typeof row.result === "string" ? JSON.parse(row.result) : (row.result || null);
  const expiresAt = row.expires_at instanceof Date
    ? row.expires_at.toISOString()
    : new Date(row.expires_at).toISOString();

  return {
    actionId: row.id,
    status: row.status,
    actionName: preview.actionName,
    expiresAt,
    result,
  };
}

/**
 * Vincula el identificador de mensaje de Telegram a una acción pendiente para trazabilidad interactiva.
 */
export async function setApprovalTelegramMessage(db, actionId, messageId) {
  if (!actionId || typeof actionId !== "string" || !UUID_REGEX.test(actionId)) {
    throw new AppError(404, "approval_not_found", "Identificador de acción inválido.");
  }

  const msgId = Number(messageId);
  if (!Number.isInteger(msgId)) {
    throw new AppError(400, "invalid_message_id", "El identificador del mensaje debe ser un entero.");
  }

  const res = await db.query(
    `UPDATE agent.pending_actions
        SET telegram_message_id = $2
      WHERE id = $1
        AND action_type = 'operational_action'
      RETURNING id, telegram_message_id`,
    [actionId, msgId]
  );

  if (res.rows.length === 0) {
    throw new AppError(404, "approval_not_found", "Solicitud de aprobación no encontrada.");
  }

  return res.rows[0];
}
