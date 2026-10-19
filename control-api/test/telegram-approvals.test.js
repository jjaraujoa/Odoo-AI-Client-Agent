import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.js";
import {
  isApprovalCallback,
  processApprovalCallback,
} from "../src/approval-telegram.js";

test("isApprovalCallback identifica correctamente si es un callback de aprobación", () => {
  // Casos true
  assert.equal(isApprovalCallback({ callbackId: "cb1", text: "ap:c:0123456789abcdef0123456789abcdef" }), true);
  assert.equal(isApprovalCallback({ callbackId: "cb2", text: "ap:x:0123456789abcdef0123456789abcdef" }), true);
  assert.equal(isApprovalCallback({ callbackId: "cb3", text: "ap:m:0123456789abcdef0123456789abcdef" }), true);
  assert.equal(isApprovalCallback({ callbackId: "cb4", text: "ap:anything" }), true);

  // Casos false
  assert.equal(isApprovalCallback(null), false);
  assert.equal(isApprovalCallback(undefined), false);
  assert.equal(isApprovalCallback({}), false);
  assert.equal(isApprovalCallback({ text: "ap:c:0123456789abcdef0123456789abcdef" }), false);
  assert.equal(isApprovalCallback({ callbackId: "cb1" }), false);
  assert.equal(isApprovalCallback({ callbackId: "cb1", text: null }), false);
  assert.equal(isApprovalCallback({ callbackId: "cb1", text: "vb:c:123456" }), false);
  assert.equal(isApprovalCallback({ callbackId: "cb1", text: "/confirmar" }), false);
});

test("processApprovalCallback confirm: llama answer antes de decide, llama decide con parámetros correctos, llama edit, borra callbackId y formatea resultado", async () => {
  const callSequence = [];
  const actionHex = "a0000000000040008000000000000001";
  const expectedActionId = "a0000000-0000-4000-8000-000000000001";

  const answer = async (botToken, callbackQueryId, text) => {
    callSequence.push({ fn: "answer", botToken, callbackQueryId, text });
    return true;
  };

  let capturedDecideArgs = null;
  const decide = async (args) => {
    callSequence.push({ fn: "decide", ...args });
    capturedDecideArgs = args;
    return {
      status: "completed",
      actionId: expectedActionId,
      actionName: "confirmar_orden_venta",
      summaryText: "1 ejecutadas, 0 omitidas (cambiaron desde la aprobación), 0 fallidas",
      results: [
        { resId: 101, status: "executed", summary: "SO confirmada" },
      ],
    };
  };

  const editCalls = [];
  const edit = async (botToken, opts) => {
    callSequence.push({ fn: "edit", botToken, opts });
    editCalls.push({ botToken, opts });
    return true;
  };

  const parsed = {
    chatId: 12345,
    messageId: 6789,
    callbackId: "cb-query-999",
    text: `ap:c:${actionHex}`,
  };

  const identity = {
    id: "user-uuid-1",
    client_id: "client-uuid-1",
  };

  const outcome = await processApprovalCallback({
    db: {},
    odoo: {},
    identity,
    parsed,
    botToken: "test-bot-token",
    deps: { decide, edit, answer },
  });

  // 1. llama answer una vez antes de decide
  assert.equal(callSequence[0].fn, "answer");
  assert.equal(callSequence[0].botToken, "test-bot-token");
  assert.equal(callSequence[0].callbackQueryId, "cb-query-999");
  assert.equal(callSequence[0].text, "Procesando…");
  assert.equal(callSequence[1].fn, "decide");

  // 2. llama decide con clientId=identity.client_id y deciderLinkedUserId=identity.id y decision "confirm"
  assert.equal(capturedDecideArgs.clientId, "client-uuid-1");
  assert.equal(capturedDecideArgs.deciderLinkedUserId, "user-uuid-1");
  assert.equal(capturedDecideArgs.decision, "confirm");
  assert.equal(capturedDecideArgs.actionId, expectedActionId);
  assert.equal(capturedDecideArgs.via, "telegram");

  // 3. llama edit
  assert.equal(callSequence[2].fn, "edit");
  assert.equal(editCalls.length, 1);
  assert.deepEqual(editCalls[0].opts, { chatId: 12345, messageId: 6789 });

  // 4. deja parsed.callbackId undefined
  assert.equal(parsed.callbackId, undefined);

  // 5. texto contiene "✅ Aprobado"
  assert.ok(outcome.text.includes("✅ Aprobado."));
  assert.ok(outcome.text.includes("• #101: ejecutada"));
  assert.equal(outcome.eventType, "operational_approval");
  assert.equal(outcome.toolName, "confirmar_orden_venta");
  assert.deepEqual(outcome.recordIds, [101]);
});

