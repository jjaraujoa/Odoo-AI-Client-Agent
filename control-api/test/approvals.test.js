import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  MAX_BATCH_ITEMS,
  APPROVAL_TTL_MS,
  APPROVAL_TARGETS,
  normalizeApprovalItems,
  fingerprintsEqual,
  sanitizeText,
  renderApprovalSummary,
  createApprovalRequest,
  decideApproval,
  getApprovalStatus,
  setApprovalTelegramMessage,
} from "../src/approvals.js";
import { AppError } from "../src/errors.js";

/**
 * Mock en memoria de la base de datos PostgreSQL con semántica atómica.
 */
function createMockDb() {
  const pendingActions = new Map();
  const actionExecutions = [];

  return {
    pendingActions,
    actionExecutions,
    async query(sql, params = []) {
      const trimmed = sql.trim();

      // INSERT en agent.pending_actions
      if (trimmed.startsWith("INSERT INTO agent.pending_actions")) {
        const id = randomUUID();
        const row = {
          id,
          client_id: params[0],
          linked_user_id: params[1],
          approver_linked_user_id: params[2],
          telegram_chat_id: params[3],
          action_type: "operational_action",
          status: "pending",
          preview: typeof params[4] === "string" ? JSON.parse(params[4]) : params[4],
          items: typeof params[5] === "string" ? JSON.parse(params[5]) : params[5],
          idempotency_key: params[6],
          confirmation_code: params[7],
          expires_at: new Date(params[8]),
          channel: params[9],
          created_at: new Date(),
          confirmed_at: null,
          completed_at: null,
          result: null,
          decided_via: null,
          decision_note: null,
          telegram_message_id: null,
        };
        pendingActions.set(id, row);
        return { rows: [{ id }], rowCount: 1 };
      }

      // INSERT en agent.action_executions
      if (trimmed.startsWith("INSERT INTO agent.action_executions")) {
        const execRow = {
          id: randomUUID(),
          client_id: params[0],
          linked_user_id: params[1],
          action_name: params[2],
          model: params[3],
          res_id: params[4],
          risk_level: params[5] ?? 3,
          status: params[6],
          input_params: typeof params[7] === "string" ? JSON.parse(params[7]) : params[7],
          result_data: typeof params[8] === "string" ? JSON.parse(params[8]) : params[8],
          executed_at: new Date(),
        };
        actionExecutions.push(execRow);
        return { rows: [execRow], rowCount: 1 };
      }

      // UPDATE cancel / modify en agent.pending_actions
      if (trimmed.includes("SET status = 'cancelled'")) {
        const [actionId, clientId, approverId, via, note] = params;
        const row = pendingActions.get(actionId);
        if (!row) return { rows: [], rowCount: 0 };
        if (row.client_id !== clientId) return { rows: [], rowCount: 0 };
        if (row.status !== "pending") return { rows: [], rowCount: 0 };
        if (row.action_type !== "operational_action") return { rows: [], rowCount: 0 };
        if (approverId != null && row.approver_linked_user_id && row.approver_linked_user_id !== approverId) {
          return { rows: [], rowCount: 0 };
        }
        row.status = "cancelled";
        row.decided_via = via;
        row.decision_note = note;
        return { rows: [{ ...row }], rowCount: 1 };
      }

      // UPDATE confirmación atómica: SET status = 'executing'
      if (trimmed.includes("SET status = 'executing'")) {
        const [actionId, clientId, approverId, via] = params;
        const row = pendingActions.get(actionId);
        if (!row) return { rows: [], rowCount: 0 };
        if (row.client_id !== clientId) return { rows: [], rowCount: 0 };
        if (row.status !== "pending") return { rows: [], rowCount: 0 };
        if (row.action_type !== "operational_action") return { rows: [], rowCount: 0 };
        if (new Date(row.expires_at) <= new Date()) return { rows: [], rowCount: 0 };
        if (approverId != null && row.approver_linked_user_id && row.approver_linked_user_id !== approverId) {
          return { rows: [], rowCount: 0 };
        }
        row.status = "executing";
        row.confirmed_at = new Date();
        row.decided_via = via;
        return { rows: [{ ...row }], rowCount: 1 };
      }

      // SELECT estado y expiración para diagnóstico de fallo en confirmación
      if (trimmed.startsWith("SELECT status, expires_at, approver_linked_user_id")) {
        const [actionId, clientId] = params;
        const row = pendingActions.get(actionId);
        if (!row || row.client_id !== clientId || row.action_type !== "operational_action") {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            status: row.status,
            expires_at: row.expires_at,
            approver_linked_user_id: row.approver_linked_user_id,
          }],
          rowCount: 1,
        };
      }

      // UPDATE expiración manual
      if (trimmed.includes("SET status = 'expired'")) {
        const [actionId] = params;
        const row = pendingActions.get(actionId);
        if (row) row.status = "expired";
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      // UPDATE finalización con resultado
      if (trimmed.includes("completed_at = now()")) {
        const [actionId, finalStatus, resultJson] = params;
        const row = pendingActions.get(actionId);
        if (row) {
          row.status = finalStatus;
          row.completed_at = new Date();
          row.result = typeof resultJson === "string" ? JSON.parse(resultJson) : resultJson;
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      // SELECT de consulta getApprovalStatus
      if (trimmed.startsWith("SELECT id, status, preview, result, expires_at")) {
        const [actionId, clientId, linkedUserId] = params;
        const row = pendingActions.get(actionId);
        if (!row || row.client_id !== clientId || row.action_type !== "operational_action") {
          return { rows: [], rowCount: 0 };
        }
        if (linkedUserId != null) {
          const isApprover = row.approver_linked_user_id === linkedUserId;
          const isCreator = row.linked_user_id === linkedUserId;
          if (!isApprover && !isCreator) {
            return { rows: [], rowCount: 0 };
          }
        }
        return {
          rows: [{
            id: row.id,
            status: row.status,
            preview: row.preview,
            result: row.result,
            expires_at: row.expires_at,
          }],
          rowCount: 1,
        };
      }

      // UPDATE telegram_message_id
      if (trimmed.includes("SET telegram_message_id = $2")) {
        const [actionId, messageId] = params;
        const row = pendingActions.get(actionId);
        if (!row || row.action_type !== "operational_action") {
          return { rows: [], rowCount: 0 };
        }
        row.telegram_message_id = messageId;
        return {
          rows: [{ id: row.id, telegram_message_id: messageId }],
          rowCount: 1,
        };
      }

      throw new Error(`Consulta SQL no simulada: ${trimmed}`);
    },
  };
}

/**
 * Mock de cliente Odoo con searchRead, call y create.
 */
function createMockOdoo({ recordsByModel = {}, onCall = null } = {}) {
  const callHistory = [];
  return {
    callHistory,
    async searchRead(model, domain, fields, options = {}) {
      const records = recordsByModel[model] || [];
      let filtered = [...records];
      for (const clause of domain) {
        if (!Array.isArray(clause)) continue;
        const [field, op, val] = clause;
        if (field === "id") {
          if (op === "in") {
            const set = new Set(val);
            filtered = filtered.filter((r) => set.has(Number(r.id)));
          } else if (op === "=") {
            filtered = filtered.filter((r) => Number(r.id) === Number(val));
          }
        }
      }
      if (options.limit) {
        filtered = filtered.slice(0, options.limit);
      }
      return filtered;
    },
    async call(model, method, kwargs = {}) {
      callHistory.push({ model, method, kwargs });
      if (onCall) {
        return onCall(model, method, kwargs);
      }
      return true;
    },
    async create(model, values, context = {}) {
      return 101;
    },
  };
}

// ---------------------------------------------------------------------------
// SUITE DE PRUEBAS
// ---------------------------------------------------------------------------

test("normalizeApprovalItems: valida reglas de IDs, duplicados, límites y whitelist", () => {
  // Duplicados eliminados conservando orden
  const normalized = normalizeApprovalItems("confirmar_orden_venta", {
    resIds: [20, 10, 20, 30, 10],
  });
  assert.deepEqual(normalized.map((i) => i.resId), [20, 10, 30]);

  // Acepta idParam singular o resId
  const single = normalizeApprovalItems("crear_nota_credito", {
    moveId: 55,
    reason: "Corrección contable",
    model: "res.users", // No permitido en whitelist
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].resId, 55);
  assert.deepEqual(single[0].params, { reason: "Corrección contable" });
  assert.equal(single[0].params.model, undefined);

  // Error con IDs inválidos (no enteros positivos)
  assert.throws(
    () => normalizeApprovalItems("confirmar_orden_venta", { resIds: [1, "dos", 3] }),
    (err) => err instanceof AppError && err.code === "invalid_res_id"
  );
  assert.throws(
    () => normalizeApprovalItems("confirmar_orden_venta", { resIds: [0] }),
    (err) => err instanceof AppError && err.code === "invalid_res_id"
  );
  assert.throws(
    () => normalizeApprovalItems("confirmar_orden_venta", { resIds: [-5] }),
    (err) => err instanceof AppError && err.code === "invalid_res_id"
  );
  assert.throws(
    () => normalizeApprovalItems("confirmar_orden_venta", { resIds: [3.14] }),
    (err) => err instanceof AppError && err.code === "invalid_res_id"
  );

  // 0 items
  assert.throws(
    () => normalizeApprovalItems("confirmar_orden_venta", { resIds: [] }),
    (err) => err instanceof AppError && err.code === "empty_items"
  );
  assert.throws(
    () => normalizeApprovalItems("confirmar_orden_venta", {}),
    (err) => err instanceof AppError && err.code === "empty_items"
  );

  // Más de MAX_BATCH_ITEMS (50)
  const tooMany = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => i + 1);
  assert.throws(
    () => normalizeApprovalItems("confirmar_orden_venta", { resIds: tooMany }),
    (err) => err instanceof AppError && err.code === "too_many_items"
  );

  // batch_not_supported cuando batch es false y hay > 1 item
  assert.throws(
    () => normalizeApprovalItems("crear_nota_credito", { resIds: [1, 2] }),
    (err) => err instanceof AppError && err.code === "batch_not_supported"
  );

  // approval_not_supported para acción sin target
  assert.throws(
    () => normalizeApprovalItems("accion_desconocida", { resIds: [1] }),
    (err) => err instanceof AppError && err.code === "approval_not_supported"
  );
});

