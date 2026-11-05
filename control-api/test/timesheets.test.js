import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, LOCAL_WRITE_ALLOWED } from "../src/mcp-server.js";
import { createJsonlAuditor } from "../src/local-audit.js";
import {
  buildTimesheetValues,
  listMyTimesheets,
  localIsoDate,
  normalizeTimesheetLines,
  prepareTimesheetRegistration,
  resolveCurrentUid,
} from "../src/timesheets.js";

const UID = 7;
const NOW = () => new Date("2026-11-04T20:00:00Z"); // 15:00 en Bogotá

function findTerm(domain, field, op) {
  return domain.find((d) => Array.isArray(d) && d[0] === field && (!op || d[1] === op));
}

function createMockOdoo({ existing = [] } = {}) {
  const projects = [
    { id: 10, name: "Andina Técnica", allow_timesheets: true, partner_id: [100, "Andina Técnica SAS"] },
    { id: 20, name: "Rodatech", allow_timesheets: true, partner_id: [200, "Rodatech"] },
    { id: 30, name: "Proyecto sin horas", allow_timesheets: false, partner_id: false },
  ];
  const tasks = [
    { id: 101, name: "Pruebas integrales", project_id: [10, "Andina Técnica"], stage_id: [1, "En curso"] },
    { id: 201, name: "Go live", project_id: [20, "Rodatech"], stage_id: [1, "En curso"] },
  ];
  const lines = existing.map((l) => ({ ...l }));
  let nextId = 5000;
  const created = [];
  const reads = [];

  return {
    created,
    reads,
    lines,
    async authenticateLegacy() {
      return UID;
    },
    async searchRead(model, domain, fields, options = {}) {
      reads.push({ model, domain, fields, options });
      if (model === "project.project") {
        const idIn = findTerm(domain, "id", "in");
        const idEq = findTerm(domain, "id", "=");
        let rows = projects;
        if (idIn) rows = rows.filter((p) => idIn[2].includes(p.id));
        if (idEq) rows = rows.filter((p) => p.id === idEq[2]);
        if (findTerm(domain, "allow_timesheets")) rows = rows.filter((p) => p.allow_timesheets);
        return rows.map((p) => ({ ...p }));
      }
      if (model === "project.task") {
        const idIn = findTerm(domain, "id", "in");
        const proj = findTerm(domain, "project_id", "=");
        let rows = tasks;
        if (idIn) rows = rows.filter((t) => idIn[2].includes(t.id));
        if (proj) rows = rows.filter((t) => t.project_id[0] === proj[2]);
        return rows.map((t) => ({ ...t }));
      }
      if (model === "account.analytic.line") {
        const from = findTerm(domain, "date", ">=")[2];
        const to = findTerm(domain, "date", "<=")[2];
        assert.deepEqual(findTerm(domain, "employee_id.user_id"), ["employee_id.user_id", "=", UID]);
        return lines.filter((l) => l.date >= from && l.date <= to).map((l) => ({ ...l }));
      }
      throw new Error(`modelo inesperado ${model}`);
    },
    async create(model, values, context) {
      created.push({ model, values, context });
      const id = ++nextId;
      lines.push({
        id,
        date: values.date,
        project_id: [values.project_id, "x"],
        task_id: values.task_id ? [values.task_id, "y"] : false,
        name: values.name,
        unit_amount: values.unit_amount,
      });
      return id;
    },
  };
}

const LINE_A = { fecha: "2026-11-03", proyecto_id: 10, tarea_id: 101, horas: 1.5, descripcion: "Empalme consultoría" };
const LINE_B = { fecha: "2026-11-03", proyecto_id: 20, tarea_id: 201, horas: 2, descripcion: "GO LIVE" };

// ---------- Unidades ----------

test("buildTimesheetValues mapea los campos de account.analytic.line sin employee_id", () => {
  const [line] = normalizeTimesheetLines([LINE_A], { now: NOW() });
  assert.deepEqual(buildTimesheetValues(line), {
    project_id: 10,
    task_id: 101,
    date: "2026-11-03",
    unit_amount: 1.5,
    name: "Empalme consultoría",
  });
  const [noTask] = normalizeTimesheetLines([{ ...LINE_A, tarea_id: undefined }], { now: NOW() });
  assert.equal("task_id" in buildTimesheetValues(noTask), false);
  assert.equal("employee_id" in buildTimesheetValues(line), false);
});

