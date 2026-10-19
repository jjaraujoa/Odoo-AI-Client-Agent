import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.js";
import { McpServer, buildClosedQuery, CLOSED_QUERY_FIELDS } from "../src/mcp-server.js";
import { auditDataHygiene, runFullBusinessAudit } from "../src/audit-business.js";

// ============================================================================
// 1. CONSULTAS CERRADAS: buildClosedQuery y validaciones
// ============================================================================

test("buildClosedQuery ignora domain y fields maliciosos en args", () => {
  const query = buildClosedQuery("consultar_orden_venta", {
    domain: [["id", ">", 0], ["user_id", "=", 1]],
    fields: ["password", "token", "secret_key"],
    name: "SO-100",
  });

  assert.equal(query.model, "sale.order");
  // domain solo contiene el filtro por name, ignorando args.domain
  assert.deepEqual(query.domain, [["name", "ilike", "SO-100"]]);
  // fields son los campos fijos, ignorando args.fields
  assert.deepEqual(query.fields, CLOSED_QUERY_FIELDS.sale);
  assert.ok(!query.fields.includes("password"));
  assert.ok(!query.fields.includes("secret_key"));
});

test("buildClosedQuery genera el dominio esperado para ventas con partner, state y fechas", () => {
  const query = buildClosedQuery("consultar_orden_venta", {
    name: "SO-2026",
    partner: "Cliente VIP",
    state: "sale",
    date_from: "2026-01-01",
    date_to: "2026-12-31",
    limit: 25,
  });

  assert.equal(query.model, "sale.order");
  assert.deepEqual(query.domain, [
    ["name", "ilike", "SO-2026"],
    ["partner_id", "ilike", "Cliente VIP"],
    ["state", "=", "sale"],
    ["date_order", ">=", "2026-01-01"],
    ["date_order", "<=", "2026-12-31"],
  ]);
  assert.equal(query.limit, 25);
  assert.deepEqual(query.fields, CLOSED_QUERY_FIELDS.sale);
});

test("buildClosedQuery genera el dominio esperado para compras con proveedor y estados válidos", () => {
  const query = buildClosedQuery("consultar_orden_compra", {
    partner: "Proveedor Central",
    state: "to approve",
    date_from: "2026-03-01",
  });

  assert.equal(query.model, "purchase.order");
  assert.deepEqual(query.domain, [
    ["partner_id", "ilike", "Proveedor Central"],
    ["state", "=", "to approve"],
    ["date_order", ">=", "2026-03-01"],
  ]);
  assert.equal(query.limit, 10);
  assert.deepEqual(query.fields, CLOSED_QUERY_FIELDS.purchase);
});

test("buildClosedQuery genera el dominio esperado para CRM con stage y type", () => {
  const query = buildClosedQuery("consultar_oportunidades_crm", {
    name: "Proyecto Solar",
    partner: "Empresa Renovable",
    stage: "Calificado",
    type: "opportunity",
    limit: 15,
  });

  assert.equal(query.model, "crm.lead");
  assert.deepEqual(query.domain, [
    ["name", "ilike", "Proyecto Solar"],
    ["partner_id", "ilike", "Empresa Renovable"],
    ["stage_id", "ilike", "Calificado"],
    ["type", "=", "opportunity"],
  ]);
  assert.equal(query.limit, 15);
  assert.deepEqual(query.fields, CLOSED_QUERY_FIELDS.crm);
});

test("buildClosedQuery recorta strings a 100 caracteres", () => {
  const longName = "A".repeat(150);
  const query = buildClosedQuery("consultar_orden_venta", { name: longName });
  assert.equal(query.domain[0][2].length, 100);
  assert.equal(query.domain[0][2], "A".repeat(100));
});