test("sanitizeText: quita saltos de línea, caracteres de control, extrae many2one y recorta", () => {
  assert.equal(sanitizeText(null), "");
  assert.equal(sanitizeText(undefined), "");
  assert.equal(sanitizeText(false), "");

  // Caracteres de control y saltos de línea
  const messy = "Línea 1\nLínea 2\r\n\tTabulado\u0000Fin";
  assert.equal(sanitizeText(messy, 100), "Línea 1 Línea 2 Tabulado Fin");

  // Colapsar espacios repetidos
  assert.equal(sanitizeText("   Muchos    espacios   en   medio   "), "Muchos espacios en medio");

  // many2one [id, "Nombre"]
  assert.equal(sanitizeText([42, "Distribuidora del Norte S.A.S."]), "Distribuidora del Norte S.A.S.");

  // Recorte a max con elipsis
  const largo = "12345678901234567890";
  assert.equal(sanitizeText(largo, 10), "1234567890…");
});

test("fingerprintsEqual: compara de forma segura las tres claves críticas", () => {
  const f1 = { state: "draft", amount_total: 1500, write_date: "2026-10-18 10:00:00" };
  const f2 = { state: "draft", amount_total: 1500, write_date: "2026-10-18 10:00:00", other: "x" };
  const f3 = { state: "sale", amount_total: 1500, write_date: "2026-10-18 10:00:00" };
  const f4 = { state: "draft", amount_total: 2000, write_date: "2026-10-18 10:00:00" };
  const f5 = { state: "draft", amount_total: 1500, write_date: "2026-10-18 10:05:00" };

  assert.equal(fingerprintsEqual(f1, f2), true);
  assert.equal(fingerprintsEqual(f1, f3), false);
  assert.equal(fingerprintsEqual(f1, f4), false);
  assert.equal(fingerprintsEqual(f1, f5), false);
  assert.equal(fingerprintsEqual(null, f1), false);
  assert.equal(fingerprintsEqual(f1, null), false);
});

