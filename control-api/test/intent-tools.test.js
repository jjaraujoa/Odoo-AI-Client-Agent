import test from "node:test";
import assert from "node:assert/strict";
import { buildIntentContext, classifyIntent, normalizeIntentData } from "../src/intent.js";
import { executeIntent, summarizeToolForMemory } from "../src/tools.js";

function policyDb() {
  return {
    async query(sql) {
      assert.match(sql, /agent\.tool_policies/);
      return { rows: [{ enabled: true }] };
    },
  };
}

function baseClassification(overrides = {}) {
  return {
    intent: "sale_order",
    parameters: {
      document_number: null,
      document_numbers: [],
      customer: null,
      supplier: null,
      product: null,
      warehouse: null,
      date_from: null,
      date_to: null,
      max_results: 2,
      include_invoice_status: true,
      result_mode: "list",
      invoice_state: "posted",
      payment_filter: "all",
      ...overrides,
    },
  };
}

const identity = {
  client_id: "client-1",
  odoo_base_url: "https://odoo.example.test",
  odoo_user_id: 2,
};

const limits = { max_display_records: 10 };

test("el contexto incluye mensajes recientes para resolver respuestas cortas", () => {
  const context = buildIntentContext([
    { role: "user", kind: "message", content: { text: "Consulta S00006 y S00003" } },
    { role: "assistant", kind: "message", content: { text: "¿Cuál deseas consultar?" } },
    { role: "user", kind: "message", content: { text: "Las dos" } },
  ]);
  assert.match(context, /Consulta S00006 y S00003/);
  assert.match(context, /¿Cuál deseas consultar\?/);
  assert.match(context, /Las dos/);
});

test("normaliza últimas N y varios números aunque el modelo pida aclaración", () => {
  const data = {
    ...baseClassification().parameters,
  };
  const normalized = normalizeIntentData({
    intent: "sale_order",
    confidence: 0.7,
    query: "órdenes",
    parameters: data,
    needs_clarification: true,
    clarification: "Indica el número.",
  }, "Dime si las 2 últimas órdenes S00006 y S00003 están facturadas");

  assert.equal(normalized.needs_clarification, false);
  assert.equal(normalized.clarification, null);
  assert.equal(normalized.parameters.max_results, 2);
  assert.deepEqual(normalized.parameters.document_numbers, ["S00006", "S00003"]);
  assert.equal(normalized.parameters.include_invoice_status, true);
  assert.equal(normalized.parameters.result_mode, "list");
});

test("las dos últimas siempre significa listar dos y no seleccionar solo la más reciente", () => {
  const normalized = normalizeIntentData({
    intent: "purchase_order",
    confidence: 0.99,
    query: "órdenes de compra",
    parameters: {
      ...baseClassification().parameters,
      max_results: 1,
      result_mode: "latest",
    },
    needs_clarification: false,
    clarification: null,
  }, "Ahora dime las 2 últimas órdenes de compra");

  assert.equal(normalized.parameters.max_results, 2);
  assert.equal(normalized.parameters.result_mode, "list");
});

