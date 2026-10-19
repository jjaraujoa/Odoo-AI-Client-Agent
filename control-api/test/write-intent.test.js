import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.js";
import {
  WRITE_ACTIONS,
  WRITE_INTENT_SCHEMA,
  looksLikeWriteRequest,
  extractDocumentNumbers,
  previousDocumentNumbers,
  resolveWriteTargets,
  handleWriteRequest,
} from "../src/write-intent.js";
import { processApprovalCallback } from "../src/approval-telegram.js";
import { decideApproval } from "../src/approvals.js";

test("looksLikeWriteRequest reconoce verbos imperativos e ignora consultas y lecturas", () => {
  // Casos true
  assert.equal(looksLikeWriteRequest("confirma la S00012"), true);
  assert.equal(looksLikeWriteRequest("Valida el albarán WH/OUT/00005"), true);
  assert.equal(looksLikeWriteRequest("cancela esas dos"), true);
  assert.equal(looksLikeWriteRequest("anula la factura INV/2026/00012"), true);
  assert.equal(looksLikeWriteRequest("CONFIRMA las órdenes S00012 y S00013"), true);
  assert.equal(looksLikeWriteRequest("cancelemos el albarán"), true);

  // Casos false
  assert.equal(looksLikeWriteRequest("¿qué órdenes están canceladas?"), false);
  assert.equal(looksLikeWriteRequest("muéstrame las confirmadas"), false);
  assert.equal(looksLikeWriteRequest("dame las últimas 2 órdenes"), false);
  assert.equal(looksLikeWriteRequest("órdenes confirmadas hoy"), false);
  assert.equal(looksLikeWriteRequest(""), false);
  assert.equal(looksLikeWriteRequest(null), false);
  assert.equal(looksLikeWriteRequest(undefined), false);
});

test("extractDocumentNumbers extrae números de documentos Odoo sin duplicados y con límite", () => {
  const text = "Por favor confirma la orden S00012, también S00012, el albarán WH/OUT/00005 y la factura INV/2026/00012 junto con P00045";
  const numbers = extractDocumentNumbers(text);
  assert.deepEqual(numbers, ["S00012", "WH/OUT/00005", "INV/2026/00012", "P00045"]);

  assert.deepEqual(extractDocumentNumbers("sin números aquí"), []);
  assert.deepEqual(extractDocumentNumbers(null), []);
});

test("previousDocumentNumbers obtiene los números de la entrada más reciente con records", () => {
  const memory = [
    {
      role: "assistant",
      kind: "summary",
      content: { records: [{ number: "S00001" }, { number: "S00002" }] },
    },
    {
      role: "user",
      kind: "message",
      content: { text: "¿cuáles eran?" },
    },
    {
      role: "assistant",
      kind: "summary",
      content: { records: [{ number: "S00010" }, { number: "S00011" }, { number: "S00010" }] },
    },
    {
      role: "assistant",
      kind: "message",
      content: { text: "Aquí tienes los detalles" },
    },
  ];

  const nums = previousDocumentNumbers(memory);
  // Debe tomar la entrada más reciente (S00010, S00011) deduplicada
  assert.deepEqual(nums, ["S00010", "S00011"]);

  assert.deepEqual(previousDocumentNumbers([]), []);
  assert.deepEqual(previousDocumentNumbers(null), []);
});

test("resolveWriteTargets busca en Odoo y conserva el orden de documentNumbers", async () => {
  const mockOdoo = {
    searchRead: async (model, domain, fields, options) => {
      assert.equal(model, "sale.order");
      assert.deepEqual(domain, [["name", "in", ["S00012", "S00013", "S00099"]]]);
      return [
        { id: 13, name: "S00013" },
        { id: 12, name: "S00012" },
      ];
    },
  };

  const result = await resolveWriteTargets({
    odoo: mockOdoo,
    actionName: "confirmar_orden_venta",
    documentNumbers: ["S00012", "S00013", "S00099"],
  });

  assert.deepEqual(result.resIds, [12, 13]);
  assert.deepEqual(result.missing, ["S00099"]);
  assert.equal(result.found.length, 2);

  const empty = await resolveWriteTargets({
    odoo: mockOdoo,
    actionName: "confirmar_orden_venta",
    documentNumbers: [],
  });
  assert.deepEqual(empty, { resIds: [], found: [], missing: [] });
});