test("createApprovalRequest: excluye registros inválidos, sanitiza, no expone confirmation_code", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const odoo = createMockOdoo({
    recordsByModel: {
      "sale.order": [
        {
          id: 1,
          name: "S00001",
          partner_id: [10, "Cliente A"],
          amount_total: 1000,
          currency_id: [1, "USD"],
          state: "draft",
          write_date: "2026-10-18 12:00:00",
        },
        {
          id: 2,
          name: "S00002",
          partner_id: [11, "Cliente B"],
          amount_total: 500,
          currency_id: [1, "USD"],
          state: "cancel", // Estado no permitido para confirmar
          write_date: "2026-10-18 12:00:00",
        },
        // id 3 no existe en Odoo (not_found)
      ],
    },
  });

  const response = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    actionName: "confirmar_orden_venta",
    params: {
      resIds: [1, 2, 3],
      model: "res.users", // Campo no permitido que debe descartarse
    },
    channel: "telegram",
    telegramChatId: 12345678,
  });

  // Validar exclusiones
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].resId, 1);
  assert.equal(response.items[0].params.model, undefined);
  assert.equal(response.excluded.length, 2);
  assert.deepEqual(response.excluded, [
    { resId: 2, reason: "invalid_state", state: "cancel" },
    { resId: 3, reason: "not_found" },
  ]);

  // Verificar que confirmation_code NUNCA se devuelva al llamador
  assert.equal(response.confirmation_code, undefined);
  const jsonStr = JSON.stringify(response);
  assert.equal(jsonStr.includes("confirmation_code"), false);

  // Comprobar que en base de datos sí se guardó confirmation_code
  const savedRow = db.pendingActions.get(response.actionId);
  assert.ok(savedRow.confirmation_code);
  assert.equal(typeof savedRow.confirmation_code, "string");
  assert.equal(jsonStr.includes(savedRow.confirmation_code), false);

  // Verificar inserción en auditoría agent.action_executions
  assert.equal(db.actionExecutions.length, 1);
  assert.equal(db.actionExecutions[0].status, "awaiting_approval");
  assert.equal(db.actionExecutions[0].risk_level, 3);
  assert.equal(db.actionExecutions[0].res_id, 1);

  // Verificar texto del resumen
  assert.ok(response.summaryText.includes("Aprobación requerida: confirmar_orden_venta"));
  assert.ok(response.summaryText.includes("S00001"));
  assert.ok(response.summaryText.includes("Excluidos: #2 (invalid_state: cancel), #3 (not_found)"));
});