test("el clasificador recibe el contexto y el contrato para múltiples documentos", async () => {
  let captured;
  const db = {
    async query(sql) {
      assert.match(sql, /agent\.client_models/);
      return {
        rows: [{
          id: "model-1", provider: "openai", api_model_id: "gpt-test",
          capability_rank: 6, cost_rank: 4,
        }],
      };
    },
  };
  const providers = {
    async structured(input) {
      captured = input;
      return {
        data: {
          intent: "sale_order",
          confidence: 0.99,
          query: "S00006 y S00003",
          parameters: {
            document_number: null,
            document_numbers: ["S00006", "S00003"],
            customer: null,
            supplier: null,
            product: null,
            warehouse: null,
            date_from: null,
            date_to: null,
            max_results: 2,
            include_invoice_status: true,
            result_mode: "list",
            invoice_state: "posted",
            payment_filter: "all",
          },
          needs_clarification: false,
          clarification: null,
        },
      };
    },
  };

  await classifyIntent({
    db,
    providers,
    identity: { client_id: "client-1" },
    session: { model_mode: "manual", selected_model_id: "model-1" },
    text: "Las dos",
    memory: [
      { role: "user", kind: "message", content: { text: "S00006 y S00003" } },
      { role: "assistant", kind: "message", content: { text: "¿Cuál deseas consultar?" } },
    ],
  });

  assert.match(captured.userText, /S00006 y S00003/);
  assert.match(captured.userText, /Solicitud actual:\nLas dos/);
  assert.ok(captured.schema.properties.parameters.properties.document_numbers);
  assert.ok(captured.schema.properties.parameters.properties.include_invoice_status);
  assert.ok(captured.schema.properties.parameters.properties.result_mode);
  assert.ok(captured.schema.properties.parameters.properties.invoice_state);
  assert.ok(captured.schema.properties.parameters.properties.payment_filter);
});

test("consulta las últimas dos órdenes sin exigir filtros artificiales", async () => {
  let captured;
  const odoo = {
    async searchRead(model, domain, fields, options) {
      captured = { model, domain, fields, options };
      return [
        {
          id: 6, name: "S00006", partner_id: [10, "Cliente A"], date_order: "2026-08-03",
          state: "sale", amount_total: 120, currency_id: [1, "COP"], user_id: [4, "Jorge"],
          company_id: [1, "Compañía"], invoice_status: "invoiced", invoice_ids: [31],
        },
        {
          id: 3, name: "S00003", partner_id: [11, "Cliente B"], date_order: "2026-08-02",
          state: "sale", amount_total: 80, currency_id: [1, "COP"], user_id: [4, "Jorge"],
          company_id: [1, "Compañía"], invoice_status: "to invoice", invoice_ids: [],
        },
      ];
    },
  };

  const result = await executeIntent({
    db: policyDb(), odoo, identity, limits, classification: baseClassification(),
  });

  assert.equal(captured.model, "sale.order");
  assert.deepEqual(captured.domain, []);
  assert.equal(captured.options.order, "date_order desc");
  assert.equal(captured.options.limit, 3);
  assert.ok(captured.fields.includes("invoice_status"));
  assert.ok(captured.fields.includes("invoice_ids"));
  assert.match(result.text, /Total combinado: 200 COP/);
  assert.match(result.text, /S00006/);
  assert.match(result.text, /Facturada/);
  assert.match(result.text, /S00003/);
  assert.match(result.text, /Pendiente de facturar/);
  assert.match(result.text, /Fecha: 2026-08-03/);
});

test("consulta varios números de orden en una sola llamada", async () => {
  let capturedDomain;
  const odoo = {
    async searchRead(_model, domain) {
      capturedDomain = domain;
      return [
        {
          id: 6, name: "S00006", partner_id: [10, "Cliente A"], date_order: "2026-08-03",
          state: "sale", amount_total: 120, currency_id: [1, "COP"], user_id: [4, "Jorge"],
          company_id: [1, "Compañía"], invoice_status: "invoiced", invoice_ids: [31],
        },
        {
          id: 3, name: "S00003", partner_id: [11, "Cliente B"], date_order: "2026-08-02",
          state: "sale", amount_total: 80, currency_id: [1, "COP"], user_id: [4, "Jorge"],
          company_id: [1, "Compañía"], invoice_status: "to invoice", invoice_ids: [],
        },
      ];
    },
  };
  const classification = baseClassification({
    document_numbers: ["S00006", "S00003"],
    max_results: 2,
  });

  const result = await executeIntent({ db: policyDb(), odoo, identity, limits, classification });

  assert.deepEqual(capturedDomain, [["name", "in", ["S00006", "S00003"]]]);
  assert.equal(result.records.length, 2);
  assert.doesNotMatch(result.text, /Indica el número exacto/);

  const summary = summarizeToolForMemory(classification, result);
  assert.deepEqual(summary.records.map((record) => record.number), ["S00006", "S00003"]);
  assert.equal(summary.records[0].invoice_status, "Facturada");
  assert.equal(summary.records[1].date, "2026-08-02");
});

