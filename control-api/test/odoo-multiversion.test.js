import test from "node:test";
import assert from "node:assert/strict";
import {
  detectInstance,
  parseMajorSeries,
  isLegacyRpcSeries,
  OdooJson2Client,
  OdooLegacyRpcClient,
  Odoo20McpClient,
  OdooClient,
  createOdooClient,
} from "../src/odoo.js";

test("parseMajorSeries y isLegacyRpcSeries identifican correctamente versiones de Odoo 14 a 20", () => {
  assert.equal(parseMajorSeries("14.0-20210501"), "14.0");
  assert.equal(parseMajorSeries("16.0+e"), "16.0");
  assert.equal(parseMajorSeries("17.0"), "17.0");
  assert.equal(parseMajorSeries("18.0alpha"), "18.0");
  assert.equal(parseMajorSeries("19.0"), "19.0");
  assert.equal(parseMajorSeries("20.0"), "20.0");
  assert.equal(parseMajorSeries("13.0"), "");

  assert.equal(isLegacyRpcSeries("14.0"), true);
  assert.equal(isLegacyRpcSeries("16.0"), true);
  assert.equal(isLegacyRpcSeries("18.0"), true);
  assert.equal(isLegacyRpcSeries("19.0"), false);
  assert.equal(isLegacyRpcSeries("20.0"), false);
});

test("detectInstance sondea /web/webclient/version_info e identifica series y transporte", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let capturedUrl = null;
  let capturedBody = null;

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: capturedBody.id,
      result: {
        server_version: "18.0+e",
        server_version_info: [18, 0, 0, "final", 0, "e"],
        server_serie: "18.0",
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const detected = await detectInstance("https://odoo18.empresa.test/odoo");
  assert.equal(capturedUrl, "https://odoo18.empresa.test/web/webclient/version_info");
  assert.equal(capturedBody.method, "call");
  assert.equal(detected.baseUrl, "https://odoo18.empresa.test");
  assert.equal(detected.server_version, "18.0+e");
  assert.equal(detected.server_series, "18.0");
  assert.equal(detected.transport, "legacy_rpc");
});

test("detectInstance detecta Odoo 20 como json2 con soporte MCP", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      result: {
        server_version: "20.0-enterprise",
        server_version_info: [20, 0, 0, "final", 0, "e"],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const detected = await detectInstance("https://odoo20.empresa.test");
  assert.equal(detected.server_series, "20.0");
  assert.equal(detected.transport, "json2");
});