test("createApprovalRequest: rechaza canal inválido o solicitud sin registros viables", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const odoo = createMockOdoo({
    recordsByModel: { "sale.order": [] },
  });

  // Canal inválido
  await assert.rejects(
    () => createApprovalRequest({
      db,
      odoo,
      client: { id: clientId },
      actionName: "confirmar_orden_venta",
      params: { resId: 1 },
      channel: "canal_invalido",
    }),
    (err) => err instanceof AppError && err.code === "invalid_channel"
  );

  // Ningún registro válido
  await assert.rejects(
    () => createApprovalRequest({
      db,
      odoo,
      client: { id: clientId },
      actionName: "confirmar_orden_venta",
      params: { resId: 999 },
      channel: "admin",
    }),
    (err) => err instanceof AppError && err.code === "no_valid_items"
  );
});

test("decideApproval: confirm con otro clientId retorna 404 approval_not_found y no llama a Odoo", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const otherClientId = randomUUID();
  const odoo = createMockOdoo({
    recordsByModel: {
      "sale.order": [{ id: 10, state: "draft", amount_total: 100, write_date: "2026-10-18" }],
    },
  });

  const created = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    actionName: "confirmar_orden_venta",
    params: { resId: 10 },
    channel: "admin",
  });

  await assert.rejects(
    () => decideApproval({
      db,
      odoo,
      clientId: otherClientId, // Client ID incorrecto
      actionId: created.actionId,
      decision: "confirm",
      via: "admin_panel",
    }),
    (err) => err instanceof AppError && err.code === "approval_not_found" && err.status === 404
  );

  // Asegurar que Odoo nunca fue invocado
  assert.equal(odoo.callHistory.length, 0);
});

