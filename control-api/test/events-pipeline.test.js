import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyEventPriority,
  computeEventFingerprint,
  getModelLabel,
  isLoopEvent,
  processOdooEvent,
} from "../src/events.js";
import {
  buildOdooDeepLink,
  dispatchNotification,
  formatEventNotificationText,
} from "../src/notifications.js";
import { formatDigestMessage, generateOperationalDigest } from "../src/digest.js";
import { OdooJson2Client } from "../src/odoo.js";

test("isLoopEvent detecta cuando el evento fue originado por el bot", () => {
  const client = {
    settings: { bot_service_user_id: 99 },
  };

  assert.equal(isLoopEvent({ write_uid: 99 }, client), true);
  assert.equal(isLoopEvent({ user_id: 99 }, client), true);
  assert.equal(isLoopEvent({ write_uid: "99" }, client), true);
  assert.equal(isLoopEvent({ is_bot_generated: true }, client), true);

  // Usuario humano distinto
  assert.equal(isLoopEvent({ write_uid: 42 }, client), false);
  assert.equal(isLoopEvent({ user_id: 15 }, client), false);
  assert.equal(isLoopEvent({}, client), false);
});

test("computeEventFingerprint genera hash determinista por registro y fecha", () => {
  const hash1 = computeEventFingerprint("client-1", "sale.order", 101, {
    write_date: "2026-09-17 10:00:00",
    fields: { state: "sale", priority: "1" },
  });
  const hash2 = computeEventFingerprint("client-1", "sale.order", 101, {
    write_date: "2026-09-17 10:00:00",
    fields: { state: "sale", priority: "1" },
  });
  const hash3 = computeEventFingerprint("client-1", "sale.order", 101, {
    write_date: "2026-09-17 10:05:00",
    fields: { state: "sale", priority: "1" },
  });

  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
});

test("classifyEventPriority clasifica eventos según urgencia e impacto de negocio", () => {
  // Crítico: Prioridad urgente o flag explícito
  assert.equal(classifyEventPriority("sale.order", { fields: { priority: "1" } }), "critical");
  assert.equal(classifyEventPriority("sale.order", { fields: { priority: 1 } }), "critical");
  assert.equal(classifyEventPriority("purchase.order", { fields: { is_urgent: true } }), "critical");

  // Alto: Picking listo para entrega o venta de alto valor
  assert.equal(classifyEventPriority("stock.picking", { fields: { state: "assigned" } }), "high");
  assert.equal(classifyEventPriority("sale.order", { fields: { amount_total: 15_000_000 } }), "high");

  // Normal: Actualizaciones rutinarias
  assert.equal(classifyEventPriority("sale.order", { fields: { state: "draft", amount_total: 500_000 } }), "normal");
  assert.equal(classifyEventPriority("account.move", { fields: { state: "draft" } }), "normal");
});

test("buildOdooDeepLink construye URLs de formulario válidas", () => {
  const url = buildOdooDeepLink("https://mi-empresa.odoo.com/", "sale.order", 450);
  assert.equal(url, "https://mi-empresa.odoo.com/web#id=450&model=sale.order&view_type=form");
});