test("buildClosedQuery rechaza fecha inválida lanzando AppError con code invalid_date", () => {
  assert.throws(
    () => buildClosedQuery("consultar_orden_venta", { date_from: "2026/01/01" }),
    (err) => err instanceof AppError && err.status === 400 && err.code === "invalid_date",
  );

  assert.throws(
    () => buildClosedQuery("consultar_orden_compra", { date_to: "01-01-2026" }),
    (err) => err instanceof AppError && err.status === 400 && err.code === "invalid_date",
  );

  assert.throws(
    () => buildClosedQuery("consultar_orden_venta", { date_from: "texto-no-fecha" }),
    (err) => err instanceof AppError && err.status === 400 && err.code === "invalid_date",
  );
});

test("buildClosedQuery rechaza state o type inválido lanzando AppError con code invalid_filter", () => {
  assert.throws(
    () => buildClosedQuery("consultar_orden_venta", { state: "invalid_state" }),
    (err) => err instanceof AppError && err.status === 400 && err.code === "invalid_filter",
  );

  assert.throws(
    () => buildClosedQuery("consultar_orden_compra", { state: "sale" }),
    (err) => err instanceof AppError && err.status === 400 && err.code === "invalid_filter",
  );

  assert.throws(
    () => buildClosedQuery("consultar_oportunidades_crm", { type: "prospect" }),
    (err) => err instanceof AppError && err.status === 400 && err.code === "invalid_filter",
  );
});

test("buildClosedQuery acota limit a 1..50 (default 10)", () => {
  const qDefault = buildClosedQuery("consultar_orden_venta", {});
  assert.equal(qDefault.limit, 10);

  const qMax = buildClosedQuery("consultar_orden_venta", { limit: 500 });
  assert.equal(qMax.limit, 50);

  const qMin = buildClosedQuery("consultar_orden_venta", { limit: -5 });
  assert.equal(qMin.limit, 1);

  const qValid = buildClosedQuery("consultar_orden_venta", { limit: 30 });
  assert.equal(qValid.limit, 30);
});

test("McpServer aplica política de tool_policies en db restringiendo campos e incluyendo name siempre", async () => {
  let queriedFields = null;
  const mockOdoo = {
    async searchRead(model, domain, fields) {
      queriedFields = fields;
      return [{ id: 1, name: "SO-001", amount_total: 1000 }];
    },
  };

  const mockDb = {
    async query(sql, params) {
      assert.ok(sql.includes("agent.tool_policies"));
      assert.equal(params[0], "client-1");
      assert.equal(params[1], "consultar_orden_venta");
      return {
        rows: [
          {
            allowed_fields: ["amount_total"], // No incluye name explícitamente
          },
        ],
      };
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { id: "client-1", slug: "demo" },
    db: mockDb,
    config: {},
  });

  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "consultar_orden_venta",
      arguments: {},
    },
  });

  assert.equal(res.result.isError, false);
  // Name se conserva obligatoriamente junto con amount_total
  assert.deepEqual(queriedFields, ["name", "amount_total"]);
});

test("McpServer usa campos fijos si la db no tiene políticas o falla la consulta", async () => {
  let queriedFields = null;
  const mockOdoo = {
    async searchRead(model, domain, fields) {
      queriedFields = fields;
      return [{ id: 1, name: "SO-002" }];
    },
  };

  const mockDb = {
    async query() {
      throw new Error("DB connection timeout");
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { id: "client-1", slug: "demo" },
    db: mockDb,
    config: {},
  });

  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "consultar_orden_venta",
      arguments: {},
    },
  });

  assert.equal(res.result.isError, false);
  assert.deepEqual(queriedFields, CLOSED_QUERY_FIELDS.sale);
});

// ============================================================================
// 2. CRM NO INSTALADO: tools/list y fallback amigable
// ============================================================================

test("McpServer tools/list oculta consultar_oportunidades_crm si ir.model devuelve vacío", async () => {
  let searchReadCount = 0;
  const mockOdoo = {
    async searchRead(model, domain) {
      if (model === "ir.model") {
        searchReadCount++;
        assert.deepEqual(domain, [["model", "=", "crm.lead"]]);
        return []; // crm.lead no existe
      }
      return [];
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { id: "client-1" },
  });

  const res1 = await server.handleMessage({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/list",
    params: {},
  });

  const tools1 = res1.result.tools;
  const names1 = tools1.map((t) => t.name);
  assert.ok(!names1.includes("consultar_oportunidades_crm"));
  assert.equal(searchReadCount, 1);

  // Segunda llamada comprueba la caché: no debe llamar a ir.model de nuevo
  const res2 = await server.handleMessage({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/list",
    params: {},
  });
  const names2 = res2.result.tools.map((t) => t.name);
  assert.ok(!names2.includes("consultar_oportunidades_crm"));
  assert.equal(searchReadCount, 1, "Debe consultar ir.model exactamente una vez por instancia");
});

