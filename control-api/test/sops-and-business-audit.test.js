import test from "node:test";
import assert from "node:assert/strict";
import { searchSops, answerSopQuery, scoreSopMatch, upsertSop } from "../src/sops.js";
import {
  auditDataHygiene,
  auditBottlenecks,
  formatBusinessAuditReport,
  runFullBusinessAudit,
} from "../src/audit-business.js";
import { McpServer } from "../src/mcp-server.js";

test("scoreSopMatch calcula relevancia según coincidencia en título, palabras clave y contenido", () => {
  const sop = {
    title: "Autorización de Descuentos Especiales",
    category: "ventas",
    content_md: "Pasos para otorgar descuentos mayores al 15%...",
    keywords: ["descuento", "precio especial"],
  };

  const score1 = scoreSopMatch(sop, ["descuento"]);
  assert.ok(score1 > 0);

  const scoreZero = scoreSopMatch(sop, ["vacaciones", "nomina"]);
  assert.equal(scoreZero, 0);
});

test("searchSops busca procedimientos por coincidencia de texto", async () => {
  const mockSops = [
    {
      id: "sop-1",
      sop_key: "SOP-VENTAS-001",
      title: "Autorización de Descuentos Comerciales",
      category: "ventas",
      content_md: "1. Revisar margen\n2. Solicitar visto bueno a Gerencia",
      keywords: ["descuento", "precio especial"],
    },
    {
      id: "sop-2",
      sop_key: "SOP-LOGISTICA-001",
      title: "Devolución de Mercancía por Garantía",
      category: "inventario",
      content_md: "1. Inspeccionar producto devuelto",
      keywords: ["devolución", "garantía"],
    },
  ];

  const mockDb = {
    async query() {
      return { rows: mockSops };
    },
  };

  const results = await searchSops(mockDb, "client-1", "descuento comercial");
  assert.equal(results.length, 1);
  assert.equal(results[0].sop_key, "SOP-VENTAS-001");
});

test("answerSopQuery responde sin alucinaciones si no hay SOP documentado", async () => {
  const mockDb = {
    async query() {
      return { rows: [] };
    },
  };

  const res = await answerSopQuery({
    db: mockDb,
    client: { id: "client-1", name: "Empresa X" },
    query: "cómo hackear la base de datos",
  });

  assert.equal(res.found, false);
  assert.ok(res.text.includes("Procedimiento no documentado"));
  assert.ok(res.text.includes("No encontré una política o procedimiento operativo oficial"));
  assert.ok(res.text.includes("supervisor"));
});

test("answerSopQuery devuelve el procedimiento formateado cuando hay coincidencia", async () => {
  const mockDb = {
    async query() {
      return {
        rows: [
          {
            id: "sop-1",
            sop_key: "SOP-VENTAS-001",
            title: "Autorización de Descuentos Comerciales",
            category: "ventas",
            content_md: "1. Revisar margen del producto.\n2. Solicitar autorización escrita a Gerencia.",
            keywords: ["descuento"],
          },
        ],
      };
    },
  };

  const res = await answerSopQuery({
    db: mockDb,
    client: { id: "client-1", name: "Empresa X" },
    query: "cuál es el procedimiento para autorizar un descuento",
  });

  assert.equal(res.found, true);
  assert.equal(res.sop_key, "SOP-VENTAS-001");
  assert.equal(res.title, "Autorización de Descuentos Comerciales");
  assert.ok(res.text.includes("Procedimiento Oficial: Autorización de Descuentos Comerciales"));
  assert.ok(res.text.includes("Revisar margen del producto"));
});

test("upsertSop inserta o actualiza un procedimiento en base de datos", async () => {
  const queries = [];
  const mockDb = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{ id: "sop-uuid-1" }] };
    },
  };

  const res = await upsertSop(mockDb, "client-1", {
    sopKey: "SOP-TEST-001",
    title: "Procedimiento de Prueba",
    contentMd: "Contenido de prueba",
    keywords: ["test"],
  });

  assert.equal(res.id, "sop-uuid-1");
  assert.equal(res.sop_key, "SOP-TEST-001");
  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes("agent.client_sops"));
});