test("resuelve una comparación con los dos registros recordados aunque el último resumen tenga solo uno", () => {
  const normalized = normalizeIntentData({
    intent: "sale_order",
    confidence: 0.95,
    query: "órdenes anteriores",
    parameters: baseClassification().parameters,
    needs_clarification: true,
    clarification: "Indica las órdenes.",
  }, "De las dos que antes me mostraste, ¿cuál fue hecha primero?", [
    { kind: "summary", content: { records: [{ number: "S00006" }, { number: "S00005" }] } },
    { kind: "summary", content: { records: [{ number: "S00006" }] } },
  ]);

  assert.equal(normalized.parameters.result_mode, "earliest");
  assert.deepEqual(normalized.parameters.document_numbers, ["S00006", "S00005"]);
  assert.equal(normalized.needs_clarification, false);
});

test("selecciona la orden más antigua entre las referencias permitidas", async () => {
  const odoo = {
    async searchRead() {
      return [
        { id: 6, name: "S00006", partner_id: [10, "Cliente A"], date_order: "2026-08-03 12:00:00", state: "sale", amount_total: 120, currency_id: [1, "COP"], user_id: [4, "Jorge"], company_id: [1, "Compañía"], invoice_status: "invoiced", invoice_ids: [31] },
        { id: 5, name: "S00005", partner_id: [10, "Cliente A"], date_order: "2026-08-02 08:00:00", state: "draft", amount_total: 80, currency_id: [1, "COP"], user_id: [4, "Jorge"], company_id: [1, "Compañía"], invoice_status: "no", invoice_ids: [] },
      ];
    },
  };
  const classification = baseClassification({
    document_numbers: ["S00006", "S00005"],
    result_mode: "earliest",
  });

  const result = await executeIntent({ db: policyDb(), odoo, identity, limits, classification });

  assert.deepEqual(result.records.map((record) => record.number), ["S00005"]);
  assert.match(result.text, /S00005 fue creada antes/);
  assert.match(result.text, /Fecha: 2026-08-02 08:00:00/);
  assert.doesNotMatch(result.text, /Total combinado/);
});

test("filtra las órdenes que sí tienen facturas relacionadas", async () => {
  const odoo = {
    async searchRead() {
      return [
        { id: 6, name: "S00006", partner_id: [10, "Cliente A"], date_order: "2026-08-03", state: "sale", amount_total: 120, currency_id: [1, "COP"], user_id: [4, "Jorge"], company_id: [1, "Compañía"], invoice_status: "invoiced", invoice_ids: [31] },
        { id: 5, name: "S00005", partner_id: [10, "Cliente A"], date_order: "2026-08-02", state: "draft", amount_total: 80, currency_id: [1, "COP"], user_id: [4, "Jorge"], company_id: [1, "Compañía"], invoice_status: "no", invoice_ids: [] },
      ];
    },
  };
  const classification = baseClassification({
    document_numbers: ["S00006", "S00005"],
    result_mode: "with_invoices",
  });

  const result = await executeIntent({ db: policyDb(), odoo, identity, limits, classification });

  assert.deepEqual(result.records.map((record) => record.number), ["S00006"]);
  assert.match(result.text, /Facturas relacionadas: 1/);
  assert.doesNotMatch(result.text, /S00005/);
});