test("decideApproval: deciderLinkedUserId distinto del approver retorna 404 approval_not_found", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const assignedApproverId = randomUUID();
  const differentUserId = randomUUID();

  const odoo = createMockOdoo({
    recordsByModel: {
      "sale.order": [{ id: 10, state: "draft", amount_total: 100, write_date: "2026-10-18" }],
    },
  });

  const created = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    approverLinkedUserId: assignedApproverId,
    actionName: "confirmar_orden_venta",
    params: { resId: 10 },
    channel: "telegram",
  });

  await assert.rejects(
    () => decideApproval({
      db,
      odoo,
      clientId,
      actionId: created.actionId,
      decision: "confirm",
      deciderLinkedUserId: differentUserId, // No es el aprobador asignado
      via: "telegram",
    }),
    (err) => err instanceof AppError && err.code === "approval_not_found" && err.status === 404
  );

  assert.equal(odoo.callHistory.length, 0);
});

test("decideApproval: solicitud vencida retorna 410 approval_expired y marca status='expired'", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const odoo = createMockOdoo({
    recordsByModel: {
      "sale.order": [{ id: 10, state: "draft", amount_total: 100, write_date: "2026-10-18" }],
    },
  });

  const created = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    actionName: "confirmar_orden_venta",
    params: { resId: 10 },
    channel: "workflow",
  });

  // Simular paso del tiempo modificando expires_at al pasado
  const row = db.pendingActions.get(created.actionId);
  row.expires_at = new Date(Date.now() - 1000);

  await assert.rejects(
    () => decideApproval({
      db,
      odoo,
      clientId,
      actionId: created.actionId,
      decision: "confirm",
      via: "workflow",
    }),
    (err) => err instanceof AppError && err.code === "approval_expired" && err.status === 410
  );

  assert.equal(db.pendingActions.get(created.actionId).status, "expired");
  assert.equal(odoo.callHistory.length, 0);
});

test("decideApproval: dos confirm concurrentes (Promise.all) solo ejecutan una vez", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const odoo = createMockOdoo({
    recordsByModel: {
      "sale.order": [{ id: 10, name: "SO010", state: "draft", amount_total: 100, write_date: "2026-10-18" }],
    },
  });

  const created = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    actionName: "confirmar_orden_venta",
    params: { resId: 10 },
    channel: "telegram",
  });

  const results = await Promise.allSettled([
    decideApproval({
      db,
      odoo,
      clientId,
      actionId: created.actionId,
      decision: "confirm",
      via: "telegram",
    }),
    decideApproval({
      db,
      odoo,
      clientId,
      actionId: created.actionId,
      decision: "confirm",
      via: "telegram",
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0].value.status, "completed");
  assert.equal(rejected[0].reason.status, 404);
  assert.equal(rejected[0].reason.code, "approval_not_found");

  // Odoo debió ser llamado exactamente una vez
  assert.equal(odoo.callHistory.length, 1);
  assert.equal(odoo.callHistory[0].method, "action_confirm");
});

