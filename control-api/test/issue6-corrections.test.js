import test from "node:test";
import assert from "node:assert/strict";
import { createDraftSaleOrder, createDraftCustomerInvoice } from "../src/operational-actions.js";
import { McpServer, MCP_TOOLS, READ_ONLY_TOOLS } from "../src/mcp-server.js";
import { fetchJson } from "../src/http.js";

// ============================================================================
// ISSUE 1: Precios y descripciones en creación de orden de venta y factura
// ============================================================================

test("Issue 1: createDraftSaleOrder omite price_unit y name si no se especifican", async () => {
  const calls = [];
  const mockOdoo = {
    async create(model, values, context) {
      calls.push({ model, values, context });
      return [{ id: 101 }];
    },
  };

  await createDraftSaleOrder(mockOdoo, {
    partnerId: 5,
    orderLines: [{ productId: 20, quantity: 4 }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].values.state, undefined);
  const line = calls[0].values.order_line[0][2];
  assert.equal(line.product_id, 20);
  assert.equal(line.product_uom_qty, 4);
  assert.equal(line.price_unit, undefined);
  assert.equal(line.name, undefined);
});

test("Issue 1: createDraftSaleOrder incluye price_unit y name cuando vienen explícitos", async () => {
  const calls = [];
  const mockOdoo = {
    async create(model, values, context) {
      calls.push({ model, values, context });
      return [{ id: 102 }];
    },
  };

  await createDraftSaleOrder(mockOdoo, {
    partnerId: 5,
    orderLines: [{ productId: 20, quantity: 4, priceUnit: 15000, name: "Consultoría" }],
  });

  const line = calls[0].values.order_line[0][2];
  assert.equal(line.price_unit, 15000);
  assert.equal(line.name, "Consultoría");
  assert.equal(calls[0].values.state, undefined);
});

test("Issue 1: createDraftCustomerInvoice omite price_unit y name si no se especifican", async () => {
  const calls = [];
  const mockOdoo = {
    async create(model, values, context) {
      calls.push({ model, values, context });
      return [{ id: 201 }];
    },
  };

  await createDraftCustomerInvoice(mockOdoo, {
    partnerId: 8,
    invoiceLines: [{ productId: 35, quantity: 2 }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].values.state, undefined);
  const line = calls[0].values.invoice_line_ids[0][2];
  assert.equal(line.product_id, 35);
  assert.equal(line.quantity, 2);
  assert.equal(line.price_unit, undefined);
  assert.equal(line.name, undefined);
});

test("Issue 1: createDraftCustomerInvoice incluye price_unit 15000 cuando viene explícito", async () => {
  const calls = [];
  const mockOdoo = {
    async create(model, values, context) {
      calls.push({ model, values, context });
      return [{ id: 202 }];
    },
  };

  await createDraftCustomerInvoice(mockOdoo, {
    partnerId: 8,
    invoiceLines: [{ productId: 35, quantity: 2, priceUnit: 15000 }],
  });

  const line = calls[0].values.invoice_line_ids[0][2];
  assert.equal(line.price_unit, 15000);
  assert.equal(calls[0].values.state, undefined);
});

test("Issue 1: inputSchema de MCP para orden de venta y factura tiene priceUnit opcional con descripción", () => {
  const saleTool = MCP_TOOLS.find((t) => t.name === "crear_borrador_orden_venta");
  const invoiceTool = MCP_TOOLS.find((t) => t.name === "crear_borrador_factura_cliente");

  assert.ok(saleTool);
  assert.ok(invoiceTool);

  const saleLineSchema = saleTool.inputSchema.properties.orderLines.items;
  assert.deepEqual(saleLineSchema.required, ["productId", "quantity"]);
  assert.equal(
    saleLineSchema.properties.priceUnit.description,
    "Opcional: si se omite, Odoo aplica la lista de precios del cliente."
  );

  const invoiceLineSchema = invoiceTool.inputSchema.properties.invoiceLines.items;
  assert.deepEqual(invoiceLineSchema.required, ["productId", "quantity"]);
  assert.equal(
    invoiceLineSchema.properties.priceUnit.description,
    "Opcional: si se omite, Odoo aplica la lista de precios del cliente."
  );
});

// ============================================================================
// ISSUE 2: Modo carpeta local sin base de datos de control
// ============================================================================

test("Issue 2: McpServer con db null en tools/list solo devuelve READ_ONLY_TOOLS", async () => {
  const server = new McpServer({
    odoo: {},
    client: { slug: "demo", name: "Demo" },
    db: null,
    config: {},
  });

  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  const toolNames = res.result.tools.map((t) => t.name);
  assert.equal(toolNames.length, READ_ONLY_TOOLS.size);

  assert.ok(!toolNames.includes("crear_borrador_orden_venta"));
  assert.ok(!toolNames.includes("confirmar_orden_venta"));
  assert.ok(!toolNames.includes("crear_o_actualizar_tablero"));

  for (const name of toolNames) {
    assert.ok(READ_ONLY_TOOLS.has(name));
  }
});

test("Issue 2: McpServer con db null en tools/call para crear_borrador_orden_venta devuelve isError true y no llama a Odoo", async () => {
  let odooCalled = false;
  const mockOdoo = {
    async create() {
      odooCalled = true;
      return [{ id: 999 }];
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { slug: "demo", name: "Demo" },
    db: null,
    config: {},
  });

  const res = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "crear_borrador_orden_venta",
      arguments: {
        partnerId: 1,
        orderLines: [{ productId: 1, quantity: 1 }],
      },
    },
  });

  assert.equal(res.result.isError, true);
  assert.ok(
    res.result.content[0].text.includes("base de datos de control"),
    `El mensaje de error debería mencionar 'base de datos de control': ${res.result.content[0].text}`
  );
  assert.equal(odooCalled, false, "Odoo no debió haber sido llamado");
});