test("localIsoDate usa la zona de Bogotá", () => {
  assert.equal(localIsoDate(new Date("2026-11-05T03:00:00Z"), "America/Bogota"), "2026-11-04");
});

test("normalizeTimesheetLines rechaza fecha futura, horas <= 0, fecha inválida y descripción vacía", () => {
  const opts = { now: NOW() };
  assert.throws(() => normalizeTimesheetLines([{ ...LINE_A, fecha: "2026-11-05" }], opts), /fechas futuras/);
  assert.throws(() => normalizeTimesheetLines([{ ...LINE_A, horas: 0 }], opts), /mayores que 0/);
  assert.throws(() => normalizeTimesheetLines([{ ...LINE_A, horas: -1 }], opts), /mayores que 0/);
  assert.throws(() => normalizeTimesheetLines([{ ...LINE_A, fecha: "2026-02-30" }], opts), /fecha inválida/);
  assert.throws(() => normalizeTimesheetLines([{ ...LINE_A, descripcion: "   " }], opts), /descripción/);
  assert.throws(() => normalizeTimesheetLines([], opts), /al menos una línea/);
  // Hoy sí se permite
  assert.equal(normalizeTimesheetLines([{ ...LINE_A, fecha: "2026-11-04" }], opts).length, 1);
});

test("prepare omite líneas ya registradas (misma fecha, tarea y descripción, sin importar mayúsculas/espacios) y duplicadas en el lote", async () => {
  const odoo = createMockOdoo({
    existing: [
      { id: 900, date: "2026-11-03", project_id: [10, "Andina"], task_id: [101, "Pruebas"], name: "  empalme   CONSULTORÍA ", unit_amount: 1.5 },
    ],
  });
  const prep = await prepareTimesheetRegistration(odoo, [LINE_A, LINE_B, { ...LINE_B }], { uid: UID, now: NOW() });
  assert.equal(prep.toCreate.length, 1);
  assert.equal(prep.toCreate[0].projectId, 20);
  assert.deepEqual(prep.skipped.map((s) => s.motivo), ["ya_registrada", "duplicada_en_lote"]);
  assert.equal(prep.skipped[0].odoo_id, 900);
});

test("prepare rechaza superar 12 h en un día contando lo ya registrado", async () => {
  const odoo = createMockOdoo({
    existing: [{ id: 1, date: "2026-11-03", project_id: [10, "A"], task_id: false, name: "Otra cosa", unit_amount: 11 }],
  });
  await assert.rejects(
    prepareTimesheetRegistration(odoo, [LINE_A], { uid: UID, now: NOW() }),
    /quedaría con 12.5 h/,
  );
});

test("prepare valida proyecto con horas y coherencia tarea/proyecto", async () => {
  const odoo = createMockOdoo();
  await assert.rejects(
    prepareTimesheetRegistration(odoo, [{ ...LINE_A, proyecto_id: 30, tarea_id: undefined }], { uid: UID, now: NOW() }),
    /no admite partes de horas/,
  );
  await assert.rejects(
    prepareTimesheetRegistration(odoo, [{ ...LINE_A, tarea_id: 201 }], { uid: UID, now: NOW() }),
    /no pertenece al proyecto/,
  );
  await assert.rejects(
    prepareTimesheetRegistration(odoo, [{ ...LINE_A, proyecto_id: 99, tarea_id: undefined }], { uid: UID, now: NOW() }),
    /no existe/,
  );
});

test("listMyTimesheets filtra por el empleado del usuario y totaliza por día", async () => {
  const odoo = createMockOdoo({
    existing: [
      { id: 1, date: "2026-11-03", project_id: [10, "Andina"], task_id: [101, "Pruebas"], name: "a", unit_amount: 1.5 },
      { id: 2, date: "2026-11-03", project_id: [20, "Rodatech"], task_id: false, name: "b", unit_amount: 2 },
      { id: 3, date: "2026-11-04", project_id: [20, "Rodatech"], task_id: false, name: "c", unit_amount: 3 },
      { id: 4, date: "2026-10-30", project_id: [20, "Rodatech"], task_id: false, name: "fuera", unit_amount: 8 },
    ],
  });
  const res = await listMyTimesheets(odoo, { uid: UID, desde: "2026-11-02", hasta: "2026-11-06" });
  assert.equal(res.total_horas, 6.5);
  assert.deepEqual(res.horas_por_dia, { "2026-11-03": 3.5, "2026-11-04": 3 });
  assert.equal(res.lineas[0].proyecto, "Andina");
  await assert.rejects(listMyTimesheets(odoo, { uid: UID, desde: "2026-11-06", hasta: "2026-11-02" }), /posterior/);
});

