import test from "node:test";
import assert from "node:assert/strict";
import { McpServer, MCP_TOOLS } from "../src/mcp-server.js";

test("McpServer responde al handshake initialize con versión 2024-11-05", async () => {
  const server = new McpServer({
    odoo: {},
    client: { id: "client-1", slug: "demo" },
    db: {},
    config: {},
  });

  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.serverInfo.name, "odoo-ai-mcp");
  assert.ok(response.result.capabilities.tools);
});

test("McpServer tools/list devuelve herramientas de lectura y operativas", async () => {
  const server = new McpServer({
    odoo: {},
    client: { id: "client-1", slug: "demo" },
    db: {},
    config: {},
  });

  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 2);
  const tools = response.result.tools;
  assert.ok(Array.isArray(tools));
  assert.ok(tools.length >= 10);

  // Verificar presencia de herramientas clave
  const toolNames = new Set(tools.map((t) => t.name));
  assert.ok(toolNames.has("consultar_orden_venta"));
  assert.ok(toolNames.has("consultar_inventario"));
  assert.ok(toolNames.has("crear_borrador_orden_venta"));
  assert.ok(toolNames.has("confirmar_orden_venta"));
  assert.ok(toolNames.has("confirmar_accion_critica"));
});

test("McpServer tools/call ejecuta lectura estándar y devuelve contenido en texto", async () => {
  const mockOdoo = {
    async searchRead(model, domain, fields, options) {
      return [{ id: 10, name: "SO-010", amount_total: 250000 }];
    },
  };

  const server = new McpServer({
    odoo: mockOdoo,
    client: { id: "client-1", slug: "demo" },
    db: {},
    config: {},
  });

  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "consultar_orden_venta",
      arguments: { domain: [["state", "=", "sale"]], limit: 1 },
    },
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 3);
  assert.equal(response.result.isError, false);
  assert.ok(Array.isArray(response.result.content));
  assert.equal(response.result.content[0].type, "text");
  assert.match(response.result.content[0].text, /SO-010/);
});

test("McpServer maneja errores y métodos no encontrados", async () => {
  const server = new McpServer({
    odoo: {},
    client: { id: "client-1", slug: "demo" },
    db: {},
    config: {},
  });

  const notFound = await server.handleMessage({
    jsonrpc: "2.0",
    id: 99,
    method: "invalid/method",
  });

  assert.equal(notFound.error.code, -32601);

  const parseErr = await server.handleMessage("invalid json");
  assert.equal(parseErr.error.code, -32700);
});