test("handleWriteRequest: texto de lectura devuelve null y no llama classify", async () => {
  let classifyCalled = false;
  const result = await handleWriteRequest({
    db: {},
    config: {},
    providers: {},
    identity: { id: "user-1", client_id: "client-1" },
    session: { id: "sess-1" },
    odoo: {},
    text: "¿qué órdenes están confirmadas?",
    memory: [],
    chatId: 12345,
    deps: {
      classify: async () => {
        classifyCalled = true;
      },
    },
  });

  assert.equal(result, null);
  assert.equal(classifyCalled, false);
});

test("handleWriteRequest: classify devuelve action 'none' → devuelve null", async () => {
  let requestCalled = false;
  const result = await handleWriteRequest({
    db: {},
    config: {},
    providers: {},
    identity: { id: "user-1", client_id: "client-1" },
    session: { id: "sess-1" },
    odoo: {},
    text: "cancela si es posible pero primero dime cuáles hay",
    memory: [],
    chatId: 12345,
    deps: {
      classify: async () => ({
        data: {
          action: "none",
          document_numbers: [],
          use_previous_results: false,
          needs_clarification: false,
          clarification: null,
        },
        model: { id: "m1" },
        usage: { input: 10, output: 5 },
      }),
      request: async () => {
        requestCalled = true;
      },
    },
  });

  assert.equal(result, null);
  assert.equal(requestCalled, false);
});

test("handleWriteRequest: needs_clarification devuelve texto de aclaración", async () => {
  const result = await handleWriteRequest({
    db: {},
    config: {},
    providers: {},
    identity: { id: "user-1", client_id: "client-1" },
    session: { id: "sess-1" },
    odoo: {},
    text: "confirma por favor",
    memory: [],
    chatId: 12345,
    deps: {
      classify: async () => ({
        data: {
          action: "confirmar_orden_venta",
          document_numbers: [],
          use_previous_results: false,
          needs_clarification: true,
          clarification: "¿Qué órdenes deseas confirmar?",
        },
        model: { id: "m1" },
        usage: { input: 10, output: 5 },
      }),
    },
  });

  assert.equal(result.eventType, "write_clarification");
  assert.equal(result.text, "¿Qué órdenes deseas confirmar?");
});

test("handleWriteRequest: confirmar dos órdenes llama request una sola vez con los parámetros requeridos", async () => {
  let requestArgs = null;
  let requestCallCount = 0;

  const identity = {
    id: "user-uuid-1",
    client_id: "client-uuid-1",
    client_settings: { env: "prod" },
    odoo_base_url: "https://odoo.example.com",
  };

  const result = await handleWriteRequest({
    db: { name: "db" },
    config: { name: "config" },
    providers: {},
    identity,
    session: { id: "sess-1" },
    odoo: { name: "odoo" },
    text: "confirma las órdenes S00012 y S00013",
    memory: [],
    chatId: 98765,
    deps: {
      classify: async () => ({
        data: {
          action: "confirmar_orden_venta",
          document_numbers: ["S00012", "S00013"],
          use_previous_results: false,
          needs_clarification: false,
          clarification: null,
        },
        model: { id: "gpt-model" },
        usage: { input: 15, output: 8 },
      }),
      resolve: async ({ actionName, documentNumbers }) => {
        assert.equal(actionName, "confirmar_orden_venta");
        assert.deepEqual(documentNumbers, ["S00012", "S00013"]);
        return {
          resIds: [11, 12],
          found: [{ id: 11, name: "S00012" }, { id: 12, name: "S00013" }],
          missing: [],
        };
      },
      request: async (args) => {
        requestCallCount += 1;
        requestArgs = args;
        return {
          status: "awaiting_approval",
          action_id: "act-1",
          excluded: [],
        };
      },
    },
  });

  assert.equal(requestCallCount, 1);
  assert.equal(requestArgs.actionName, "confirmar_orden_venta");
  assert.deepEqual(requestArgs.params, { resIds: [11, 12] });
  assert.equal(requestArgs.approvalChannel, "telegram");
  assert.deepEqual(requestArgs.approver, { id: "user-uuid-1", telegram_chat_id: 98765 });
  assert.equal(requestArgs.telegramChatId, 98765);
  assert.deepEqual(requestArgs.linkedUser, { id: "user-uuid-1" });
  assert.deepEqual(requestArgs.client, {
    id: "client-uuid-1",
    settings: { env: "prod" },
    odoo_base_url: "https://odoo.example.com",
  });

  assert.equal(result.eventType, "write_approval_requested");
  assert.equal(result.toolName, "confirmar_orden_venta");
  assert.deepEqual(result.recordIds, [11, 12]);
  assert.equal(result.text, "Te envié el resumen para aprobar con los botones.");
  assert.deepEqual(result.model, { id: "gpt-model" });
  assert.deepEqual(result.usage, { input: 15, output: 8 });
});

