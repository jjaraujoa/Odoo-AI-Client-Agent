import test from "node:test";
import assert from "node:assert/strict";
import {
  createDraftSaleOrder,
  createDraftCustomerInvoice,
  assignResponsibleUser,
  changeRecordStage,
  confirmSaleOrder,
  validateStockPicking,
} from "../src/operational-actions.js";
import { requestOrExecuteAction, confirmOperationalAction } from "../src/governance.js";

test("createDraftSaleOrder valida parámetros y genera orden borrador en Odoo", async () => {
  const calls = [];
  const mockOdoo = {
    async create(model, values, context) {
      calls.push({ model, values, context });
      return [{ id: 801 }];
    },
  };

  const res = await createDraftSaleOrder(mockOdoo, {
    partnerId: 42,
    orderLines: [{ productId: 10, quantity: 2, priceUnit: 15000, name: "Producto A" }],
    note: "Entrega urgente",
  });

  assert.equal(res.success, true);
  assert.equal(res.record_id, 801);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "sale.order");
  assert.equal(calls[0].values.partner_id, 42);
  assert.equal(calls[0].values.state, "draft");
  assert.equal(calls[0].values.note, "Entrega urgente");
  assert.deepEqual(calls[0].values.order_line, [[0, 0, {
    product_id: 10,
    product_uom_qty: 2,
    price_unit: 15000,
    name: "Producto A",
  }]]);

  // Validar errores
  await assert.rejects(
    () => createDraftSaleOrder(mockOdoo, { partnerId: "invalido", orderLines: [{ productId: 1 }] }),
    { code: "invalid_partner_id" },
  );
  await assert.rejects(
    () => createDraftSaleOrder(mockOdoo, { partnerId: 42, orderLines: [] }),
    { code: "empty_order_lines" },
  );
});

test("createDraftCustomerInvoice crea factura borrador tipo out_invoice", async () => {
  const calls = [];
  const mockOdoo = {
    async create(model, values, context) {
      calls.push({ model, values, context });
      return [{ id: 902 }];
    },
  };

  const res = await createDraftCustomerInvoice(mockOdoo, {
    partnerId: 15,
    invoiceDate: "2026-09-17",
    ref: "REF-001",
    invoiceLines: [{ productId: 5, quantity: 1, priceUnit: 80000 }],
  });

  assert.equal(res.success, true);
  assert.equal(res.record_id, 902);
  assert.equal(calls[0].model, "account.move");
  assert.equal(calls[0].values.move_type, "out_invoice");
  assert.equal(calls[0].values.partner_id, 15);
  assert.equal(calls[0].values.ref, "REF-001");
});

test("assignResponsibleUser reasigna usuario en modelos soportados", async () => {
  const calls = [];
  const mockOdoo = {
    async write(model, id, vals, context) {
      calls.push({ model, id, vals, context });
      return true;
    },
  };

  const res = await assignResponsibleUser(mockOdoo, {
    model: "sale.order",
    resId: 100,
    userId: 7,
  });

  assert.equal(res.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "sale.order");
  assert.equal(calls[0].id, 100);
  assert.deepEqual(calls[0].vals, { user_id: 7 });

  // Error en modelo no soportado
  await assert.rejects(
    () => assignResponsibleUser(mockOdoo, { model: "res.users", resId: 10, userId: 2 }),
    { code: "unsupported_model" },
  );
});

test("confirmSaleOrder y validateStockPicking invocan los métodos nativos de Odoo", async () => {
  const calls = [];
  const mockOdoo = {
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
  };

  const saleRes = await confirmSaleOrder(mockOdoo, { resId: 50 });
  assert.equal(saleRes.success, true);
  assert.equal(calls[0].model, "sale.order");
  assert.equal(calls[0].method, "action_confirm");
  assert.deepEqual(calls[0].body.ids, [50]);

  const pickingRes = await validateStockPicking(mockOdoo, { resId: 88 });
  assert.equal(pickingRes.success, true);
  assert.equal(calls[1].model, "stock.picking");
  assert.equal(calls[1].method, "button_validate");
  assert.deepEqual(calls[1].body.ids, [88]);
});