test("resolveCurrentUid usa la autenticación heredada o busca por login en JSON-2", async () => {
  assert.equal(await resolveCurrentUid({ adapter: { authenticateLegacy: async () => 42 } }, null), 42);
  const json2 = {
    adapter: {},
    async searchRead(model, domain) {
      assert.equal(model, "res.users");
      assert.deepEqual(domain, [["login", "=", "jorge@x.co"]]);
      return [{ id: 9 }];
    },
  };
  assert.equal(await resolveCurrentUid(json2, "jorge@x.co"), 9);
  await assert.rejects(resolveCurrentUid({ adapter: {} }, null), /ODOO_LOGIN/);
});

// ---------- Servidor MCP en modo carpeta local ----------

function localServer(opts = {}) {
  return new McpServer({
    odoo: opts.odoo ?? createMockOdoo(),
    client: { slug: "pragmatic-prod" },
    db: null,
    config: {},
    linkedUser: { odoo_login: "jorge@pragmatic.com.co" },
    localWriteTools: opts.localWriteTools ?? [],
    auditor: opts.auditor ?? null,
    now: NOW,
    elicitationTimeoutMs: 2000,
  });
}

async function listToolNames(server) {
  const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return res.result.tools.map((t) => t.name);
}

function callTool(server, name, args, id = 5) {
  return server.handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

function parse(res) {
  return JSON.parse(res.result.content[0].text);
}

test("modo local sin local_write_tools: registrar_horas no aparece y se rechaza", async () => {
  const odoo = createMockOdoo();
  const server = localServer({ odoo });
  const names = await listToolNames(server);
  assert.ok(names.includes("consultar_mis_horas"));
  assert.ok(names.includes("consultar_mis_proyectos_tareas"));
  assert.equal(names.includes("registrar_horas"), false);

  const res = await callTool(server, "registrar_horas", { lineas: [LINE_A] });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /base de datos de control/);
  assert.equal(odoo.created.length, 0);
});

test("modo local: local_write_tools solo habilita lo permitido por el código", async () => {
  assert.deepEqual([...LOCAL_WRITE_ALLOWED], ["registrar_horas"]);
  const odoo = createMockOdoo();
  const server = localServer({ odoo, localWriteTools: ["registrar_horas", "confirmar_orden_venta", "crear_borrador_factura_cliente"] });
  const names = await listToolNames(server);
  assert.ok(names.includes("registrar_horas"));
  assert.equal(names.includes("confirmar_orden_venta"), false);

  const res = await callTool(server, "confirmar_orden_venta", { resId: 1 });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /base de datos de control/);
});

test("modo BD: registrar_horas no se ofrece", async () => {
  const server = new McpServer({ odoo: {}, client: { id: "c1", slug: "demo" }, db: {}, config: {}, localWriteTools: ["registrar_horas"] });
  const names = await listToolNames(server);
  assert.equal(names.includes("registrar_horas"), false);
  assert.ok(names.includes("confirmar_orden_venta"));
});