test("handleWriteRequest: un documento inexistente aparece en 'No encontré' y los demás siguen", async () => {
  let capturedResIds = null;

  const result = await handleWriteRequest({
    db: {},
    config: {},
    providers: {},
    identity: { id: "u1", client_id: "c1" },
    session: { id: "s1" },
    odoo: {},
    text: "confirma S00012 y S00099",
    memory: [],
    chatId: 100,
    deps: {
      classify: async () => ({
        data: {
          action: "confirmar_orden_venta",
          document_numbers: ["S00012", "S00099"],
          use_previous_results: false,
          needs_clarification: false,
          clarification: null,
        },
        model: { id: "m" },
        usage: {},
      }),
      resolve: async () => ({
        resIds: [11],
        found: [{ id: 11, name: "S00012" }],
        missing: ["S00099"],
      }),
      request: async (args) => {
        capturedResIds = args.params.resIds;
        return {
          status: "awaiting_approval",
          excluded: [{ resId: 999, reason: "invalid_state" }],
        };
      },
    },
  });

  assert.deepEqual(capturedResIds, [11]);
  assert.ok(result.text.includes("Te envié el resumen para aprobar con los botones."));
  assert.ok(result.text.includes("No encontré: S00099."));
  assert.ok(result.text.includes("Excluidos por estado: #999."));
  assert.equal(result.eventType, "write_approval_requested");
});

test("handleWriteRequest: todos inexistentes devuelve write_not_found sin llamar request", async () => {
  let requestCalled = false;

  const result = await handleWriteRequest({
    db: {},
    config: {},
    providers: {},
    identity: { id: "u1", client_id: "c1" },
    session: { id: "s1" },
    odoo: {},
    text: "cancela S00998 y S00999",
    memory: [],
    chatId: 100,
    deps: {
      classify: async () => ({
        data: {
          action: "cancelar_orden_venta",
          document_numbers: ["S00998", "S00999"],
          use_previous_results: false,
          needs_clarification: false,
          clarification: null,
        },
        model: { id: "m" },
        usage: {},
      }),
      resolve: async () => ({
        resIds: [],
        found: [],
        missing: ["S00998", "S00999"],
      }),
      request: async () => {
        requestCalled = true;
      },
    },
  });

  assert.equal(requestCalled, false);
  assert.equal(result.eventType, "write_not_found");
  assert.equal(result.text, "No encontré estos documentos: S00998, S00999.");
});

test("handleWriteRequest: use_previous_results toma los números de la memoria", async () => {
  let resolvedNumbers = null;

  const memory = [
    {
      role: "assistant",
      kind: "summary",
      content: {
        records: [
          { id: 21, number: "S00021" },
          { id: 22, number: "S00022" },
        ],
      },
    },
  ];

  const result = await handleWriteRequest({
    db: {},
    config: {},
    providers: {},
    identity: { id: "u1", client_id: "c1" },
    session: { id: "s1" },
    odoo: {},
    text: "cancela esas dos",
    memory,
    chatId: 100,
    deps: {
      classify: async () => ({
        data: {
          action: "cancelar_orden_venta",
          document_numbers: [],
          use_previous_results: true,
          needs_clarification: false,
          clarification: null,
        },
        model: { id: "m" },
        usage: {},
      }),
      resolve: async ({ documentNumbers }) => {
        resolvedNumbers = documentNumbers;
        return {
          resIds: [21, 22],
          found: [{ id: 21, name: "S00021" }, { id: 22, name: "S00022" }],
          missing: [],
        };
      },
      request: async () => ({
        status: "awaiting_approval",
        excluded: [],
      }),
    },
  });

  assert.deepEqual(resolvedNumbers, ["S00021", "S00022"]);
  assert.equal(result.eventType, "write_approval_requested");
  assert.deepEqual(result.recordIds, [21, 22]);
});

