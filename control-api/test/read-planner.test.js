import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_TOOLS } from "../src/admin.js";
import { handleSemanticRead } from "../src/read-agent.js";
import { executeReadPlan, executionForModel, summarizeReadExecutionForMemory } from "../src/read-executor.js";
import {
  READ_PLAN_SCHEMA,
  buildReadPlanContext,
  compileReadPlan,
  createReadPlan,
  publicCompiledPlan,
} from "../src/read-plan.js";
import { SEMANTIC_ENTITIES, catalogForPlanner, readPlannerMode } from "../src/semantic-catalog.js";
import { synthesizeReadResponse } from "../src/read-response.js";

const catalog = SEMANTIC_ENTITIES;
const identity = {
  client_id: "client-1",
  odoo_base_url: "https://odoo.example.test",
  odoo_user_id: null,
  prohibited_fields: ["password", "api_key", "token"],
  timezone: "America/Bogota",
};
const limits = { max_display_records: 10, max_odoo_records: 50 };
const policies = new Map(DEFAULT_TOOLS.map(([name, _risk, _confirm, fields], index) => [name, { id: `policy-${index}`, allowed_fields: fields }]));

function policyDb() {
  return {
    async query(sql, params) {
      if (/agent\.tool_policies/.test(sql)) {
        const policy = policies.get(params?.[1]);
        return { rows: policy ? [policy] : [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
}

function filter(field, operator, value = null, values = [], sourceStep = null, sourceField = null) {
  return { field, operator, value, values, source_step: sourceStep, source_field: sourceField };
}

function step(overrides = {}) {
  return {
    id: "principal",
    entity: "ordenes_venta",
    operation: "list",
    fields: [],
    filters: [],
    filter_logic: "all",
    sort: [],
    limit: 10,
    aggregate: { function: "none", field: null },
    group_by: [],
    ...overrides,
  };
}

function plan(steps = [step()], overrides = {}) {
  return {
    version: "1",
    objective: "Consultar información autorizada",
    mode: "read",
    confidence: 0.95,
    steps,
    assumptions: [],
    needs_clarification: false,
    clarification: null,
    response: { format: "list", focus: null },
    ...overrides,
  };
}

async function compile(value) {
  return compileReadPlan({ db: policyDb(), identity, limits, catalog, plan: value });
}

test("ReadPlanV1 no expone modelo ni método técnico", () => {
  assert.equal(READ_PLAN_SCHEMA.properties.model, undefined);
  assert.equal(READ_PLAN_SCHEMA.properties.method, undefined);
  assert.equal(READ_PLAN_SCHEMA.properties.steps.items.properties.model, undefined);
  assert.equal(READ_PLAN_SCHEMA.properties.steps.items.properties.method, undefined);
});

test("el catálogo entregado al modelo usa entidades y campos semánticos", () => {
  const visible = JSON.stringify(catalogForPlanner(catalog));
  assert.match(visible, /ordenes_venta/);
  assert.match(visible, /facturas_cliente/);
  assert.doesNotMatch(visible, /sale\.order/);
  assert.doesNotMatch(visible, /account\.move/);
});

test("el modo del planificador es cerrado por defecto", () => {
  assert.equal(readPlannerMode({ client_settings: {} }), "legacy");
  assert.equal(readPlannerMode({ client_settings: { read_planner_mode: "inventado" } }), "legacy");
});

test("acepta los tres modos administrativos", () => {
  for (const mode of ["legacy", "shadow", "active"]) {
    assert.equal(readPlannerMode({ client_settings: { read_planner_mode: mode } }), mode);
  }
});

test("compila una lectura reciente sin exigir cliente ni fechas", async () => {
  const compiled = await compile(plan([step({ limit: 2 })]));
  assert.equal(compiled.steps[0].entity.model, "sale.order");
  assert.deepEqual(compiled.steps[0].domain, []);
  assert.equal(compiled.steps[0].limit, 2);
  assert.equal(compiled.steps[0].sort[0].technicalField, "date_order");
});

test("añade el identificador aunque el modelo solo solicite el total", async () => {
  const compiled = await compile(plan([step({ fields: ["total"] })]));
  assert.deepEqual([...compiled.steps[0].semanticFields].sort(), ["numero", "total"]);
});

test("traduce un filtro semántico de cliente a un dominio seguro", async () => {
  const compiled = await compile(plan([step({ filters: [filter("cliente", "contains", "Demo")] })]));
  assert.deepEqual(compiled.steps[0].domain, [["partner_id.name", "ilike", "%Demo%"]]);
});

test("compila filtros OR con una profundidad acotada", async () => {
  const compiled = await compile(plan([step({
    filter_logic: "any",
    filters: [filter("numero", "equals", "S00001"), filter("numero", "equals", "S00002")],
  })]));
  assert.deepEqual(compiled.steps[0].domain, ["|", ["name", "=", "S00001"], ["name", "=", "S00002"]]);
});

test("preserva el dominio base de facturas de cliente", async () => {
  const compiled = await compile(plan([step({
    entity: "facturas_cliente",
    filters: [filter("estado", "equals", "publicadas")],
  })]));
  assert.deepEqual(compiled.steps[0].domain, [["move_type", "=", "out_invoice"], ["state", "=", "posted"]]);
});

test("una factura pendiente puede incluir varios estados de pago", async () => {
  const compiled = await compile(plan([step({
    entity: "facturas_cliente",
    filters: [filter("estado_pago", "in", null, ["not_paid", "partial", "in_payment"])],
  })]));
  assert.deepEqual(compiled.steps[0].domain[1], ["payment_state", "in", ["not_paid", "partial", "in_payment"]]);
});

test("bloquea un campo semántico inventado", async () => {
  await assert.rejects(() => compile(plan([step({ fields: ["password"] })])), (error) => error.code === "read_plan_field_unknown");
});

test("bloquea una entidad que el cliente no habilitó", async () => {
  const restricted = { ordenes_venta: SEMANTIC_ENTITIES.ordenes_venta };
  await assert.rejects(
    () => compileReadPlan({ db: policyDb(), identity, limits, catalog: restricted, plan: plan([step({ entity: "clientes" })]) }),
    (error) => error.code === "semantic_entity_disabled",
  );
});

test("bloquea planes con más de tres pasos", async () => {
  const steps = [1, 2, 3, 4].map((number) => step({ id: `paso_${number}` }));
  await assert.rejects(() => compile(plan(steps)), (error) => error.code === "read_plan_steps");
});

test("bloquea identificadores de paso duplicados", async () => {
  await assert.rejects(() => compile(plan([step(), step()])), (error) => error.code === "read_plan_step_id");
});

test("bloquea operadores no permitidos por el campo", async () => {
  await assert.rejects(
    () => compile(plan([step({ filters: [filter("cliente", "greater_than", "A")] })])),
    (error) => error.code === "read_plan_operator_blocked",
  );
});

test("bloquea filtros in vacíos", async () => {
  await assert.rejects(
    () => compile(plan([step({ filters: [filter("numero", "in", null, [])] })])),
    (error) => error.code === "read_plan_invalid_values",
  );
});

test("compila facturas relacionadas mediante una dependencia declarativa", async () => {
  const compiled = await compile(plan([
    step({ id: "ventas", fields: ["numero", "facturas_relacionadas"], limit: 2 }),
    step({
      id: "facturas",
      entity: "facturas_cliente",
      filters: [filter("registro_relacionado", "in", null, [], "ventas", "facturas_relacionadas")],
    }),
  ]));
  assert.equal(compiled.steps[1].domain[1].deferred, true);
  assert.equal(compiled.steps[1].domain[1].sourceStep, "ventas");
});

test("una dependencia solo puede apuntar hacia atrás", async () => {
  await assert.rejects(
    () => compile(plan([step({
      entity: "facturas_cliente",
      filters: [filter("registro_relacionado", "in", null, [], "futuro", "facturas_relacionadas")],
    })])),
    (error) => error.code === "read_plan_dependency_invalid",
  );
});

test("el identificador relacionado no admite valores inventados", async () => {
  await assert.rejects(
    () => compile(plan([step({ entity: "facturas_cliente", filters: [filter("registro_relacionado", "in", null, [34])] })])),
    (error) => error.code === "read_plan_dependency_required",
  );
});

test("compila el filtro virtual de almacén como contexto", async () => {
  const compiled = await compile(plan([step({
    entity: "inventario",
    filters: [filter("almacen", "contains", "Principal")],
  })]));
  assert.deepEqual(compiled.steps[0].contextFilters, [{ resolver: "warehouse", value: "Principal" }]);
  assert.deepEqual(compiled.steps[0].domain, []);
});

test("compila el cliente de una lista de precios como contexto", async () => {
  const compiled = await compile(plan([step({
    entity: "productos",
    filters: [filter("cliente", "equals", "Cliente Demo")],
  })]));
  assert.deepEqual(compiled.steps[0].contextFilters, [{ resolver: "customer_pricelist", value: "Cliente Demo" }]);
});

test("un conteo usa search_count y no descarga registros", async () => {
  let searchReads = 0;
  const odoo = {
    async searchCount(model, domain) {
      assert.equal(model, "res.partner");
      assert.deepEqual(domain, [["customer_rank", ">", 0]]);
      return 17;
    },
    async searchRead() { searchReads += 1; return []; },
  };
  const compiled = await compile(plan([step({ entity: "clientes", operation: "count", aggregate: { function: "count", field: null } })]));
  const result = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.equal(result.steps[0].count, 17);
  assert.equal(searchReads, 0);
});

test("suma importes de manera determinista y separada por moneda", async () => {
  const odoo = {
    async searchRead() {
      return [
        { id: 1, name: "S1", amount_total: 100, currency_id: [1, "COP"] },
        { id: 2, name: "S2", amount_total: 50, currency_id: [1, "COP"] },
        { id: 3, name: "S3", amount_total: 10, currency_id: [2, "USD"] },
      ];
    },
  };
  const compiled = await compile(plan([step({
    operation: "aggregate",
    fields: ["total"],
    aggregate: { function: "sum", field: "total" },
    sort: [{ field: "fecha", direction: "desc" }],
  })]));
  const result = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.deepEqual(result.steps[0].aggregate.groups, [
    { by: { moneda: "COP" }, value: 150, records: 2 },
    { by: { moneda: "USD" }, value: 10, records: 1 },
  ]);
});

test("no presenta una suma parcial cuando supera el máximo recuperable", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ id: index + 1, name: `S${index}`, amount_total: 1, currency_id: [1, "COP"] }));
  const odoo = { async searchRead() { return rows; } };
  const compiled = await compile(plan([step({ operation: "aggregate", aggregate: { function: "sum", field: "total" } })]));
  const result = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.equal(result.steps[0].status, "incomplete");
  assert.equal(result.steps[0].aggregate, null);
  assert.match(result.steps[0].incomplete_reason, /no se calculó un total parcial/i);
});

test("normaliza relaciones, estados y enlaces antes de enviarlos al redactor", async () => {
  const odoo = {
    async searchRead() {
      return [{
        id: 34, name: "INV/1", partner_id: [9, "Cliente A"], invoice_date: "2026-08-04",
        invoice_date_due: "2026-08-20", state: "posted", payment_state: "paid",
        amount_total: 100, amount_residual: 0, currency_id: [1, "COP"], company_id: [1, "Compañía"],
      }];
    },
  };
  const compiled = await compile(plan([step({ entity: "facturas_cliente" })]));
  const execution = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  const evidence = executionForModel(execution);
  assert.equal(evidence.steps[0].records[0].estado, "Publicada");
  assert.equal(evidence.steps[0].records[0].estado_pago, "Pagada");
  assert.match(evidence.steps[0].records[0].url, /model=account\.move/);
});

test("resuelve una dependencia usando IDs devueltos por el paso anterior", async () => {
  const calls = [];
  const odoo = {
    async searchRead(model, domain) {
      calls.push({ model, domain });
      if (model === "sale.order") return [{ id: 6, name: "S00006", invoice_ids: [34], date_order: "2026-08-04" }];
      return [{ id: 34, name: "INV/1", partner_id: [9, "Cliente"], state: "posted", payment_state: "paid", currency_id: [1, "COP"] }];
    },
  };
  const compiled = await compile(plan([
    step({ id: "ventas", fields: ["numero", "facturas_relacionadas"], limit: 1 }),
    step({ id: "facturas", entity: "facturas_cliente", filters: [filter("registro_relacionado", "in", null, [], "ventas", "facturas_relacionadas")] }),
  ]));
  await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.deepEqual(calls[1].domain, [["move_type", "=", "out_invoice"], ["id", "in", [34]]]);
});

test("reintenta una búsqueda textual exacta como coincidencia parcial", async () => {
  const calls = [];
  const odoo = {
    async searchRead(_model, domain) {
      calls.push(domain);
      return calls.length === 1 ? [] : [{ id: 8, name: "Cliente Demostración", customer_rank: 1 }];
    },
  };
  const compiled = await compile(plan([step({ entity: "clientes", filters: [filter("nombre", "equals", "Cliente Demo")] })]));
  const result = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.equal(result.retry_used, true);
  assert.deepEqual(calls[1][1], ["name", "ilike", "%Cliente Demo%"]);
});

test("corrige un error tipográfico de producto solo con coincidencia clara", async () => {
  let calls = 0;
  const odoo = {
    async searchRead() {
      calls += 1;
      if (calls === 1) return [];
      return [{ id: 18, name: "Almacenable", display_name: "Almacenable", default_code: false, qty_available: 7, free_qty: 6, virtual_available: 9, uom_id: [1, "Units"] }];
    },
  };
  const compiled = await compile(plan([step({ entity: "inventario", filters: [filter("nombre", "contains", "Almacenablee")] })]));
  const result = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.equal(result.steps[0].interpretation, "Almacenable");
  assert.equal(result.steps[0].records[0].values.en_mano, 7);
});

test("no adivina cuando dos productos tienen similitud equivalente", async () => {
  let calls = 0;
  const odoo = {
    async searchRead() {
      calls += 1;
      if (calls === 1) return [];
      return [
        { id: 1, name: "Producto Prueba", display_name: "Producto Prueba", default_code: false },
        { id: 2, name: "Producto Pruebe", display_name: "Producto Pruebe", default_code: false },
      ];
    },
  };
  const compiled = await compile(plan([step({ entity: "productos", filters: [filter("nombre", "contains", "Producto Pruebx")] })]));
  const result = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.equal(result.steps[0].status, "ambiguous");
  assert.equal(result.steps[0].suggestions.length, 2);
});

test("aplica el almacén resuelto al contexto de inventario", async () => {
  const calls = [];
  const odoo = {
    async searchRead(model, domain, fields, options) {
      calls.push({ model, domain, fields, options });
      if (model === "stock.warehouse") return [{ id: 3, name: "Principal" }];
      return [{ id: 18, name: "Producto", display_name: "Producto", qty_available: 2, free_qty: 2, virtual_available: 2, uom_id: [1, "Units"] }];
    },
  };
  const compiled = await compile(plan([step({ entity: "inventario", filters: [filter("almacen", "contains", "Principal")] })]));
  await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.equal(calls[1].options.context.warehouse, 3);
});

test("un almacén ambiguo se devuelve como evidencia y no se selecciona", async () => {
  const odoo = { async searchRead() { return [{ id: 1, name: "Principal A" }, { id: 2, name: "Principal B" }]; } };
  const compiled = await compile(plan([step({ entity: "inventario", filters: [filter("almacen", "contains", "Principal")] })]));
  const result = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  assert.equal(result.steps[0].status, "ambiguous");
  assert.match(result.steps[0].message, /Principal A/);
});

test("la memoria estructurada no conserva correo ni teléfono del cliente", async () => {
  const odoo = { async searchRead() { return [{ id: 1, name: "Cliente", email: "correo@example.test", phone: "123", customer_rank: 1 }]; } };
  const compiled = await compile(plan([step({ entity: "clientes", fields: ["nombre", "correo", "telefono"] })]));
  const execution = await executeReadPlan({ db: policyDb(), odoo, identity, limits, compiled });
  const memory = summarizeReadExecutionForMemory(compiled, execution);
  assert.equal(memory.steps[0].records[0].values.nombre, "Cliente");
  assert.equal(memory.steps[0].records[0].values.correo, undefined);
  assert.equal(memory.steps[0].records[0].values.telefono, undefined);
});

test("el contexto incluye planes estructurados anteriores", () => {
  const context = buildReadPlanContext([
    { role: "tool", kind: "summary", content: { schema: "read_plan_v1", objective: "Dos órdenes", steps: [{ entity: "ordenes_venta" }] } },
  ]);
  assert.match(context, /read_plan_v1/);
  assert.match(context, /ordenes_venta/);
});

test("el planificador recibe fecha, catálogo y memoria sin modelos técnicos", async () => {
  let captured;
  const db = {
    async query(sql) {
      assert.match(sql, /agent\.client_models/);
      return { rows: [{ id: "model-1", provider: "openai", api_model_id: "gpt-test", capability_rank: 8 }] };
    },
  };
  const providers = {
    async structured(input) {
      captured = input;
      return { data: plan(), usage: { input: 10, output: 20 } };
    },
  };
  await createReadPlan({
    db, providers, identity,
    session: { model_mode: "manual", selected_model_id: "model-1" },
    text: "Las dos últimas",
    memory: [{ role: "user", kind: "message", content: { text: "Órdenes de venta" } }],
    catalog,
  });
  assert.match(captured.userText, /Fecha actual:/);
  assert.match(captured.userText, /ordenes_venta/);
  assert.match(captured.userText, /Órdenes de venta/);
  assert.doesNotMatch(captured.userText, /sale\.order/);
});

test("el plan público auditable no contiene dominio, modelo ni método", async () => {
  const compiled = await compile(plan([step({ filters: [filter("cliente", "contains", "Demo")] })]));
  const visible = JSON.stringify(publicCompiledPlan(compiled));
  assert.match(visible, /plan_hash/);
  assert.doesNotMatch(visible, /partner_id/);
  assert.doesNotMatch(visible, /sale\.order/);
  assert.doesNotMatch(visible, /search_read/);
});

test("el redactor recibe solo evidencia normalizada y conserva enlaces", async () => {
  const compiled = await compile(plan([step()]));
  const execution = {
    schema: "read_execution_v1",
    objective: compiled.objective,
    assumptions: [],
    retry_used: false,
    steps: [{
      id: "principal", entity: "ordenes_venta", operation: "list", status: "ok",
      records: [{ id: 6, values: { numero: "S00006", total: 100 }, url: "https://odoo.example.test/web#id=6" }],
      truncated: false,
    }],
  };
  let captured;
  const providers = {
    async structured(input) {
      captured = input;
      return { data: { answer: "La orden S00006 tiene un total de 100.", used_record_ids: [6] }, usage: { input: 5, output: 6 } };
    },
  };
  const response = await synthesizeReadResponse({ providers, model: { provider: "openai" }, question: "Total", compiled, execution, plannerUsage: { input: 2, output: 3 } });
  assert.match(captured.userText, /S00006/);
  assert.doesNotMatch(captured.userText, /sale\.order/);
  assert.match(response.text, /web#id=6/);
  assert.deepEqual(response.usage, { input: 7, output: 9 });
});

test("si falla el redactor conserva una respuesta determinista basada en evidencia", async () => {
  const compiled = await compile(plan([step()]));
  const execution = {
    schema: "read_execution_v1", objective: compiled.objective, assumptions: [], retry_used: false,
    steps: [{ id: "principal", entity: "ordenes_venta", operation: "list", status: "ok", truncated: false,
      records: [{ id: 6, values: { numero: "S00006", total: 100 }, url: "https://odoo.example.test/web#id=6" }] }],
  };
  const providers = { async structured() { throw new Error("Proveedor caído"); } };
  const response = await synthesizeReadResponse({ providers, model: {}, question: "Total", compiled, execution });
  assert.equal(response.synthesized, false);
  assert.match(response.text, /S00006/);
  assert.match(response.text, /web#id=6/);
});

function semanticDb() {
  return {
    async query(sql, params) {
      if (/agent\.semantic_entities/.test(sql)) {
        return { rows: Object.keys(SEMANTIC_ENTITIES).map((entity_key) => ({ entity_key, enabled: true, settings: {}, catalog_version: "read-semantic-catalog/1" })) };
      }
      if (/agent\.client_models/.test(sql)) {
        return { rows: [{ id: "model-1", provider: "openai", api_model_id: "gpt-test", capability_rank: 8 }] };
      }
      if (/agent\.tool_policies/.test(sql)) {
        const policy = policies.get(params?.[1]);
        return { rows: policy ? [policy] : [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
}

test("el coordinador repara una vez un plan inválido antes de consultar", async () => {
  let providerCalls = 0;
  const providers = {
    async structured() {
      providerCalls += 1;
      if (providerCalls === 1) return { data: plan([step({ fields: ["campo_inventado"] })]), usage: { input: 10, output: 5 } };
      if (providerCalls === 2) return { data: plan([step({ fields: ["numero", "total"], limit: 1 })]), usage: { input: 8, output: 4 } };
      return { data: { answer: "S00006: 100 COP.", used_record_ids: [6] }, usage: { input: 6, output: 3 } };
    },
  };
  const odoo = {
    async searchRead() {
      return [{ id: 6, name: "S00006", amount_total: 100, currency_id: [1, "COP"], date_order: "2026-08-04" }];
    },
  };
  const result = await handleSemanticRead({
    db: semanticDb(), providers, identity,
    session: { model_mode: "manual", selected_model_id: "model-1" },
    limits, odoo, text: "Dime la última orden", memory: [],
  });
  assert.equal(result.repaired, true);
  assert.equal(result.kind, "read");
  assert.equal(providerCalls, 3);
  assert.equal(result.memorySummary.schema, "read_plan_v1");
});

test("una aclaración semántica no consulta Odoo", async () => {
  const clarificationPlan = plan([], {
    needs_clarification: true,
    clarification: "¿Te refieres a órdenes de venta o de compra?",
  });
  let odooCalls = 0;
  const providers = { async structured() { return { data: clarificationPlan, usage: {} }; } };
  const result = await handleSemanticRead({
    db: semanticDb(), providers, identity,
    session: { model_mode: "manual", selected_model_id: "model-1" },
    limits, odoo: { async searchRead() { odooCalls += 1; return []; } },
    text: "Dime las órdenes", memory: [],
  });
  assert.equal(result.kind, "clarification");
  assert.equal(odooCalls, 0);
});

test("una escritura nunca se transforma en plan de lectura", async () => {
  const unsupported = plan([], { mode: "unsupported", objective: "Publicar una factura" });
  const providers = { async structured() { return { data: unsupported, usage: {} }; } };
  await assert.rejects(
    () => handleSemanticRead({
      db: semanticDb(), providers, identity,
      session: { model_mode: "manual", selected_model_id: "model-1" },
      limits, odoo: {}, text: "Publica la factura", memory: [],
    }),
    (error) => error.code === "unsupported_request",
  );
});

test("el benchmark contiene 80 consultas naturales distintas y con resultado esperado", () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/read-planner-cases.json", import.meta.url), "utf8"));
  assert.equal(cases.length, 80);
  assert.equal(new Set(cases.map((item) => item.id)).size, 80);
  assert.equal(new Set(cases.map((item) => item.text)).size, 80);
  for (const item of cases) {
    assert.ok(["read", "help", "unsupported"].includes(item.mode));
    if (item.entity) assert.ok(Object.hasOwn(SEMANTIC_ENTITIES, item.entity));
  }
});