test("corrige un error tipográfico cuando existe una coincidencia única de producto", async () => {
  const calls = [];
  const odoo = {
    async searchRead(model, domain, fields, options) {
      calls.push({ model, domain, fields, options });
      if (model === "res.users") return [{ id: 2, lang: "es_419" }];
      if (calls.length === 2) return [];
      return [{
        id: 18,
        name: "Almacenable",
        display_name: "Almacenable",
        default_code: false,
        qty_available: 7,
        free_qty: 6,
        virtual_available: 9,
        uom_id: [1, "Units"],
      }];
    },
  };
  const classification = {
    ...baseClassification({ product: "Almacenablee", max_results: 5 }),
    intent: "inventory",
  };

  const result = await executeIntent({ db: policyDb(), odoo, identity, limits, classification });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].model, "res.users");
  assert.equal(calls[1].model, "product.product");
  assert.deepEqual(calls[1].domain, [
    "|", ["name", "ilike", "%Almacenablee%"], ["default_code", "ilike", "%Almacenablee%"],
  ]);
  assert.equal(calls[1].options.context.lang, "es_419");
  assert.equal(calls[2].options.limit, 100);
  assert.equal(calls[2].options.context.lang, "es_419");
  assert.match(result.text, /Interpreté “Almacenablee” como “Almacenable”/);
  assert.match(result.text, /7 en mano/);
});

test("ofrece opciones en vez de adivinar cuando dos productos son igual de parecidos", async () => {
  let calls = 0;
  const odoo = {
    async searchRead(model) {
      calls += 1;
      if (model === "res.users") return [{ id: 2, lang: "es_419" }];
      if (calls === 2) return [];
      return [
        { id: 30, name: "Producto Prueba", display_name: "Producto Prueba", default_code: false },
        { id: 31, name: "Producto Pruebe", display_name: "Producto Pruebe", default_code: false },
      ];
    },
  };
  const classification = {
    ...baseClassification({ product: "Producto Pruebx", max_results: 5 }),
    intent: "inventory",
  };

  const result = await executeIntent({ db: policyDb(), odoo, identity, limits, classification });

  assert.equal(result.status, "ambiguous");
  assert.match(result.text, /Producto Prueba/);
  assert.match(result.text, /Producto Pruebe/);
  assert.match(result.text, /Indica cuál/);
});

test("usa el idioma del usuario para devolver el mismo nombre visible en Odoo", async () => {
  const calls = [];
  const odoo = {
    async searchRead(model, domain, fields, options) {
      calls.push({ model, domain, fields, options });
      if (model === "res.users") return [{ id: 2, lang: "es_419" }];
      return [{
        id: 5,
        name: "Producto Prueba",
        display_name: "Producto Prueba",
        default_code: false,
        qty_available: 300,
        free_qty: 220,
        virtual_available: 400,
        uom_id: [1, "Units"],
      }];
    },
  };
  const classification = {
    ...baseClassification({ product: "Producto Prueba", max_results: 5 }),
    intent: "inventory",
  };

  const result = await executeIntent({ db: policyDb(), odoo, identity: { ...identity, odoo_user_id: 2 }, limits, classification });

  assert.equal(calls[1].options.context.lang, "es_419");
  assert.match(result.text, /^Producto Prueba: 300 en mano/);
  assert.doesNotMatch(result.text, /Interpreté/);
});

test("facturas publicadas de cualquier cliente no exige un cliente artificial", () => {
  const normalized = normalizeIntentData({
    intent: "pending_invoices",
    confidence: 0.96,
    query: "facturas",
    parameters: {
      ...baseClassification().parameters,
      customer: "Cliente inventado por el modelo",
      max_results: 2,
      invoice_state: "draft",
      payment_filter: "pending",
    },
    needs_clarification: true,
    clarification: "Indica el cliente.",
  }, "Dime todas las que haya ahora mismo publicadas");

  assert.equal(normalized.parameters.customer, null);
  assert.equal(normalized.parameters.max_results, 10);
  assert.equal(normalized.parameters.invoice_state, "posted");
  assert.equal(normalized.parameters.payment_filter, "all");
  assert.equal(normalized.needs_clarification, false);
});