test("processApprovalCallback cancel y modify devuelven los textos correctos", async () => {
  const actionHex = "b0000000000040008000000000000002";
  const identity = { id: "user-1", client_id: "client-1" };

  // Cancel
  const parsedCancel = {
    chatId: 10,
    messageId: 20,
    callbackId: "cb-cancel",
    text: `ap:x:${actionHex}`,
  };
  let decideDecision = null;
  const outcomeCancel = await processApprovalCallback({
    db: {},
    odoo: {},
    identity,
    parsed: parsedCancel,
    botToken: "bot-token",
    deps: {
      answer: async () => {},
      decide: async (args) => {
        decideDecision = args.decision;
        return { status: "cancelled" };
      },
      edit: async () => {},
    },
  });
  assert.equal(decideDecision, "cancel");
  assert.equal(outcomeCancel.text, "❌ Solicitud cancelada. No se ejecutó nada.");
  assert.equal(outcomeCancel.eventType, "operational_approval_cancel");
  assert.equal(parsedCancel.callbackId, undefined);

  // Modify
  const parsedModify = {
    chatId: 10,
    messageId: 20,
    callbackId: "cb-modify",
    text: `ap:m:${actionHex}`,
  };
  const outcomeModify = await processApprovalCallback({
    db: {},
    odoo: {},
    identity,
    parsed: parsedModify,
    botToken: "bot-token",
    deps: {
      answer: async () => {},
      decide: async (args) => {
        decideDecision = args.decision;
        return { status: "modification_requested" };
      },
      edit: async () => {},
    },
  });
  assert.equal(decideDecision, "modify");
  assert.equal(
    outcomeModify.text,
    "✏️ Solicitud cancelada para modificarla. Escribe qué quieres cambiar y se preparará una nueva solicitud.",
  );
  assert.equal(outcomeModify.eventType, "operational_approval_modify");
  assert.equal(parsedModify.callbackId, undefined);
});

test("processApprovalCallback: si decide lanza AppError 404 → edit se llama igualmente y el error se propaga", async () => {
  const actionHex = "c0000000000040008000000000000003";
  let editCalled = false;
  let answerCalled = false;

  const parsed = {
    chatId: 100,
    messageId: 200,
    callbackId: "cb-err",
    text: `ap:c:${actionHex}`,
  };

  await assert.rejects(
    () =>
      processApprovalCallback({
        db: {},
        odoo: {},
        identity: { id: "u1", client_id: "c1" },
        parsed,
        botToken: "bot-token",
        deps: {
          answer: async () => {
            answerCalled = true;
          },
          decide: async () => {
            throw new AppError(404, "approval_not_found", "La solicitud no existe.");
          },
          edit: async (token, opts) => {
            editCalled = true;
            assert.deepEqual(opts, { chatId: 100, messageId: 200 });
          },
        },
      }),
    {
      name: "AppError",
      code: "approval_not_found",
      status: 404,
    },
  );

  assert.equal(answerCalled, true);
  assert.equal(editCalled, true);
  assert.equal(parsed.callbackId, undefined);
});

test("processApprovalCallback: callback inválido ('ap:z:123') lanza invalid_callback y no llama decide", async () => {
  let decideCalled = false;
  let answerCalled = false;

  const parsed = {
    chatId: 100,
    messageId: 200,
    callbackId: "cb-inv",
    text: "ap:z:123",
  };

  await assert.rejects(
    () =>
      processApprovalCallback({
        db: {},
        odoo: {},
        identity: { id: "u1", client_id: "c1" },
        parsed,
        botToken: "bot-token",
        deps: {
          answer: async () => {
            answerCalled = true;
          },
          decide: async () => {
            decideCalled = true;
          },
          edit: async () => {},
        },
      }),
    {
      code: "invalid_callback",
      status: 400,
    },
  );

  assert.equal(answerCalled, false);
  assert.equal(decideCalled, false);
});