test("requestOrExecuteAction respeta la matriz de gobernanza de 3 niveles", async () => {
  const executionsTable = [];
  const pendingActions = [];

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("FROM agent.tool_policies")) {
        const toolName = params[1];
        if (toolName === "crear_borrador_orden_venta") {
          return { rows: [{ tool_name: toolName, risk_level: 1, confirmation_required: false, enabled: true }] };
        }
        if (toolName === "cambiar_etapa_registro") {
          return { rows: [{ tool_name: toolName, risk_level: 2, confirmation_required: false, enabled: true }] };
        }
        if (toolName === "confirmar_orden_venta") {
          return { rows: [{ tool_name: toolName, risk_level: 3, confirmation_required: true, enabled: true }] };
        }
      }
      if (sql.includes("INSERT INTO agent.action_executions")) {
        executionsTable.push(params);
        return { rows: [{ id: "exec-1" }] };
      }
      if (sql.includes("INSERT INTO agent.pending_actions")) {
        pendingActions.push(params);
        return { rows: [{ id: "b0000000-0000-4000-8000-000000000001" }] };
      }
      if (sql.includes("FROM agent.channel_credentials")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const mockOdoo = {
    async create() { return [{ id: 101 }]; },
    async write() { return true; },
    async call() { return true; },
    async searchRead() {
      return [{ id: 101, name: "SO-101", state: "draft", amount_total: 1000, partner_id: [1, "Cliente A"], write_date: "2026-10-18" }];
    },
  };

  const client = {
    id: "a0000000-0000-4000-8000-000000000001",
    odoo_base_url: "https://odoo.local",
    settings: {},
  };
  const config = { credentialMasterKey: Buffer.alloc(32, 1) };

  // 1. Nivel 1: Autónomo (ejecución directa)
  const l1Res = await requestOrExecuteAction({
    db: mockDb,
    config,
    client,
    actionName: "crear_borrador_orden_venta",
    params: { partnerId: 1, orderLines: [{ productId: 2, quantity: 1, priceUnit: 100 }] },
    odoo: mockOdoo,
  });
  assert.equal(l1Res.status, "executed");
  assert.equal(l1Res.risk_level, 1);
  assert.equal(l1Res.result.record_id, 101);

  // 2. Nivel 2: Asistido (ejecución directa con aviso)
  const l2Res = await requestOrExecuteAction({
    db: mockDb,
    config,
    client,
    actionName: "cambiar_etapa_registro",
    params: { model: "sale.order", resId: 101, state: "sent" },
    odoo: mockOdoo,
  });
  assert.equal(l2Res.status, "executed");
  assert.equal(l2Res.risk_level, 2);

  // 3. Nivel 3: Crítico (bloqueo interactivo, no toca Odoo de inmediato)
  const l3Res = await requestOrExecuteAction({
    db: mockDb,
    config,
    client,
    actionName: "confirmar_orden_venta",
    params: { resId: 101 },
    odoo: mockOdoo,
    approvalChannel: "admin",
  });
  assert.equal(l3Res.status, "awaiting_approval");
  assert.equal(l3Res.risk_level, 3);
  assert.equal(l3Res.action_id, "b0000000-0000-4000-8000-000000000001");
  assert.equal(l3Res.confirmation_code, undefined);
  assert.equal(pendingActions.length, 1);
  assert.equal(l3Res.message, "Pendiente de aprobación por un administrador.");
});

test("confirmOperationalAction valida y ejecuta acción pendiente vía decideApproval", async () => {
  const calls = [];
  const mockOdoo = {
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
    async searchRead() {
      return [{ id: 77, name: "SO-077", state: "draft", amount_total: 50000, write_date: "2026-10-18" }];
    },
  };

  const actionRecord = {
    id: "c0000000-0000-4000-8000-000000000077",
    client_id: "a0000000-0000-4000-8000-000000000001",
    status: "executing",
    expires_at: new Date(Date.now() + 60000).toISOString(),
    preview: JSON.stringify({
      actionName: "confirmar_orden_venta",
    }),
    items: JSON.stringify([
      {
        resId: 77,
        fingerprint: { state: "draft", amount_total: 50000, write_date: "2026-10-18" },
        params: {},
      },
    ]),
  };

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("UPDATE agent.pending_actions") && sql.includes("status = 'executing'")) {
        return { rows: [actionRecord] };
      }
      if (sql.includes("UPDATE agent.pending_actions") && sql.includes("status = $2")) {
        return { rows: [{ ...actionRecord, status: params[1] }] };
      }
      if (sql.includes("INSERT INTO agent.action_executions")) {
        return { rows: [{ id: "exec-2" }] };
      }
      return { rows: [] };
    },
  };

  // Error con decisión inválida
  await assert.rejects(
    () => confirmOperationalAction({
      db: mockDb,
      odoo: mockOdoo,
      clientId: "a0000000-0000-4000-8000-000000000001",
      actionId: "c0000000-0000-4000-8000-000000000077",
      decision: "invalid_choice",
    }),
    { code: "invalid_decision" },
  );

  // Confirmación exitosa
  const confirmed = await confirmOperationalAction({
    db: mockDb,
    odoo: mockOdoo,
    clientId: "a0000000-0000-4000-8000-000000000001",
    actionId: "c0000000-0000-4000-8000-000000000077",
    decision: "confirm",
    confirmedByUserId: "user-1",
  });

  assert.equal(confirmed.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "sale.order");
  assert.equal(calls[0].method, "action_confirm");
});