test("handleWriteRequest: ejecuta directo cuando política no es awaiting_approval", async () => {
  const result = await handleWriteRequest({
    db: {},
    config: {},
    providers: {},
    identity: { id: "u1", client_id: "c1" },
    session: { id: "s1" },
    odoo: {},
    text: "confirma la S00012",
    memory: [],
    chatId: 100,
    deps: {
      classify: async () => ({
        data: {
          action: "confirmar_orden_venta",
          document_numbers: ["S00012"],
          use_previous_results: false,
          needs_clarification: false,
          clarification: null,
        },
        model: { id: "m" },
        usage: {},
      }),
      resolve: async () => ({
        resIds: [12],
        found: [{ id: 12, name: "S00012" }],
        missing: [],
      }),
      request: async () => ({
        status: "executed",
        result: { summary: "Orden S00012 confirmada automáticamente." },
      }),
    },
  });

  assert.equal(result.eventType, "write_executed");
  assert.equal(result.text, "Orden S00012 confirmada automáticamente.");
});

test("handleWriteRequest: error si hay más de 50 documentos", async () => {
  const fiftyOne = Array.from({ length: 51 }, (_, i) => `S${String(i + 1000).padStart(5, "0")}`);
  await assert.rejects(
    () =>
      handleWriteRequest({
        db: {},
        config: {},
        providers: {},
        identity: { id: "u1", client_id: "c1" },
        session: { id: "s1" },
        odoo: {},
        text: "confirma todas",
        memory: [],
        chatId: 100,
        deps: {
          classify: async () => ({
            data: {
              action: "confirmar_orden_venta",
              document_numbers: fiftyOne,
              use_previous_results: false,
              needs_clarification: false,
              clarification: null,
            },
          }),
        },
      }),
    {
      name: "AppError",
      code: "too_many_items",
      status: 400,
    },
  );
});

test("processApprovalCallback modify con deps.remember se llama con modification_requested y records", async () => {
  const actionHex = "d0000000000040008000000000000004";
  const expectedActionId = "d0000000-0000-4000-8000-000000000004";

  let rememberArgs = null;
  const remember = async (role, kind, content) => {
    rememberArgs = { role, kind, content };
  };

  const parsed = {
    chatId: 555,
    messageId: 666,
    callbackId: "cb-mod-1",
    text: `ap:m:${actionHex}`,
  };

  const outcome = await processApprovalCallback({
    db: {},
    odoo: {},
    identity: { id: "user-1", client_id: "client-1" },
    parsed,
    botToken: "test-bot-token",
    session: { id: "session-1" },
    deps: {
      answer: async () => true,
      edit: async () => true,
      decide: async () => ({
        status: "modification_requested",
        actionId: expectedActionId,
        actionName: "confirmar_orden_venta",
        records: [
          { id: 101, number: "S00012" },
          { id: 102, number: "S00013" },
        ],
      }),
      remember,
    },
  });

  assert.equal(outcome.eventType, "operational_approval_modify");
  assert.ok(outcome.text.includes("✏️ Solicitud cancelada para modificarla"));
  assert.notEqual(rememberArgs, null);
  assert.equal(rememberArgs.role, "assistant");
  assert.equal(rememberArgs.kind, "summary");
  assert.deepEqual(rememberArgs.content, {
    modification_requested: true,
    action: "confirmar_orden_venta",
    records: [
      { id: 101, number: "S00012" },
      { id: 102, number: "S00013" },
    ],
  });
});

test("decideApproval en cancel/modify devuelve actionName y records parseados", async () => {
  const mockDb = {
    query: async (sql, params) => {
      return {
        rows: [
          {
            id: "a0000000-0000-4000-8000-000000000005",
            preview: JSON.stringify({ actionName: "validar_albaran_entrega" }),
            items: JSON.stringify([
              { resId: 301, display: { name: "WH/OUT/00005" } },
              { resId: 302, display: { name: "WH/OUT/00006" } },
            ]),
          },
        ],
      };
    },
  };

  const res = await decideApproval({
    db: mockDb,
    odoo: {},
    clientId: "c1",
    actionId: "a0000000-0000-4000-8000-000000000005",
    decision: "modify",
    deciderLinkedUserId: "u1",
    via: "telegram",
    note: "cambiar cantidades",
  });

  assert.equal(res.status, "modification_requested");
  assert.equal(res.actionName, "validar_albaran_entrega");
  assert.deepEqual(res.records, [
    { id: 301, number: "WH/OUT/00005" },
    { id: 302, number: "WH/OUT/00006" },
  ]);
  assert.equal(res.note, "cambiar cantidades");
});