test("OdooLegacyRpcClient autentica con common.authenticate y ejecuta llamadas con execute_kw", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });

    if (body.params?.service === "common" && body.params?.method === "authenticate") {
      const [db, login, key] = body.params.args;
      if (db === "prod_db" && login === "consultor@empresa.com" && key === "secret_api_key") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (body.params?.service === "object" && body.params?.method === "execute_kw") {
      const [db, uid, key, model, method, posArgs, kwargs] = body.params.args;
      assert.equal(db, "prod_db");
      assert.equal(uid, 42);
      assert.equal(key, "secret_api_key");

      if (model === "sale.order" && method === "search_read") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: [{ id: 101, name: "SO101", amount_total: 1500000 }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (model === "sale.order" && method === "create") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: 102,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (model === "sale.order" && method === "write") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (model === "sale.order" && method === "action_confirm") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new OdooLegacyRpcClient({
    baseUrl: "https://odoo17.empresa.test",
    database: "prod_db",
    apiKey: "secret_api_key",
    login: "consultor@empresa.com",
  });

  // 1. searchRead
  const readRows = await client.searchRead(
    "sale.order",
    [["state", "=", "sale"]],
    ["name", "amount_total"],
    { limit: 5 },
  );
  assert.equal(readRows.length, 1);
  assert.equal(readRows[0].id, 101);

  // Verificar que la primera llamada fue authenticate y la segunda execute_kw
  assert.equal(calls[0].body.params.service, "common");
  assert.equal(calls[0].body.params.method, "authenticate");
  assert.equal(calls[1].body.params.service, "object");
  assert.equal(calls[1].body.params.method, "execute_kw");
  assert.deepEqual(calls[1].body.params.args[5], [[["state", "=", "sale"]]]); // Positional domain

  // 2. create: debe desempaquetar vals_list[0] a diccionario simple
  const createdId = await client.create("sale.order", { partner_id: 10, note: "Pedido de prueba" });
  assert.equal(createdId, 102);
  const createCall = calls[calls.length - 1];
  assert.deepEqual(createCall.body.params.args[5], [{ partner_id: 10, note: "Pedido de prueba" }]);

  // 3. write: debe enviar [ids, vals] posicional
  const writeSuccess = await client.write("sale.order", 101, { note: "Actualizado" });
  assert.equal(writeSuccess, true);
  const writeCall = calls[calls.length - 1];
  assert.deepEqual(writeCall.body.params.args[5], [[101], { note: "Actualizado" }]);

  // 4. action_confirm: debe enviar [ids] posicional
  const confirmResult = await client.call("sale.order", "action_confirm", { ids: [101] });
  assert.equal(confirmResult, true);
  const confirmCall = calls[calls.length - 1];
  assert.deepEqual(confirmCall.body.params.args[5], [[101]]);
});

test("OdooLegacyRpcClient maneja errores RPC de Odoo y sanitiza mensajes de excepción", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: 200,
        message: "Odoo Server Error",
        data: {
          name: "odoo.exceptions.UserError",
          message: "No se puede confirmar el pedido sin líneas de productos.\nTraceback (most recent call last):\n...",
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new OdooLegacyRpcClient({
    baseUrl: "https://odoo18.empresa.test",
    database: "demo18",
    apiKey: "dummy-key",
    login: "user@test.com",
    uid: 5,
  });

  await assert.rejects(
    async () => {
      await client.call("sale.order", "action_confirm", { ids: [999] });
    },
    (err) => {
      assert.equal(err.code, "odoo_rpc_error");
      assert.ok(err.message.includes("No se puede confirmar el pedido sin líneas de productos."));
      assert.ok(!err.message.includes("Traceback"));
      return true;
    },
  );
});

test("Odoo20McpClient interactúa con el endpoint nativo /mcp", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const mcpCalls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    mcpCalls.push({ url, headers: options.headers, body });

    if (body.method === "tools/list") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "get_models", description: "List available models" },
            { name: "get_fields", description: "List model fields" },
            { name: "search", description: "Search records" },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (body.method === "tools/call" && body.params.name === "search") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify([{ id: 1, name: "Producto 1" }]) }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const mcp = new Odoo20McpClient({
    baseUrl: "https://odoo20.empresa.test",
    apiKey: "mcp-scoped-token",
    database: "odoo20_db",
  });

  const tools = await mcp.listTools();
  assert.equal(tools.length, 3);
  assert.equal(tools[0].name, "get_models");

  const searchResult = await mcp.search("product.product", [["sale_ok", "=", true]], ["name"], 5);
  assert.ok(searchResult.content);

  assert.equal(mcpCalls[0].url, "https://odoo20.empresa.test/mcp");
  assert.equal(mcpCalls[0].headers.authorization, "bearer mcp-scoped-token");
  assert.equal(mcpCalls[0].headers["x-odoo-database"], "odoo20_db");
});

test("createOdooClient instancia polimórficamente el cliente según versión y transporte", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    return new Response(JSON.stringify([{ id: 1 }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // 1. Odoo 16: debe seleccionar Legacy RPC
  const client16 = createOdooClient({
    baseUrl: "https://odoo16.empresa.test",
    database: "demo16",
    apiKey: "key16",
    login: "admin",
    odooVersion: "16.0",
  });
  assert.equal(client16.transport, "legacy_rpc");
  assert.ok(client16.adapter instanceof OdooLegacyRpcClient);

  // 2. Odoo 19: debe seleccionar JSON-2
  const client19 = createOdooClient({
    baseUrl: "https://odoo19.empresa.test",
    database: "demo19",
    apiKey: "key19",
    odooVersion: "19.0",
  });
  assert.equal(client19.transport, "json2");
  assert.ok(client19.adapter instanceof OdooJson2Client);
  assert.equal(client19.mcp, null);

  // 3. Odoo 20: modo híbrido JSON-2 + MCP nativo habilitado
  const client20 = createOdooClient({
    baseUrl: "https://odoo20.empresa.test",
    database: "demo20",
    apiKey: "key20",
    odooVersion: "20.0",
  });
  assert.equal(client20.transport, "json2");
  assert.ok(client20.adapter instanceof OdooJson2Client);
  assert.ok(client20.mcp instanceof Odoo20McpClient);
  assert.equal(client20.mcp.baseUrl, "https://odoo20.empresa.test");
});