test("formatEventNotificationText formatea mensaje estructurado con icono y deep link", () => {
  const text = formatEventNotificationText({
    title: "Orden de venta prioritaria",
    modelLabel: "Orden de venta",
    recordName: "SO-2026-001",
    summary: "Requiere facturación urgente antes de despacho.",
    deepLink: "https://odoo.local/web#id=1&model=sale.order&view_type=form",
    urgency: "critical",
  });

  assert.match(text, /🚨 \*Orden de venta prioritaria\*/);
  assert.match(text, /• \*Registro\*: Orden de venta `SO-2026-001`/);
  assert.match(text, /• \*Detalle\*: Requiere facturación urgente/);
  assert.match(text, /🔗 \[Ver en Odoo\]\(https:\/\/odoo\.local/);
});

test("formatDigestMessage agrupa eventos por modelo y maneja estado vacío", () => {
  // Caso vacío
  const empty = formatDigestMessage({
    clientName: "Empresa Demo",
    role: "ventas",
    events: [],
    baseUrl: "https://odoo.local",
  });
  assert.match(empty, /📋 \*Resumen Operativo: Empresa Demo\*/);
  assert.match(empty, /✅ \*Todo al día\*/);

  // Con eventos agrupados
  const withEvents = formatDigestMessage({
    clientName: "Empresa Demo",
    role: "logistica",
    events: [
      {
        model: "stock.picking",
        res_id: 10,
        payload: { fields: { name: "WH/IN/00010" }, summary: "Camión recibido" },
      },
      {
        model: "stock.picking",
        res_id: 11,
        payload: { fields: { name: "WH/IN/00011" }, summary: "Descarga en muelle 2" },
      },
      {
        model: "sale.order",
        res_id: 55,
        payload: { fields: { name: "SO-55" }, summary: "Pendiente empaque" },
      },
    ],
    baseUrl: "https://odoo.local",
  });

  assert.match(withEvents, /\*Albarán \/ Movimiento de almacén\* \(2\):/);
  assert.match(withEvents, /\[WH\/IN\/00010\]/);
  assert.match(withEvents, /\*Orden de venta\* \(1\):/);
  assert.match(withEvents, /\[SO-55\]/);
});

test("OdooJson2Client postChatterMessage valida argumentos y construye payload", async () => {
  const calls = [];
  const client = new OdooJson2Client({
    baseUrl: "https://odoo.local",
    apiKey: "test-api-key",
  });

  // Mock call
  client.call = async (model, method, body) => {
    calls.push({ model, method, body });
    return [{ id: 777 }];
  };

  const res = await client.postChatterMessage("sale.order", 123, "<p>Nota del agente</p>", {
    partnerIds: [4, 8],
    messageType: "comment",
  });

  assert.deepEqual(res, [{ id: 777 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "mail.message");
  assert.equal(calls[0].method, "create");
  assert.equal(calls[0].body.vals_list[0].model, "sale.order");
  assert.equal(calls[0].body.vals_list[0].res_id, 123);
  assert.equal(calls[0].body.vals_list[0].body, "<p>Nota del agente</p>");
  assert.deepEqual(calls[0].body.vals_list[0].partner_ids, [[6, 0, [4, 8]]]);

  // Error con ID no entero
  await assert.rejects(
    () => client.postChatterMessage("sale.order", "invalido", "Nota"),
    { code: "invalid_res_id" },
  );
});

test("processOdooEvent descarta bucles de bot y duplicados de forma atómica", async () => {
  const eventsTable = [];
  const dedupStore = new Set();

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("FROM agent.clients")) {
        return {
          rows: [{
            id: "11111111-1111-1111-1111-111111111111",
            slug: "cliente-test",
            name: "Cliente Test",
            odoo_base_url: "https://odoo.test",
            active: true,
            settings: { bot_service_user_id: 99, alert_chat_id: 12345 },
          }],
        };
      }
      if (sql.includes("agent.check_and_record_deduplication")) {
        const fingerprint = params[1];
        if (dedupStore.has(fingerprint)) {
          return { rows: [{ fresh: false }] };
        }
        dedupStore.add(fingerprint);
        return { rows: [{ fresh: true }] };
      }
      if (sql.includes("INSERT INTO agent.events")) {
        const id = `event-${eventsTable.length + 1}`;
        eventsTable.push({ id, sql, params });
        return { rows: [{ id }] };
      }
      if (sql.includes("FROM agent.channel_credentials")) {
        return { rows: [] }; // Sin telegram en este mock
      }
      return { rows: [] };
    },
  };

  const config = { credentialMasterKey: Buffer.alloc(32, 1) };

  // 1. Evento con origen de bot -> ignored_loop
  const loopRes = await processOdooEvent({
    db: mockDb,
    config,
    body: {
      client_slug: "cliente-test",
      model: "sale.order",
      res_id: 501,
      write_uid: 99, // Bot user
    },
  });
  assert.equal(loopRes.status, "ignored_loop");
  assert.equal(loopRes.reason, "originated_by_bot");

  // 2. Evento válido primera vez -> processed o pending
  const freshRes = await processOdooEvent({
    db: mockDb,
    config,
    body: {
      client_slug: "cliente-test",
      model: "sale.order",
      res_id: 501,
      write_uid: 2, // Usuario humano
      fields: { priority: "1", name: "SO-501" },
    },
  });
  assert.equal(freshRes.status, "processed");
  assert.equal(freshRes.priority, "critical");

  // 3. Mismo evento repetido inmediatamente -> ignored_duplicate
  const duplicateRes = await processOdooEvent({
    db: mockDb,
    config,
    body: {
      client_slug: "cliente-test",
      model: "sale.order",
      res_id: 501,
      write_uid: 2,
      fields: { priority: "1", name: "SO-501" },
    },
  });
  assert.equal(duplicateRes.status, "ignored_duplicate");
  assert.equal(duplicateRes.reason, "debounce_window");
});