test("decideApproval: item con huella cambiada se omite y resulta en status 'partial'", async () => {
  const db = createMockDb();
  const clientId = randomUUID();

  // Dos órdenes iniciales
  const so1 = { id: 1, name: "SO001", state: "draft", amount_total: 100, write_date: "2026-10-18 10:00:00" };
  const so2 = { id: 2, name: "SO002", state: "draft", amount_total: 200, write_date: "2026-10-18 10:00:00" };

  const records = [so1, so2];
  const odoo = createMockOdoo({
    recordsByModel: { "sale.order": records },
  });

  const created = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    actionName: "confirmar_orden_venta",
    params: { resIds: [1, 2] },
    channel: "mcp_elicitation",
  });

  // Alteramos la orden 1 antes de confirmar (cambia el state y write_date)
  so1.state = "sale";
  so1.write_date = "2026-10-18 10:05:00";

  const decisionRes = await decideApproval({
    db,
    odoo,
    clientId,
    actionId: created.actionId,
    decision: "confirm",
    via: "mcp_elicitation",
  });

  assert.equal(decisionRes.status, "partial");
  assert.equal(decisionRes.results.length, 2);

  const r1 = decisionRes.results.find((r) => r.resId === 1);
  const r2 = decisionRes.results.find((r) => r.resId === 2);

  assert.equal(r1.status, "skipped");
  assert.equal(r1.reason, "changed_since_approval");
  assert.equal(r2.status, "executed");

  assert.equal(
    decisionRes.summaryText,
    "1 ejecutadas, 1 omitida (cambió desde la aprobación), 0 fallidas"
  );

  // En la base de datos la fila pending_action debe tener status 'partial'
  const finalRow = db.pendingActions.get(created.actionId);
  assert.equal(finalRow.status, "partial");

  // Auditoría registrada con status 'partial'
  const finalExec = db.actionExecutions[db.actionExecutions.length - 1];
  assert.equal(finalExec.status, "partial");
});

test("decideApproval: decisiones modify y cancel actualizan estado y nota", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const odoo = createMockOdoo({
    recordsByModel: {
      "sale.order": [{ id: 10, state: "draft", amount_total: 100, write_date: "2026-10-18" }],
    },
  });

  // Probar modify
  const createdMod = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    actionName: "confirmar_orden_venta",
    params: { resId: 10 },
    channel: "telegram",
  });

  const modRes = await decideApproval({
    db,
    odoo,
    clientId,
    actionId: createdMod.actionId,
    decision: "modify",
    via: "telegram",
    note: "Por favor aplicar descuento del 10% antes de confirmar.",
  });

  assert.equal(modRes.status, "modification_requested");
  assert.equal(modRes.actionId, createdMod.actionId);
  assert.equal(modRes.note, "Por favor aplicar descuento del 10% antes de confirmar.");

  const rowMod = db.pendingActions.get(createdMod.actionId);
  assert.equal(rowMod.status, "cancelled");
  assert.equal(rowMod.decision_note, "Por favor aplicar descuento del 10% antes de confirmar.");

  // Probar cancel
  const createdCanc = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    actionName: "confirmar_orden_venta",
    params: { resId: 10 },
    channel: "admin",
  });

  const cancRes = await decideApproval({
    db,
    odoo,
    clientId,
    actionId: createdCanc.actionId,
    decision: "cancel",
    via: "admin_ui",
  });

  assert.equal(cancRes.status, "cancelled");
  assert.equal(db.pendingActions.get(createdCanc.actionId).status, "cancelled");
});

test("getApprovalStatus y setApprovalTelegramMessage: trazabilidad sin exponer secretos", async () => {
  const db = createMockDb();
  const clientId = randomUUID();
  const linkedUserId = randomUUID();
  const odoo = createMockOdoo({
    recordsByModel: {
      "stock.picking": [{ id: 88, name: "WH/OUT/0088", state: "assigned", scheduled_date: "2026-10-19", write_date: "2026-10-18" }],
    },
  });

  const created = await createApprovalRequest({
    db,
    odoo,
    client: { id: clientId },
    linkedUser: { id: linkedUserId },
    actionName: "validar_albaran_entrega",
    params: { resId: 88 },
    channel: "telegram",
  });

  // Vincular ID de mensaje de Telegram
  const msgResult = await setApprovalTelegramMessage(db, created.actionId, 987654);
  assert.equal(msgResult.telegram_message_id, 987654);

  // Consultar estado
  const statusRes = await getApprovalStatus({
    db,
    clientId,
    actionId: created.actionId,
    linkedUserId,
  });

  assert.equal(statusRes.actionId, created.actionId);
  assert.equal(statusRes.status, "pending");
  assert.equal(statusRes.actionName, "validar_albaran_entrega");
  assert.equal(statusRes.confirmation_code, undefined);

  // Comprobar que JSON.stringify no contiene confirmation_code
  assert.equal(JSON.stringify(statusRes).includes("confirmation_code"), false);
});
