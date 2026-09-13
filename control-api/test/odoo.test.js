import test from "node:test";
import assert from "node:assert/strict";
import { OdooJson2Client } from "../src/odoo.js";

test("cliente JSON-2 usa bearer, base y argumentos nombrados", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify([{ id: 7, name: "S0007" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new OdooJson2Client({
    baseUrl: "https://odoo.example.test/",
    database: "demo19",
    apiKey: "secret-key",
  });
  const result = await client.searchRead(
    "sale.order",
    [["name", "=", "S0007"]],
    ["name"],
    { limit: 1 },
  );
  assert.equal(result[0].id, 7);
  assert.equal(captured.url, "https://odoo.example.test/json/2/sale.order/search_read");
  assert.equal(captured.options.headers.authorization, "bearer secret-key");
  assert.equal(captured.options.headers["x-odoo-database"], "demo19");
  assert.deepEqual(JSON.parse(captured.options.body), {
    domain: [["name", "=", "S0007"]],
    fields: ["name"],
    limit: 1,
  });
});