// ============================================================================
// ISSUE 3: Mensajes legibles en errores upstream de Odoo (fetchJson)
// ============================================================================

test("Issue 3: fetchJson ante 422 con UserError extrae mensaje legible y omite Traceback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      name: "odoo.exceptions.UserError",
      message: "No puede confirmar: falta el cliente",
      debug: "Traceback (most recent call last):\n  File 'server.py', line 123, in execute\n    raise UserError()",
    }),
    {
      status: 422,
      headers: { "content-type": "application/json" },
    }
  );

  await assert.rejects(
    () => fetchJson("https://odoo.example.test/json/2/sale.order/action_confirm"),
    (err) => {
      assert.equal(err.code, "upstream_error");
      assert.equal(err.status, 502);
      assert.equal(err.details?.upstreamStatus, 422);
      assert.ok(err.message.includes("No puede confirmar: falta el cliente"));
      assert.ok(!err.message.includes("Traceback"));
      return true;
    }
  );
});

test("Issue 3: fetchJson ante 500 sin cuerpo devuelve mensaje genérico sin colapsar", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response("", {
    status: 500,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(
    () => fetchJson("https://odoo.example.test/json/2/sale.order/action_confirm"),
    (err) => {
      assert.equal(err.code, "upstream_error");
      assert.equal(err.status, 502);
      assert.equal(err.details?.upstreamStatus, 500);
      assert.equal(err.message, "Servicio externo respondió 500.");
      return true;
    }
  );
});

test("Issue 3: fetchJson extrae mensaje según prioridad (error.data.message y error.message)", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Prioridad 2: body.error.data.message
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: {
        code: 200,
        message: "Odoo Server Error",
        data: {
          name: "odoo.exceptions.ValidationError",
          message: "El campo NIF es obligatorio.",
        },
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );

  await assert.rejects(
    () => fetchJson("https://odoo.example.test/api"),
    (err) => {
      assert.ok(err.message.includes("El campo NIF es obligatorio."));
      return true;
    }
  );

  // Prioridad 3: body.error.message (cuando es string y no hay data.message)
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: {
        code: 403,
        message: "Acceso denegado al recurso.",
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } }
  );

  await assert.rejects(
    () => fetchJson("https://odoo.example.test/api"),
    (err) => {
      assert.ok(err.message.includes("Acceso denegado al recurso."));
      return true;
    }
  );
});

test("Issue 3: fetchJson normaliza y recorta mensajes muy largos a <= 300 caracteres de texto", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const longText = "Línea 1 con detalle.\n\n   Línea 2 con mucho más texto que se extiende " + "X".repeat(400);
  globalThis.fetch = async () => new Response(
    JSON.stringify({ message: longText }),
    { status: 400, headers: { "content-type": "application/json" } }
  );

  await assert.rejects(
    () => fetchJson("https://odoo.example.test/api"),
    (err) => {
      assert.ok(err.message.startsWith("Servicio externo respondió 400: "));
      const extractedText = err.message.slice("Servicio externo respondió 400: ".length);
      assert.ok(extractedText.length <= 300);
      assert.ok(!extractedText.includes("\n"));
      return true;
    }
  );
});
