import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { McpServer } from "../src/mcp-server.js";

function createMockDb(clientId) {
  const pendingActions = new Map();
  const executions = [];

  return {
    pendingActions,
    executions,
    async query(sql, params = []) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();

      // tool_policies
      if (normalizedSql.includes("FROM agent.tool_policies")) {
        const toolName = params[1];
        if (toolName === "confirmar_orden_venta") {
          return {
            rows: [
              {
                client_id: clientId,
                tool_name: "confirmar_orden_venta",
                risk_level: 3,
                confirmation_required: true,
                enabled: true,
              },
            ],
          };
        }
        return { rows: [] };
      }

      // INSERT INTO agent.pending_actions
      if (normalizedSql.includes("INSERT INTO agent.pending_actions")) {
        const id = randomUUID();
        const row = {
          id,
          client_id: params[0],
          linked_user_id: params[1],
          approver_linked_user_id: params[2],
          telegram_chat_id: params[3],
          action_type: "operational_action",
          status: "pending",
          preview: params[4],
          items: params[5],
          idempotency_key: params[6],
          confirmation_code: params[7],
          expires_at: params[8],
          channel: params[9],
          decided_via: null,
          decision_note: null,
          result: null,
          completed_at: null,
        };
        pendingActions.set(id, row);
        return { rows: [{ id }] };
      }

      // INSERT INTO agent.action_executions
      if (normalizedSql.includes("INSERT INTO agent.action_executions")) {
        executions.push({ params });
        return { rows: [] };
      }

      // UPDATE agent.pending_actions SET status = 'executing' ... RETURNING *
      if (normalizedSql.includes("UPDATE agent.pending_actions SET status = 'executing'")) {
        const actionId = params[0];
        const row = pendingActions.get(actionId);
        if (
          row &&
          row.client_id === params[1] &&
          row.status === "pending" &&
          new Date(row.expires_at) > new Date()
        ) {
          row.status = "executing";
          row.confirmed_at = new Date();
          row.decided_via = params[3];
          return { rows: [{ ...row }] };
        }
        return { rows: [] };
      }

      // UPDATE agent.pending_actions SET status = 'cancelled' ... RETURNING *
      if (
        normalizedSql.includes("UPDATE agent.pending_actions SET status = 'cancelled'") &&
        normalizedSql.includes("RETURNING *")
      ) {
        const actionId = params[0];
        const row = pendingActions.get(actionId);
        if (row && row.client_id === params[1] && row.status === "pending") {
          row.status = "cancelled";
          row.decided_via = params[3];
          row.decision_note = params[4];
          return { rows: [{ ...row }] };
        }
        return { rows: [] };
      }

      // UPDATE agent.pending_actions SET status = 'cancelled' (por fallas de entrega telegram u otros)
      if (normalizedSql.includes("UPDATE agent.pending_actions SET status = 'cancelled'")) {
        const actionId = params[0];
        const row = pendingActions.get(actionId);
        if (row) {
          row.status = "cancelled";
          row.decision_note = params[2] || "cancelled";
        }
        return { rows: [] };
      }

      // UPDATE final de status en pending_actions: SET status = $2, completed_at = now(), result = $3 WHERE id = $1
      if (normalizedSql.includes("UPDATE agent.pending_actions SET status = $2")) {
        const actionId = params[0];
        const row = pendingActions.get(actionId);
        if (row) {
          row.status = params[1];
          row.completed_at = new Date();
          row.result = params[2];
        }
        return { rows: [] };
      }

      // SELECT status, expires_at, approver_linked_user_id FROM agent.pending_actions WHERE id = $1
      if (normalizedSql.includes("SELECT status, expires_at, approver_linked_user_id FROM agent.pending_actions")) {
        const actionId = params[0];
        const row = pendingActions.get(actionId);
        return { rows: row ? [row] : [] };
      }

      // SELECT id, status, preview, result, expires_at FROM agent.pending_actions (getApprovalStatus)
      if (normalizedSql.includes("FROM agent.pending_actions") && normalizedSql.includes("SELECT id, status")) {
        const actionId = params[0];
        const row = pendingActions.get(actionId);
        return { rows: row ? [row] : [] };
      }

      // channel_credentials
      if (normalizedSql.includes("FROM agent.channel_credentials")) {
        return { rows: [] };
      }

      return { rows: [] };
    },
  };
}