test("auditDataHygiene detecta clientes sin NIT, productos sin costo e inventario negativo", async () => {
  const mockOdoo = {
    async searchRead(model, domain, fields) {
      if (model === "res.partner") {
        return [
          { id: 101, name: "Cliente Sin NIT", email: "contacto@sin-nit.com" },
        ];
      }
      if (model === "product.product") {
        const isCostQuery = domain.some((d) => Array.isArray(d) && d[0] === "standard_price");
        if (isCostQuery) {
          return [{ id: 201, name: "Producto Sin Costo", default_code: "P-01" }];
        }
        return [{ id: 301, name: "Producto Negativo", default_code: "P-02", qty_available: -4 }];
      }
      if (model === "sale.order") {
        return [{ id: 401, name: "SO-ABANDONADA", create_date: "2024-01-01" }];
      }
      return [];
    },
  };

  const issues = await auditDataHygiene(mockOdoo);
  assert.equal(issues.length, 4);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("partners_missing_vat"));
  assert.ok(codes.includes("products_missing_cost"));
  assert.ok(codes.includes("negative_inventory"));
  assert.ok(codes.includes("abandoned_quotations"));
});

test("auditBottlenecks detecta órdenes confirmadas sin facturar y albaranes retrasados", async () => {
  const mockOdoo = {
    async searchRead(model) {
      if (model === "sale.order") {
        return [{ id: 501, name: "SO-SIN-FAC", amount_total: 5000000 }];
      }
      if (model === "stock.picking") {
        return [{ id: 601, name: "WH/OUT/001", scheduled_date: "2025-01-01" }];
      }
      return [];
    },
  };

  const issues = await auditBottlenecks(mockOdoo);
  assert.equal(issues.length, 2);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("sales_pending_invoice"));
  assert.ok(codes.includes("delayed_stock_pickings"));
});

test("runFullBusinessAudit calcula severidad global y persiste reporte en db", async () => {
  const mockOdoo = {
    async searchRead(model) {
      if (model === "res.partner") return [{ id: 101, name: "Empresa X" }];
      return [];
    },
  };

  const dbInserts = [];
  const mockDb = {
    async query(sql, params) {
      dbInserts.push({ sql, params });
      return { rows: [{ id: "audit-report-uuid-1" }] };
    },
  };

  const report = await runFullBusinessAudit({
    db: mockDb,
    odoo: mockOdoo,
    client: { id: "client-123", name: "Empresa Piloto", slug: "piloto" },
    reportType: "operational_health",
  });

  assert.equal(report.report_id, "audit-report-uuid-1");
  assert.equal(report.findings_count, 1);
  assert.equal(report.severity, "warning");
  assert.ok(report.text.includes("Empresa Piloto"));
  assert.equal(dbInserts.length, 1);
  assert.equal(dbInserts[0].params[0], "client-123");
});

test("McpServer ejecuta herramientas consultar_procedimiento_sop y ejecutar_auditoria_negocio", async () => {
  const mockDb = {
    async query(sql) {
      if (sql.includes("agent.client_sops")) {
        return {
          rows: [
            {
              id: "sop-1",
              sop_key: "SOP-COMPRAS-001",
              title: "Aprobación de Órdenes de Compra Mayores a $10M",
              category: "compras",
              content_md: "1. Revisar tres cotizaciones comparativas",
              keywords: ["compra mayor", "licitacion"],
            },
          ],
        };
      }
      if (sql.includes("agent.business_audit_reports")) {
        return { rows: [{ id: "audit-1" }] };
      }
      return { rows: [] };
    },
  };

  const mockOdoo = {
    async searchRead() {
      return [];
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { id: "client-mcp-1", name: "Demo Corp", slug: "demo-corp" },
    db: mockDb,
    config: {},
  });

  // 1. Consultar SOP vía MCP
  const sopCallRes = await server.handleMessage({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "consultar_procedimiento_sop",
      arguments: { query: "órdenes de compra mayores" },
    },
  });

  assert.equal(sopCallRes.jsonrpc, "2.0");
  assert.equal(sopCallRes.id, 10);
  assert.equal(sopCallRes.result.isError, false);
  const sopPayload = JSON.parse(sopCallRes.result.content[0].text);
  assert.equal(sopPayload.found, true);
  assert.equal(sopPayload.sop_key, "SOP-COMPRAS-001");

  // 2. Ejecutar auditoría de negocio vía MCP
  const auditCallRes = await server.handleMessage({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "ejecutar_auditoria_negocio",
      arguments: { reportType: "hygiene" },
    },
  });

  assert.equal(auditCallRes.jsonrpc, "2.0");
  assert.equal(auditCallRes.id, 11);
  assert.equal(auditCallRes.result.isError, false);
  const auditPayload = JSON.parse(auditCallRes.result.content[0].text);
  assert.equal(auditPayload.findings_count, 0);
  assert.equal(auditPayload.severity, "info");
});
