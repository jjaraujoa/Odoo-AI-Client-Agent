import test from "node:test";
import assert from "node:assert/strict";
import { requestOrExecuteAction } from "../src/governance.js";
import {
  buildApprovalKeyboard,
  parseApprovalCallback,
} from "../src/approval-telegram.js";

function createMockDb({ onPendingInsert = null } = {}) {
  return {
    async query(sql, params) {
      if (sql.includes("FROM agent.tool_policies")) {
        return {
          rows: [
            {
              tool_name: params[1],
              risk_level: 3,
              confirmation_required: true,
              enabled: true,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO agent.pending_actions")) {
        if (onPendingInsert) {
          onPendingInsert(params);
        }
        return { rows: [{ id: "b0000000-0000-4000-8000-000000000001" }] };
      }
      if (sql.includes("INSERT INTO agent.action_executions")) {
        return { rows: [{ id: "exec-1" }] };
      }
      if (sql.includes("FROM agent.channel_credentials")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function createMockOdoo({ calls = [] } = {}) {
  return {
    async call(model, method, body) {
      calls.push({ model, method, body });
      return true;
    },
    async create(model, values) {
      calls.push({ model, values });
      return [{ id: 999 }];
    },
    async write(model, id, vals) {
      calls.push({ model, id, vals });
      return true;
    },
    async searchRead(model, domain, fields) {
      return [
        {
          id: 101,
          name: "SO-101",
          state: "draft",
          amount_total: 150000,
          partner_id: [1, "Cliente de Prueba"],
          write_date: "2026-10-18 12:00:00",
        },
      ];
    },
  };
}

test("requestOrExecuteAction nivel 3 sin approvalChannel rechaza con approval_channel_unavailable y Odoo.call nunca se invoca", async () => {
  const odooCalls = [];
  const mockOdoo = createMockOdoo({ calls: odooCalls });
  const mockDb = createMockDb();
  const client = {
    id: "a0000000-0000-4000-8000-000000000001",
    odoo_base_url: "https://odoo.local",
    settings: {},
  };
  const config = { credentialMasterKey: Buffer.alloc(32, 1) };

  await assert.rejects(
    () =>
      requestOrExecuteAction({
        db: mockDb,
        config,
        client,
        actionName: "confirmar_orden_venta",
        params: { resId: 101 },
        odoo: mockOdoo,
        approvalChannel: null,
      }),
    {
      code: "approval_channel_unavailable",
    },
  );

  assert.equal(odooCalls.length, 0);
});

test("nivel 3 con approvalChannel 'admin': status awaiting_approval, tiene action_id, y no contiene confirmation_code ni el valor capturado", async () => {
  let capturedConfirmationCode = null;
  const mockDb = createMockDb({
    onPendingInsert(params) {
      // En agent.pending_actions, $8 es confirmation_code (índice 7)
      capturedConfirmationCode = params[7];
    },
  });
  const mockOdoo = createMockOdoo();
  const client = {
    id: "a0000000-0000-4000-8000-000000000001",
    odoo_base_url: "https://odoo.local",
    settings: {},
  };
  const config = { credentialMasterKey: Buffer.alloc(32, 1) };

  const res = await requestOrExecuteAction({
    db: mockDb,
    config,
    client,
    actionName: "confirmar_orden_venta",
    params: { resId: 101 },
    odoo: mockOdoo,
    approvalChannel: "admin",
  });

  assert.equal(res.status, "awaiting_approval");
  assert.equal(res.action_id, "b0000000-0000-4000-8000-000000000001");
  assert.ok(capturedConfirmationCode, "Debe haber generado y persistido un confirmation_code en la BD");

  const resJson = JSON.stringify(res);
  assert.equal(res.confirmation_code, undefined);
  assert.equal(resJson.includes("confirmation_code"), false);
  assert.equal(resJson.includes(capturedConfirmationCode), false);
});

test("nivel 3 con approvalChannel 'telegram' sin approver rechaza con approval_channel_unavailable", async () => {
  const mockDb = createMockDb();
  const mockOdoo = createMockOdoo();
  const client = {
    id: "a0000000-0000-4000-8000-000000000001",
    odoo_base_url: "https://odoo.local",
    settings: {},
  };
  const config = { credentialMasterKey: Buffer.alloc(32, 1) };

  // Sin approver
  await assert.rejects(
    () =>
      requestOrExecuteAction({
        db: mockDb,
        config,
        client,
        actionName: "confirmar_orden_venta",
        params: { resId: 101 },
        odoo: mockOdoo,
        approvalChannel: "telegram",
        approver: null,
      }),
    {
      code: "approval_channel_unavailable",
    },
  );

  // Approver incompleto (falta telegram_chat_id)
  await assert.rejects(
    () =>
      requestOrExecuteAction({
        db: mockDb,
        config,
        client,
        actionName: "confirmar_orden_venta",
        params: { resId: 101 },
        odoo: mockOdoo,
        approvalChannel: "telegram",
        approver: { id: "user-1" },
      }),
    {
      code: "approval_channel_unavailable",
    },
  );
});

test("staging bypass NO se aplica si client.id no es UUID aunque settings.environment = 'staging'", async () => {
  const odooCalls = [];
  const mockOdoo = createMockOdoo({ calls: odooCalls });
  const mockDb = createMockDb();
  const client = {
    id: "client-1",
    odoo_base_url: "https://odoo.local",
    settings: { environment: "staging" },
  };
  const config = { credentialMasterKey: Buffer.alloc(32, 1) };

  const res = await requestOrExecuteAction({
    db: mockDb,
    config,
    client,
    actionName: "confirmar_orden_venta",
    params: { resId: 101 },
    odoo: mockOdoo,
    approvalChannel: "admin",
  });

  // Debe devolver awaiting_approval con approvalChannel "admin" en vez de ejecutar
  assert.equal(res.status, "awaiting_approval");
  assert.equal(res.staging_bypass, undefined);
  assert.equal(odooCalls.length, 0, "No debe haber invocado odoo.call para ejecutar la acción");
});

test("buildApprovalKeyboard: 3 botones, cada callback_data <= 64 bytes; parseApprovalCallback ida y vuelta devuelve el mismo UUID", () => {
  const actionUuid = "d0000000-1111-4000-8000-222222222222";
  const keyboard = buildApprovalKeyboard(actionUuid);

  assert.ok(keyboard.inline_keyboard);
  assert.equal(keyboard.inline_keyboard.length, 1);
  const buttons = keyboard.inline_keyboard[0];
  assert.equal(buttons.length, 3);

  const expectedDecisions = ["confirm", "cancel", "modify"];

  for (let i = 0; i < buttons.length; i += 1) {
    const btn = buttons[i];
    assert.ok(btn.text);
    assert.ok(btn.callback_data);

    // Garantizar que cada callback_data <= 64 bytes (requisito de Telegram Bot API)
    const byteLength = Buffer.byteLength(btn.callback_data, "utf8");
    assert.ok(
      byteLength <= 64,
      `callback_data '${btn.callback_data}' supera los 64 bytes (tiene ${byteLength})`,
    );

    // parseApprovalCallback ida y vuelta devuelve el mismo UUID
    const parsed = parseApprovalCallback(btn.callback_data);
    assert.ok(parsed, `parseApprovalCallback falló para ${btn.callback_data}`);
    assert.equal(parsed.actionId, actionUuid);
    assert.equal(parsed.decision, expectedDecisions[i]);
  }
});
