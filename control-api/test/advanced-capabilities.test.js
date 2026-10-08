import test from "node:test";
import assert from "node:assert/strict";
import {
  registerInvoicePayment,
  createSaleAdvancePayment,
  createCreditNote,
  convertCrmLead,
  markCrmLeadLost,
  cancelSaleOrder,
  cancelInvoice,
  cancelStockPicking,
  OPERATIONAL_ACTIONS,
} from "../src/operational-actions.js";
import {
  requestOrExecuteAction,
  confirmOperationalAction,
} from "../src/governance.js";
import {
  toUnicodeEscapes,
  normalizeDomainTo2d,
  sanitizeOdooViewLink,
  validateSpreadsheetDefinition,
  inspectDashboard,
  createOrUpdateDashboard,
} from "../src/spreadsheet.js";
import {
  inspectStudioFields,
  auditFunctionalConfiguration,
} from "../src/audit-business.js";
import { McpServer, MCP_TOOLS } from "../src/mcp-server.js";

// ============================================================================
// 1. WIZARDS TRANSACCIONALES Y ZERO-UNLINK
// ============================================================================

test("registerInvoicePayment crea wizard account.payment.register y ejecuta pagos", async () => {
  const calls = [];
  const creates = [];
  const mockOdoo = {
    async create(model, values, context) {
      creates.push({ model, values, context });
      return 88;
    },
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
  };

  const res = await registerInvoicePayment(mockOdoo, {
    invoiceId: 10,
    amount: 150000,
    journalId: 5,
    paymentDate: "2026-10-07",
  });

  assert.equal(res.success, true);
  assert.equal(res.record_id, 10);
  assert.equal(res.wizard_id, 88);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].model, "account.payment.register");
  assert.equal(creates[0].context.active_model, "account.move");
  assert.deepEqual(creates[0].context.active_ids, [10]);
  assert.equal(calls[0].method, "action_create_payments");
});

test("createSaleAdvancePayment crea wizard sale.advance.payment.inv y genera facturas", async () => {
  const calls = [];
  const creates = [];
  const mockOdoo = {
    async create(model, values, context) {
      creates.push({ model, values, context });
      return 99;
    },
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
  };

  const res = await createSaleAdvancePayment(mockOdoo, {
    saleOrderId: 45,
    advancePaymentMethod: "percentage",
    amount: 30,
  });

  assert.equal(res.success, true);
  assert.equal(res.record_id, 45);
  assert.equal(res.wizard_id, 99);
  assert.equal(creates[0].model, "sale.advance.payment.inv");
  assert.equal(calls[0].method, "create_invoices");
});

test("createCreditNote crea rectificativa mediante account.move.reversal", async () => {
  const calls = [];
  const creates = [];
  const mockOdoo = {
    async create(model, values, context) {
      creates.push({ model, values, context });
      return 77;
    },
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
  };

  const res = await createCreditNote(mockOdoo, {
    moveId: 50,
    reason: "Devolución por garantía",
  });

  assert.equal(res.success, true);
  assert.equal(res.record_id, 50);
  assert.equal(res.wizard_id, 77);
  assert.equal(creates[0].model, "account.move.reversal");
  assert.equal(calls[0].method, "reverse_moves");
});

test("convertCrmLead convierte iniciativa mediante crm.lead2opportunity.partner", async () => {
  const calls = [];
  const creates = [];
  const mockOdoo = {
    async create(model, values, context) {
      creates.push({ model, values, context });
      return 66;
    },
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
  };

  const res = await convertCrmLead(mockOdoo, {
    leadId: 300,
    action: "create",
  });

  assert.equal(res.success, true);
  assert.equal(res.record_id, 300);
  assert.equal(res.wizard_id, 66);
  assert.equal(creates[0].model, "crm.lead2opportunity.partner");
  assert.equal(calls[0].method, "action_apply");
});

test("markCrmLeadLost marca oportunidad como perdida mediante crm.lead.lost", async () => {
  const calls = [];
  const creates = [];
  const mockOdoo = {
    async create(model, values, context) {
      creates.push({ model, values, context });
      return 55;
    },
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
  };

  const res = await markCrmLeadLost(mockOdoo, {
    leadId: 301,
    lostReasonId: 2,
  });

  assert.equal(res.success, true);
  assert.equal(res.record_id, 301);
  assert.equal(res.wizard_id, 55);
  assert.equal(creates[0].model, "crm.lead.lost");
  assert.equal(calls[0].method, "action_lost_reason_apply");
});

test("Acciones de compensación Zero-Unlink cancelan sin eliminar registros", async () => {
  const calls = [];
  const mockOdoo = {
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
  };

  await cancelSaleOrder(mockOdoo, { resId: 10 });
  await cancelInvoice(mockOdoo, { resId: 20 });
  await cancelStockPicking(mockOdoo, { resId: 30 });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].model, "sale.order");
  assert.equal(calls[0].method, "action_cancel");
  assert.equal(calls[1].model, "account.move");
  assert.equal(calls[1].method, "button_cancel");
  assert.equal(calls[2].model, "stock.picking");
  assert.equal(calls[2].method, "action_cancel");

  // Verificar que ninguna llamada usó 'unlink'
  assert.ok(!calls.some((c) => c.method === "unlink"));
});