function createMockOdoo() {
  const calls = [];
  return {
    calls,
    async searchRead(model, domain) {
      if (model === "sale.order") {
        const idIn = domain.find((d) => Array.isArray(d) && d[0] === "id" && d[1] === "in");
        const idEq = domain.find((d) => Array.isArray(d) && d[0] === "id" && d[1] === "=");
        let ids = [];
        if (idIn) ids = idIn[2];
        else if (idEq) ids = [idEq[2]];
        else ids = [11, 12];

        return ids.map((id) => ({
          id: Number(id),
          name: `SO-00${id}`,
          partner_id: [1, "Cliente Prueba"],
          amount_total: 150000,
          currency_id: [1, "COP"],
          state: "draft",
          write_date: "2026-01-01 12:00:00",
        }));
      }
      return [];
    },
    async call(model, method, kwargs) {
      calls.push({ model, method, kwargs });
      return true;
    },
  };
}

function setupServerHarness({ elicitationTimeoutMs = 5000, approvalUser = null } = {}) {
  const clientId = randomUUID();
  const client = { id: clientId, slug: "demo", settings: {} };
  const db = createMockDb(clientId);
  const odoo = createMockOdoo();
  const config = { credentialMasterKey: "0123456789abcdef0123456789abcdef" };

  const server = new McpServer({
    odoo,
    client,
    db,
    config,
    approvalUser,
    elicitationTimeoutMs,
  });

  const input = new PassThrough();
  const output = new PassThrough();
  server.startStdio(input, output);

  const receivedMessages = [];
  const waiters = [];

  const rl = createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    receivedMessages.push(msg);

    for (let i = waiters.length - 1; i >= 0; i--) {
      const { predicate, resolve, timer } = waiters[i];
      if (predicate(msg)) {
        waiters.splice(i, 1);
        clearTimeout(timer);
        resolve(msg);
      }
    }
  });

  function waitForMessage(predicate, timeoutMs = 2000) {
    const existing = receivedMessages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`Timeout esperando mensaje JSON-RPC tras ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  }

  function send(msg) {
    input.write(`${JSON.stringify(msg)}\n`);
  }

  function close() {
    rl.close();
    input.end();
    output.end();
  }

  return {
    server,
    client,
    db,
    odoo,
    send,
    waitForMessage,
    receivedMessages,
    close,
  };
}

test("1. initialize con protocolVersion '2025-11-25' y capabilities.elicitation {} -> herramientas actualizadas", async () => {
  const harness = setupServerHarness();
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: {} },
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    const initRes = await harness.waitForMessage((m) => m.id === 1);
    assert.equal(initRes.result.protocolVersion, "2025-11-25");
    assert.equal(initRes.result.serverInfo.version, "0.3.0");

    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const listRes = await harness.waitForMessage((m) => m.id === 2);
    const toolNames = listRes.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("consultar_estado_accion"));
    assert.ok(!toolNames.includes("confirmar_accion_critica"));
  } finally {
    harness.close();
  }
});

test("2. tools/call confirmar_orden_venta con resIds -> elicitation/create y confirmación exitosa en Odoo", async () => {
  const harness = setupServerHarness();
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: {} },
      },
    });
    await harness.waitForMessage((m) => m.id === 1);

    harness.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "confirmar_orden_venta",
        arguments: { resIds: [11, 12] },
      },
    });

    const elicitationMsg = await harness.waitForMessage((m) => m.method === "elicitation/create");
    assert.equal(typeof elicitationMsg.id, "string");
    assert.match(elicitationMsg.id, /^srv-\d+$/);
    assert.ok(elicitationMsg.params.message.includes("SO-0011"));
    assert.ok(elicitationMsg.params.message.includes("SO-0012"));

    const schema = elicitationMsg.params.requestedSchema;
    assert.deepEqual(schema.properties.decision.enum, ["confirmar", "cancelar", "modificar"]);
    assert.equal(schema.properties.decision.default, undefined);

    const jsonStr = JSON.stringify(elicitationMsg);
    assert.ok(!jsonStr.includes("confirmation_code"));

    // Responder afirmativamente la elicitation
    harness.send({
      jsonrpc: "2.0",
      id: elicitationMsg.id,
      result: {
        action: "accept",
        content: { decision: "confirmar" },
      },
    });

    const callRes = await harness.waitForMessage((m) => m.id === 10);
    assert.equal(callRes.result.isError, false);
    const contentText = callRes.result.content[0].text;
    const resultObj = JSON.parse(contentText);
    assert.equal(resultObj.status, "completed");

    const confirmCalls = harness.odoo.calls.filter(
      (c) => c.model === "sale.order" && c.method === "action_confirm"
    );
    assert.equal(confirmCalls.length, 2);

    for (const msg of harness.receivedMessages) {
      assert.ok(!JSON.stringify(msg).includes("confirmation_code"));
    }
  } finally {
    harness.close();
  }
});

test("3. tools/call con respuesta decline -> status cancelled y 0 llamadas a action_confirm", async () => {
  const harness = setupServerHarness();
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: {} },
      },
    });
    await harness.waitForMessage((m) => m.id === 1);

    harness.send({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "confirmar_orden_venta",
        arguments: { resIds: [11, 12] },
      },
    });

    const elicitationMsg = await harness.waitForMessage((m) => m.method === "elicitation/create");

    harness.send({
      jsonrpc: "2.0",
      id: elicitationMsg.id,
      result: { action: "decline" },
    });

    const callRes = await harness.waitForMessage((m) => m.id === 20);
    assert.equal(callRes.result.isError, false);
    const resultObj = JSON.parse(callRes.result.content[0].text);
    assert.equal(resultObj.status, "cancelled");

    const confirmCalls = harness.odoo.calls.filter(
      (c) => c.model === "sale.order" && c.method === "action_confirm"
    );
    assert.equal(confirmCalls.length, 0);
  } finally {
    harness.close();
  }
});

test("4. tools/call con decisión modificar -> status modification_requested y 0 llamadas", async () => {
  const harness = setupServerHarness();
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: {} },
      },
    });
    await harness.waitForMessage((m) => m.id === 1);

    harness.send({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "confirmar_orden_venta",
        arguments: { resIds: [11, 12] },
      },
    });

    const elicitationMsg = await harness.waitForMessage((m) => m.method === "elicitation/create");

    harness.send({
      jsonrpc: "2.0",
      id: elicitationMsg.id,
      result: {
        action: "accept",
        content: { decision: "modificar", cambios: "solo la 11" },
      },
    });

    const callRes = await harness.waitForMessage((m) => m.id === 30);
    assert.equal(callRes.result.isError, false);
    const resultObj = JSON.parse(callRes.result.content[0].text);
    assert.equal(resultObj.status, "modification_requested");
    assert.equal(resultObj.cambios, "solo la 11");

    const confirmCalls = harness.odoo.calls.filter(
      (c) => c.model === "sale.order" && c.method === "action_confirm"
    );
    assert.equal(confirmCalls.length, 0);
  } finally {
    harness.close();
  }
});

test("5. Timeout en elicitation -> status cancelled y 0 llamadas", async () => {
  const harness = setupServerHarness({ elicitationTimeoutMs: 50 });
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: {} },
      },
    });
    await harness.waitForMessage((m) => m.id === 1);

    harness.send({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "confirmar_orden_venta",
        arguments: { resIds: [11] },
      },
    });

    await harness.waitForMessage((m) => m.method === "elicitation/create");
    // No respondemos -> timeout

    const callRes = await harness.waitForMessage((m) => m.id === 40);
    assert.equal(callRes.result.isError, false);
    const resultObj = JSON.parse(callRes.result.content[0].text);
    assert.equal(resultObj.status, "cancelled");

    const confirmCalls = harness.odoo.calls.filter(
      (c) => c.model === "sale.order" && c.method === "action_confirm"
    );
    assert.equal(confirmCalls.length, 0);
  } finally {
    harness.close();
  }
});

test("6. initialize con protocolVersion '2024-11-05' sin approvalUser -> isError true mencionando aprobación humana", async () => {
  const harness = setupServerHarness();
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { elicitation: {} },
      },
    });
    const initRes = await harness.waitForMessage((m) => m.id === 1);
    assert.equal(initRes.result.protocolVersion, "2024-11-05");

    harness.send({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "confirmar_orden_venta",
        arguments: { resIds: [11] },
      },
    });

    const callRes = await harness.waitForMessage((m) => m.id === 50);
    assert.equal(callRes.result.isError, true);
    assert.match(callRes.result.content[0].text, /aprobación humana/i);

    const confirmCalls = harness.odoo.calls.filter(
      (c) => c.model === "sale.order" && c.method === "action_confirm"
    );
    assert.equal(confirmCalls.length, 0);
  } finally {
    harness.close();
  }
});

test("7. Sin elicitation pero con approvalUser -> canal telegram sin código y 0 llamadas a action_confirm", async () => {
  const approverId = randomUUID();
  const harness = setupServerHarness({
    approvalUser: { id: approverId, telegram_chat_id: 998877 },
  });
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
      },
    });
    await harness.waitForMessage((m) => m.id === 1);

    harness.send({
      jsonrpc: "2.0",
      id: 60,
      method: "tools/call",
      params: {
        name: "confirmar_orden_venta",
        arguments: { resIds: [11] },
      },
    });

    const callRes = await harness.waitForMessage((m) => m.id === 60);
    // Ya sea que devuelva awaiting_approval o error por no tener bot token configurado en mock db
    const text = callRes.result.content[0].text;
    assert.ok(
      text.includes("awaiting_approval") ||
      text.includes("No hay canal de Telegram configurado") ||
      text.includes("approval_channel_unavailable")
    );
    assert.ok(!text.includes("confirmation_code"));

    const confirmCalls = harness.odoo.calls.filter(
      (c) => c.model === "sale.order" && c.method === "action_confirm"
    );
    assert.equal(confirmCalls.length, 0);
  } finally {
    harness.close();
  }
});

test("8. Respuesta con id desconocido ('srv-999') no produce salida", async () => {
  const harness = setupServerHarness();
  try {
    const initialCount = harness.receivedMessages.length;
    harness.send({
      jsonrpc: "2.0",
      id: "srv-999",
      result: { ok: true },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(harness.receivedMessages.length, initialCount);

    // Comprobar que sigue respondiendo normalmente
    harness.send({
      jsonrpc: "2.0",
      id: 999,
      method: "ping",
    });
    const pingRes = await harness.waitForMessage((m) => m.id === 999);
    assert.deepEqual(pingRes.result, {});
  } finally {
    harness.close();
  }
});

test("9. notifications/cancelled con requestId del tools/call pendiente -> termina cancelled y 0 llamadas", async () => {
  const harness = setupServerHarness();
  try {
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: {} },
      },
    });
    await harness.waitForMessage((m) => m.id === 1);

    harness.send({
      jsonrpc: "2.0",
      id: 70,
      method: "tools/call",
      params: {
        name: "confirmar_orden_venta",
        arguments: { resIds: [11] },
      },
    });

    await harness.waitForMessage((m) => m.method === "elicitation/create");

    // Enviar notificación de cancelación del tools/call con requestId 70
    harness.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 70 },
    });

    const callRes = await harness.waitForMessage((m) => m.id === 70);
    assert.equal(callRes.result.isError, false);
    const resultObj = JSON.parse(callRes.result.content[0].text);
    assert.equal(resultObj.status, "cancelled");

    const confirmCalls = harness.odoo.calls.filter(
      (c) => c.model === "sale.order" && c.method === "action_confirm"
    );
    assert.equal(confirmCalls.length, 0);
  } finally {
    harness.close();
  }
});

test("10. consultar_estado_accion devuelve texto si no hay db o el estado de la solicitud", async () => {
  const serverNoDb = new McpServer({
    odoo: {},
    client: { id: randomUUID(), slug: "demo" },
    db: null,
    config: {},
  });
  const resNoDb = await serverNoDb.handleMessage({
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: {
      name: "consultar_estado_accion",
      arguments: { actionId: randomUUID() },
    },
  });
  assert.equal(resNoDb.result.content[0].text, "Requiere la base de datos de control.");

  const harness = setupServerHarness();
  try {
    const actionId = randomUUID();
    harness.db.pendingActions.set(actionId, {
      id: actionId,
      status: "pending",
      preview: { actionName: "confirmar_orden_venta" },
      result: null,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });

    harness.send({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "consultar_estado_accion",
        arguments: { actionId },
      },
    });

    const callRes = await harness.waitForMessage((m) => m.id === 102);
    assert.equal(callRes.result.isError, false);
    const parsed = JSON.parse(callRes.result.content[0].text);
    assert.equal(parsed.actionId, actionId);
    assert.equal(parsed.status, "pending");
  } finally {
    harness.close();
  }
});
