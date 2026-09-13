import test from "node:test";
import assert from "node:assert/strict";
import { deliverTelegramMessage } from "../src/telegram.js";
import { fetchJson } from "../src/http.js";

test("reintenta una entrega transitoria a Telegram sin cambiar el contenido", async () => {
  let calls = 0;
  const pauses = [];
  let deliveredBody;
  const request = async (_url, options) => {
    calls += 1;
    if (calls < 3) throw new TypeError("fallo transitorio");
    deliveredBody = JSON.parse(options.body);
    return { ok: true };
  };

  await deliverTelegramMessage("token-de-prueba", {
    chat_id: 123,
    text: "Respuesta",
    protect_content: true,
  }, {
    request,
    pause: async (milliseconds) => { pauses.push(milliseconds); },
  });

  assert.equal(calls, 3);
  assert.deepEqual(pauses, [250, 500]);
  assert.deepEqual(deliveredBody, {
    chat_id: 123,
    text: "Respuesta",
    protect_content: true,
  });
});

test("convierte un fallo de red externo en un error controlado", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };

  await assert.rejects(
    fetchJson("https://example.test"),
    (error) => error.code === "upstream_unreachable" && error.status === 502,
  );
});