test("token APLICAR: sin aprobación no escribe; con el token correcto escribe una vez; queda auditado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ts-audit-"));
  try {
    const odoo = createMockOdoo();
    const auditor = createJsonlAuditor(dir, { now: NOW });
    const server = localServer({ odoo, auditor, localWriteTools: ["registrar_horas"] });

    const step1 = parse(await callTool(server, "registrar_horas", { lineas: [LINE_A, LINE_B] }));
    assert.equal(step1.status, "awaiting_confirmation");
    assert.match(step1.action_id, /^[A-F0-9]{6}$/);
    assert.match(step1.summary, /Andina Técnica \/ Pruebas integrales \| 1.5 h/);
    assert.equal(odoo.created.length, 0);

    // Token inválido o de otra solicitud
    let res = await callTool(server, "registrar_horas", { lineas: [LINE_A, LINE_B], confirmacion: "APLICAR 000000" });
    assert.equal(res.result.isError, true);
    res = await callTool(server, "registrar_horas", { lineas: [LINE_A, LINE_B], confirmacion: "sí, dale" });
    assert.equal(res.result.isError, true);
    // Líneas distintas a las aprobadas
    res = await callTool(server, "registrar_horas", { lineas: [{ ...LINE_A, horas: 8 }, LINE_B], confirmacion: `APLICAR ${step1.action_id}` });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /no coinciden/);
    assert.equal(odoo.created.length, 0);

    const step2 = parse(await callTool(server, "registrar_horas", { lineas: [LINE_A, LINE_B], confirmacion: `APLICAR ${step1.action_id.toLowerCase()}` }));
    assert.equal(step2.success, true);
    assert.equal(step2.creadas.length, 2);
    assert.equal(odoo.created.length, 2);
    assert.deepEqual(odoo.created[0], {
      model: "account.analytic.line",
      values: { project_id: 10, task_id: 101, date: "2026-11-03", unit_amount: 1.5, name: "Empalme consultoría" },
      context: { tracking_source: "ai_agent", mail_create_nosubscribe: true },
    });

    // El token es de un solo uso
    res = await callTool(server, "registrar_horas", { lineas: [LINE_A, LINE_B], confirmacion: `APLICAR ${step1.action_id}` });
    assert.equal(res.result.isError, true);

    // Repetir la solicitud: todo se omite por idempotencia, sin pedir aprobación
    const again = parse(await callTool(server, "registrar_horas", { lineas: [LINE_A, LINE_B] }));
    assert.equal(again.status, "nothing_to_do");
    assert.equal(again.omitidas.length, 2);
    assert.equal(odoo.created.length, 2);

    const audit = (await readFile(join(dir, "auditoria", "acciones.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a) => a.etapa), ["preparada", "aprobada", "ejecutada", "preparada"]);
    assert.equal(audit[2].creadas.length, 2);
    assert.equal(audit[2].usuario, "jorge@pragmatic.com.co");
    const raw = JSON.stringify(audit);
    assert.equal(/api[_-]?key/i.test(raw), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function stdioHarness(server) {
  const input = new PassThrough();
  const output = new PassThrough();
  server.startStdio(input, output);
  const received = [];
  const waiters = [];
  const rl = createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    send: (msg) => input.write(`${JSON.stringify(msg)}\n`),
    wait(predicate, ms = 2000) {
      const found = received.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), ms);
        waiters.push({ predicate, resolve, timer });
      });
    },
    close() {
      rl.close();
      input.end();
      output.end();
    },
  };
}

async function initWithElicitation(h) {
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: { elicitation: {} } } });
  await h.wait((m) => m.id === 1);
}

test("elicitation: confirmar registra las horas", async () => {
  const odoo = createMockOdoo();
  const events = [];
  const server = localServer({ odoo, localWriteTools: ["registrar_horas"], auditor: { record: async (e) => events.push(e) } });
  const h = stdioHarness(server);
  try {
    await initWithElicitation(h);
    h.send({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "registrar_horas", arguments: { lineas: [LINE_A] } } });
    const ask = await h.wait((m) => m.method === "elicitation/create");
    assert.match(ask.params.message, /Empalme consultoría/);
    assert.deepEqual(ask.params.requestedSchema.properties.decision.enum, ["confirmar", "cancelar"]);
    assert.equal(odoo.created.length, 0);

    h.send({ jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: { decision: "confirmar" } } });
    const done = await h.wait((m) => m.id === 20);
    const body = JSON.parse(done.result.content[0].text);
    assert.equal(body.success, true);
    assert.equal(odoo.created.length, 1);
    assert.deepEqual(events.map((e) => [e.etapa, e.via]), [["preparada", undefined], ["aprobada", "mcp_elicitation"], ["ejecutada", "mcp_elicitation"]]);
  } finally {
    h.close();
  }
});

test("elicitation: rechazar o cancelar no escribe nada", async () => {
  for (const reply of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { decision: "cancelar" } }]) {
    const odoo = createMockOdoo();
    const server = localServer({ odoo, localWriteTools: ["registrar_horas"] });
    const h = stdioHarness(server);
    try {
      await initWithElicitation(h);
      h.send({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "registrar_horas", arguments: { lineas: [LINE_A] } } });
      const ask = await h.wait((m) => m.method === "elicitation/create");
      h.send({ jsonrpc: "2.0", id: ask.id, result: reply });
      const done = await h.wait((m) => m.id === 30);
      assert.equal(JSON.parse(done.result.content[0].text).status, "cancelled");
      assert.equal(odoo.created.length, 0);
    } finally {
      h.close();
    }
  }
});