test("combina estado publicado con filtro pendiente de pago", () => {
  const normalized = normalizeIntentData({
    intent: "pending_invoices",
    confidence: 0.96,
    query: "facturas",
    parameters: baseClassification().parameters,
    needs_clarification: false,
    clarification: null,
  }, "Muéstrame las facturas publicadas pendientes de pago");

  assert.equal(normalized.parameters.invoice_state, "posted");
  assert.equal(normalized.parameters.payment_filter, "pending");
});

test("un seguimiento sobre pendientes de pago conserva la intención sin pedir cliente", () => {
  const normalized = normalizeIntentData({
    intent: "pending_invoices",
    confidence: 0.96,
    query: "facturas",
    parameters: {
      ...baseClassification().parameters,
      customer: null,
      invoice_state: "all",
      payment_filter: "all",
    },
    needs_clarification: true,
    clarification: "Indica el cliente.",
  }, "Ahora solo las pendientes de pago");

  assert.equal(normalized.parameters.customer, null);
  assert.equal(normalized.parameters.invoice_state, "posted");
  assert.equal(normalized.parameters.payment_filter, "pending");
  assert.equal(normalized.needs_clarification, false);
  assert.equal(normalized.clarification, null);
});

test("consulta facturas de cliente publicadas sin filtrar por cliente ni por pago", async () => {
  let captured;
  const odoo = {
    async searchRead(model, domain, fields, options) {
      captured = { model, domain, fields, options };
      return [
        {
          id: 41, name: "INV/2026/0004", move_type: "out_invoice", state: "posted",
          partner_id: [10, "Cliente A"], invoice_date: "2026-08-03", invoice_date_due: "2026-08-30",
          amount_total: 120000, amount_residual: 0, currency_id: [1, "COP"], payment_state: "paid",
          company_id: [1, "My Company"],
        },
        {
          id: 40, name: "INV/2026/0003", move_type: "out_invoice", state: "posted",
          partner_id: [11, "Cliente B"], invoice_date: "2026-08-02", invoice_date_due: "2026-08-20",
          amount_total: 80000, amount_residual: 80000, currency_id: [1, "COP"], payment_state: "not_paid",
          company_id: [1, "My Company"],
        },
      ];
    },
  };
  const classification = {
    ...baseClassification({
      customer: null,
      max_results: 10,
      invoice_state: "posted",
      payment_filter: "all",
    }),
    intent: "pending_invoices",
  };

  const result = await executeIntent({ db: policyDb(), odoo, identity, limits, classification });

  assert.equal(captured.model, "account.move");
  assert.deepEqual(captured.domain, [
    ["move_type", "=", "out_invoice"],
    ["state", "=", "posted"],
  ]);
  assert.equal(captured.options.limit, 11);
  assert.match(result.text, /INV\/2026\/0004 · Cliente A · Publicada/);
  assert.match(result.text, /Pago: Pagada/);
  assert.match(result.text, /INV\/2026\/0003 · Cliente B · Publicada/);
  assert.match(result.text, /Pago: No pagada/);
});

test("mantiene la consulta histórica de pendientes cuando se indica un cliente", async () => {
  let domain;
  const odoo = {
    async searchRead(_model, receivedDomain) {
      domain = receivedDomain;
      return [];
    },
  };
  const classification = {
    ...baseClassification({
      customer: "Cliente Demo",
      invoice_state: "posted",
      payment_filter: "pending",
    }),
    intent: "pending_invoices",
  };

  const result = await executeIntent({ db: policyDb(), odoo, identity, limits, classification });

  assert.deepEqual(domain, [
    ["move_type", "=", "out_invoice"],
    ["state", "=", "posted"],
    ["payment_state", "not in", ["paid", "reversed"]],
    ["partner_id.name", "ilike", "%Cliente Demo%"],
  ]);
  assert.match(result.text, /No encontré facturas de cliente publicadas/);
});