// ============================================================================
// 2. GOBERNANZA ADAPTATIVA (STAGING vs PRODUCCIÓN)
// ============================================================================

test("Gobernanza en Staging auto-aprueba acciones de Nivel 3 sin código interactivo", async () => {
  const mockOdoo = {
    async call() {
      return true;
    },
  };

  const mockDb = {
    async query(sql) {
      if (sql.includes("agent.tool_policies")) {
        return { rows: [{ risk_level: 3, confirmation_required: true, allowed_fields: ["id"] }] };
      }
      return { rows: [] };
    },
  };

  // Cliente configurado en entorno staging
  const stagingClient = {
    id: "client-stag",
    name: "Empresa Staging",
    slug: "empresa-stag",
    settings: { environment: "staging" },
  };

  const res = await requestOrExecuteAction({
    db: mockDb,
    client: stagingClient,
    linkedUser: { id: "user-1", email: "consultor@xeta.co" },
    actionName: "confirmar_orden_venta",
    params: { resId: 50 },
    odoo: mockOdoo,
    config: {},
  });

  assert.equal(res.status, "executed");
  assert.equal(res.staging_bypass, true);
  assert.equal(res.environment, "staging");
  assert.ok(res.note.includes("Auto-aprobado en entorno Staging"));
});

test("Gobernanza en Producción exige confirmación de 6 dígitos para Nivel 3", async () => {
  const mockOdoo = {
    async call() {
      return true;
    },
  };

  const mockDb = {
    async query(sql) {
      if (sql.includes("agent.tool_policies")) {
        return { rows: [{ risk_level: 3, confirmation_required: true, allowed_fields: ["id"] }] };
      }
      if (sql.includes("INSERT INTO agent.pending_actions")) {
        return {
          rows: [
            {
              id: "act-uuid-prod",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  // Cliente en producción
  const prodClient = {
    id: "client-prod",
    name: "Empresa Producción",
    slug: "empresa-prod",
    settings: { environment: "production" },
  };

  const res = await requestOrExecuteAction({
    db: mockDb,
    client: prodClient,
    linkedUser: { id: "user-2", email: "operador@xeta.co" },
    actionName: "confirmar_orden_venta",
    params: { resId: 50 },
    odoo: mockOdoo,
    config: {},
  });

  assert.equal(res.status, "awaiting_approval");
  assert.equal(res.action_id, "act-uuid-prod");
  assert.equal(res.confirmation_code.length, 6);
  assert.ok(res.message.includes(res.confirmation_code));
});

// ============================================================================
// 3. MOTOR DE HOJAS DE CÁLCULO Y TABLEROS (SPREADSHEETS)
// ============================================================================

test("toUnicodeEscapes convierte caracteres no ASCII a secuencias nativas Unicode", () => {
  const raw = "Camión y Nómina en Bogotá";
  const escaped = toUnicodeEscapes(raw);
  assert.equal(escaped, "Cami\\u00f3n y N\\u00f3mina en Bogot\\u00e1");
});

test("normalizeDomainTo2d asegura formato AST bidimensional en dominios de Odoo", () => {
  // Dominio plano -> 2D
  const flat = ["state", "=", "sale"];
  const normalized1 = normalizeDomainTo2d(flat);
  assert.deepEqual(normalized1, [["state", "=", "sale"]]);

  // Ya bidimensional -> sin cambios
  const already2d = [["state", "=", "sale"], ["amount_total", ">", 1000]];
  const normalized2 = normalizeDomainTo2d(already2d);
  assert.deepEqual(normalized2, [["state", "=", "sale"], ["amount_total", ">", 1000]]);
});

test("sanitizeOdooViewLink envuelve enlace con action obligatorio para Odoo 18/19", () => {
  // Enlace incorrecto sin action (provoca crash en Odoo)
  const badLink = 'odoo://view/{"modelName":"sale.order","domain":[["state","=","sale"]]}';
  const result = sanitizeOdooViewLink(badLink);

  assert.equal(result.valid, true);
  assert.ok(result.url.startsWith("odoo://view/"));
  assert.equal(result.fixed, true);
  assert.ok(result.payload.action, "Debe contener el objeto action");
  assert.equal(result.payload.action.modelName, "sale.order");
  assert.deepEqual(result.payload.action.domain, [["state", "=", "sale"]]);
});

test("validateSpreadsheetDefinition audita hojas de cálculo y detecta enlaces sin action", () => {
  const validSheet = {
    version: 16,
    sheets: [
      {
        id: "sheet1",
        name: "Resumen",
        cells: {
          A1: {
            content: '[Ver Ventas](odoo://view/{"name":"Ventas","viewType":"list","action":{"modelName":"sale.order","xmlId":"sale.action_orders","domain":[["state","=","sale"]]}})',
          },
        },
        figures: [
          {
            type: "odoo_bar",
            searchParams: {
              domain: [["state", "=", "sale"]],
            },
          },
        ],
      },
    ],
  };

  const report = validateSpreadsheetDefinition(validSheet);
  assert.equal(report.valid, true);
  assert.equal(report.errors.length, 0);

  const invalidSheet = {
    version: 16,
    sheets: [
      {
        id: "sheet2",
        cells: {
          B2: {
            content: '[Error](odoo://view/{"modelName":"res.partner"})', // sin action anidado
          },
        },
        figures: [
          {
            type: "odoo_bar",
            searchParams: {
              domain: ["state", "=", "sale"], // plano, no 2D
            },
          },
        ],
      },
    ],
  };

  const invalidReport = validateSpreadsheetDefinition(invalidSheet, { autoFix: false });
  assert.equal(invalidReport.valid, false);
  assert.ok(invalidReport.errors.some((e) => e.includes("action")));
  assert.ok(invalidReport.errors.some((e) => e.includes("no es un arreglo 2D AST")));
});

// ============================================================================
// 4. AUDITORÍA DE PARAMETRIZACIÓN FUNCIONAL E INTROSPECCIÓN STUDIO
// ============================================================================

test("inspectStudioFields retorna campos personalizados x_ y x_studio_", async () => {
  const mockOdoo = {
    async searchRead(model) {
      if (model === "ir.model.fields") {
        return [
          { name: "x_studio_sucursal", field_description: "Sucursal", ttype: "char", required: true, readonly: false },
          { name: "x_margen_meta", field_description: "Margen Meta", ttype: "float", required: false, readonly: false },
        ];
      }
      return [];
    },
  };

  const fields = await inspectStudioFields(mockOdoo, "sale.order");
  assert.equal(fields.length, 2);
  assert.equal(fields[0].name, "x_studio_sucursal");
  assert.equal(fields[0].label, "Sucursal");
  assert.equal(fields[0].required, true);
  assert.equal(fields[1].name, "x_margen_meta");
});

test("auditFunctionalConfiguration detecta empresas sin bloqueo contable y categorías manuales", async () => {
  const mockOdoo = {
    async searchRead(model) {
      if (model === "res.company") {
        return [
          { id: 1, name: "Empresa Matriz", fiscalyear_lock_date: false, period_lock_date: false },
        ];
      }
      if (model === "product.category") {
        return [
          { id: 10, name: "Insumos", property_valuation: "manual_periodic", property_cost_method: "standard" },
        ];
      }
      return [];
    },
  };

  const issues = await auditFunctionalConfiguration(mockOdoo);
  assert.ok(issues.length >= 2);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("fiscal_lock_date_missing"));
  assert.ok(codes.includes("manual_inventory_valuation"));
});

// ============================================================================
// 5. HERRAMIENTAS MCP EXPUESTAS
// ============================================================================

test("McpServer expone las nuevas herramientas operativas y de tableros", async () => {
  const server = new McpServer({
    odoo: {},
    client: { id: "c1", name: "Demo" },
    db: null,
    config: {},
  });

  const listRes = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  const toolNames = listRes.result.tools.map((t) => t.name);
  assert.ok(toolNames.includes("registrar_pago_factura"));
  assert.ok(toolNames.includes("crear_anticipo_venta"));
  assert.ok(toolNames.includes("crear_nota_credito"));
  assert.ok(toolNames.includes("convertir_iniciativa_crm"));
  assert.ok(toolNames.includes("perder_oportunidad_crm"));
  assert.ok(toolNames.includes("cancelar_orden_venta"));
  assert.ok(toolNames.includes("cancelar_factura"));
  assert.ok(toolNames.includes("cancelar_albaran_entrega"));
  assert.ok(toolNames.includes("inspeccionar_campos_studio"));
  assert.ok(toolNames.includes("inspeccionar_tablero"));
  assert.ok(toolNames.includes("validar_tablero"));
  assert.ok(toolNames.includes("crear_o_actualizar_tablero"));
});

test("McpServer ejecuta validar_tablero correctamente vía tools/call", async () => {
  const server = new McpServer({
    odoo: {},
    client: { id: "c1", name: "Demo" },
    db: null,
    config: {},
  });

  const callRes = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "validar_tablero",
      arguments: {
        spreadsheetData: {
          version: 16,
          sheets: [
            {
              id: "s1",
              cells: {
                A1: {
                  content: '[Test](odoo://view/{"name":"Ventas","viewType":"list","action":{"modelName":"sale.order","xmlId":"sale.action_orders","domain":[["state","=","sale"]]}})',
                },
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(callRes.result.isError, false);
  const payload = JSON.parse(callRes.result.content[0].text);
  assert.equal(payload.valid, true);
  assert.equal(payload.errors.length, 0);
});
