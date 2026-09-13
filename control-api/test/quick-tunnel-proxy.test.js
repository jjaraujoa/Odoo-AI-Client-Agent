import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createQuickTunnelProxy,
  TELEGRAM_WEBHOOK_PATH,
} from "../src/quick-tunnel-proxy.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function request({ port, method = "GET", path = "/", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1", port, method, path, headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("el proxy solo publica el POST exacto del webhook", async () => {
  const upstream = http.createServer((incoming, response) => response.end("upstream"));
  const upstreamAddress = await listen(upstream);
  const proxy = createQuickTunnelProxy({ targetPort: upstreamAddress.port, listenPort: 0 });
  const proxyAddress = await proxy.listen();
  try {
    const root = await request({ port: proxyAddress.port, path: "/" });
    assert.equal(root.status, 404);
    const getWebhook = await request({ port: proxyAddress.port, path: TELEGRAM_WEBHOOK_PATH });
    assert.equal(getWebhook.status, 405);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("reenvía el cuerpo y el secreto de Telegram sin abrir otras cabeceras", async () => {
  let captured;
  const upstream = http.createServer((incoming, response) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      captured = {
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(202, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  const upstreamAddress = await listen(upstream);
  const proxy = createQuickTunnelProxy({ targetPort: upstreamAddress.port, listenPort: 0 });
  const proxyAddress = await proxy.listen();
  try {
    const body = '{"update_id":123}';
    const result = await request({
      port: proxyAddress.port,
      method: "POST",
      path: TELEGRAM_WEBHOOK_PATH,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-telegram-bot-api-secret-token": "secret-test",
        "x-not-allowed": "blocked",
      },
      body,
    });
    assert.equal(result.status, 202);
    assert.equal(captured.method, "POST");
    assert.equal(captured.path, TELEGRAM_WEBHOOK_PATH);
    assert.equal(captured.body, body);
    assert.equal(captured.headers["x-telegram-bot-api-secret-token"], "secret-test");
    assert.equal(captured.headers["x-not-allowed"], undefined);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("rechaza cuerpos declarados por encima del límite", async () => {
  const upstream = http.createServer((_incoming, response) => response.end("unexpected"));
  const upstreamAddress = await listen(upstream);
  const proxy = createQuickTunnelProxy({
    targetPort: upstreamAddress.port,
    listenPort: 0,
    maxBodyBytes: 8,
  });
  const proxyAddress = await proxy.listen();
  try {
    const result = await request({
      port: proxyAddress.port,
      method: "POST",
      path: TELEGRAM_WEBHOOK_PATH,
      headers: { "content-length": 9 },
      body: "123456789",
    });
    assert.equal(result.status, 413);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});