test("McpServer tools/list muestra consultar_oportunidades_crm si ir.model lanza error", async () => {
  const mockOdoo = {
    async searchRead(model) {
      if (model === "ir.model") {
        throw new Error("Access denied to ir.model");
      }
      return [];
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { id: "client-1" },
  });

  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/list",
    params: {},
  });

  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes("consultar_oportunidades_crm"));
});

test("McpServer llamada a consultar_oportunidades_crm con upstream 404 devuelve texto amigable", async () => {
  const mockOdoo = {
    async searchRead(model) {
      if (model === "crm.lead") {
        const err = new Error("Model crm.lead not found");
        err.code = "upstream_error";
        err.details = { upstreamStatus: 404 };
        throw err;
      }
      return [];
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { id: "client-1" },
  });

  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "consultar_oportunidades_crm",
      arguments: {},
    },
  });

  assert.equal(res.result.isError, false);
  assert.equal(
    res.result.content[0].text,
    "El módulo CRM no está instalado o no está disponible en esta base de Odoo.",
  );
});

// ============================================================================
// 3. AUDITORÍA: partners_missing_vat con exenciones y facturación previa
// ============================================================================

test("auditDataHygiene genera hallazgo con la recomendación actualizada", async () => {
  const mockOdoo = {
    async searchRead(model) {
      if (model === "account.move") {
        return [{ partner_id: [105, "Cliente Sin NIT"] }];
      }
      if (model === "res.partner") {
        return [{ id: 105, name: "Cliente Sin NIT", email: "audit@test.com" }];
      }
      return [];
    },
  };

  const issues = await auditDataHygiene(mockOdoo);
  const vatIssue = issues.find((i) => i.code === "partners_missing_vat");
  assert.ok(vatIssue);
  assert.equal(vatIssue.count, 1);
  assert.equal(
    vatIssue.recommendation,
    "Completar la identificación fiscal de los clientes facturados que la requieran. Los consumidores finales pueden excluirse con settings.audit.vat_exempt_partner_ids o vat_exempt_category_ids.",
  );
});

test("runFullBusinessAudit respeta opciones desde client.settings.audit", async () => {
  let capturedDomain = null;
  const mockOdoo = {
    async searchRead(model, domain) {
      if (model === "account.move") {
        return [{ partner_id: [201, "Consumidor"], invoice_date: "2026-06-01" }];
      }
      if (model === "res.partner") {
        capturedDomain = domain;
        return [];
      }
      return [];
    },
  };

  const mockDb = {
    async query() {
      return { rows: [{ id: "audit-report-1" }] };
    },
  };

  const client = {
    id: "client-abc",
    name: "Empresa Test",
    slug: "empresa-test",
    settings: {
      audit: {
        vat_exempt_partner_ids: [201],
        vat_exempt_category_ids: [10],
        vat_invoiced_within_months: 6,
      },
    },
  };

  const report = await runFullBusinessAudit({
    db: mockDb,
    odoo: mockOdoo,
    client,
    reportType: "operational_health",
  });

  assert.equal(report.report_id, "audit-report-1");
  assert.ok(capturedDomain);
  const partnerExempt = capturedDomain.find((d) => Array.isArray(d) && d[0] === "id" && d[1] === "not in");
  assert.deepEqual(partnerExempt, ["id", "not in", [201]]);

  const categoryExempt = capturedDomain.find((d) => Array.isArray(d) && d[0] === "category_id" && d[1] === "not in");
  assert.deepEqual(categoryExempt, ["category_id", "not in", [10]]);
});
