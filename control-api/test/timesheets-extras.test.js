import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTimesheetValues,
  listActivityTypes,
  listMyTickets,
  listMyTimesheets,
  listTimesheetProjectsTasks,
  normalizeTimesheetConfig,
  prepareTimesheetRegistration,
  resolveTimesheetExtras,
  summarizePreparation,
} from "../src/timesheets.js";

// Datos ficticios. Los campos x_* simulan personalizaciones propias de una base cualquiera.
const UID = 7;
const NOW = new Date("2026-11-06T20:00:00Z");

const FIELDS = {
  x_activity_type_id: { type: "many2one", relation: "x_activity.type" },
  x_ticket_id: { type: "many2one", relation: "helpdesk.ticket" },
  x_ticket_copy_id: { type: "many2one", relation: "helpdesk.ticket" },
  helpdesk_ticket_id: { type: "many2one", relation: "helpdesk.ticket" },
  x_note: { type: "char" },
};

const CONFIG = normalizeTimesheetConfig({
  campo_tipo_actividad: "x_activity_type_id",
  tipo_actividad_obligatorio: true,
  campos_ticket: ["x_ticket_id", "x_ticket_copy_id"],
});

function mockOdoo({ fields = FIELDS, lines = [] } = {}) {
  const reads = [];
  return {
    reads,
    async call(model, method, body) {
      assert.equal(model, "account.analytic.line");
      assert.equal(method, "fields_get");
      return Object.fromEntries(Object.entries(fields).filter(([k]) => body.allfields.includes(k)));
    },
    async searchRead(model, domain, fieldNames, options = {}) {
      reads.push({ model, domain, fieldNames, options });
      if (model === "project.project") return [{ id: 10, name: "Acme - Implementación", allow_timesheets: true, is_favorite: true }];
      if (model === "project.task") return [{ id: 101, name: "Go Live", project_id: [10, "Acme - Implementación"] }];
      if (model === "x_activity.type") {
        return [{ id: 1, display_name: "Reunión con cliente" }, { id: 2, display_name: "Reunión interna" }]
          .filter((r) => !domain.length || domain[0][2].includes(r.id));
      }
      if (model === "helpdesk.ticket") {
        return [{ id: 500, name: "Globex - Bolsa de horas", partner_id: [3, "Globex"], project_id: [20, "Soporte"], team_id: [5, "Soporte"], stage_id: [2, "Asignado"] }];
      }
      if (model === "account.analytic.line") return lines;
      throw new Error(`modelo inesperado ${model}`);
    },
    async create() {
      return 1;
    },
  };
}

const LINE = { fecha: "2026-11-05", proyecto_id: 10, tarea_id: 101, horas: 1, descripcion: "Acme – seguimiento" };

test("normalizeTimesheetConfig valida nombres de campo y coherencia", () => {
  assert.deepEqual(normalizeTimesheetConfig(null), {});
  assert.deepEqual(CONFIG, { activityField: "x_activity_type_id", activityRequired: true, ticketFields: ["x_ticket_id", "x_ticket_copy_id"] });
  assert.throws(() => normalizeTimesheetConfig({ campo_tipo_actividad: "x; drop" }), /nombre de campo válido/);
  assert.throws(() => normalizeTimesheetConfig({ tipo_actividad_obligatorio: true }), /requiere campo_tipo_actividad/);
  assert.throws(() => normalizeTimesheetConfig({ campos_ticket: ["ok_id", "Mal"] }), /campos_ticket/);
  assert.throws(() => normalizeTimesheetConfig([]), /objeto/);
});

test("sin configuración: sin tipo de actividad y ticket por el campo nativo", async () => {
  const extras = await resolveTimesheetExtras(mockOdoo(), {});
  assert.deepEqual(extras, { activity: null, ticketFields: ["helpdesk_ticket_id"] });
  const sinHelpdesk = await resolveTimesheetExtras(mockOdoo({ fields: {} }), {});
  assert.deepEqual(sinHelpdesk, { activity: null, ticketFields: [] });
  // Una línea sin tipo se acepta y una con tipo se rechaza
  assert.equal((await prepareTimesheetRegistration(mockOdoo(), [LINE], { uid: UID, now: NOW })).toCreate.length, 1);
  await assert.rejects(prepareTimesheetRegistration(mockOdoo(), [{ ...LINE, tipo_actividad_id: 1 }], { uid: UID, now: NOW }), /No hay un campo de tipo de actividad configurado/);
});

test("con configuración: campos inexistentes o de otro tipo son un error explícito", async () => {
  await assert.rejects(resolveTimesheetExtras(mockOdoo(), normalizeTimesheetConfig({ campo_tipo_actividad: "x_note" })), /no existe o no es many2one/);
  await assert.rejects(resolveTimesheetExtras(mockOdoo(), normalizeTimesheetConfig({ campos_ticket: ["x_activity_type_id"] })), /Campos de ticket inválidos/);
});

test("tipo de actividad obligatorio y validado cuando la configuración lo exige", async () => {
  await assert.rejects(prepareTimesheetRegistration(mockOdoo(), [LINE], { uid: UID, now: NOW, config: CONFIG }), /tipo_actividad_id es obligatorio/);
  await assert.rejects(
    prepareTimesheetRegistration(mockOdoo(), [{ ...LINE, tipo_actividad_id: 99 }], { uid: UID, now: NOW, config: CONFIG }),
    /tipo de actividad 99 no existe/,
  );
  const opcional = normalizeTimesheetConfig({ campo_tipo_actividad: "x_activity_type_id" });
  assert.equal((await prepareTimesheetRegistration(mockOdoo(), [LINE], { uid: UID, now: NOW, config: opcional })).toCreate.length, 1);
});

test("los valores enviados usan los campos configurados; el resumen muestra tipo y ticket", async () => {
  const prep = await prepareTimesheetRegistration(mockOdoo(), [{ ...LINE, tipo_actividad_id: 1, ticket_id: 500 }], { uid: UID, now: NOW, config: CONFIG });
  assert.deepEqual(buildTimesheetValues(prep.toCreate[0], prep.extras), {
    project_id: 10,
    task_id: 101,
    date: "2026-11-05",
    unit_amount: 1,
    name: "Acme – seguimiento",
    x_activity_type_id: 1,
    x_ticket_id: 500,
    x_ticket_copy_id: 500,
  });
  const summary = summarizePreparation(prep);
  assert.match(summary, /tipo: Reunión con cliente/);
  assert.match(summary, /ticket: Globex - Bolsa de horas/);
});

test("listMyTickets filtra asignados y abiertos y propone el último proyecto/tarea usado", async () => {
  const odoo = mockOdoo({
    lines: [
      { date: "2026-10-07", project_id: [30, "Globex - Bolsa"], task_id: [301, "Bolsa de horas"], x_ticket_id: [500, "Globex"], x_activity_type_id: [2, "Reunión interna"] },
      { date: "2026-09-01", project_id: [1, "viejo"], task_id: false, x_ticket_id: [500, "Globex"], x_activity_type_id: false },
    ],
  });
  const res = await listMyTickets(odoo, { uid: UID, query: "globex" }, await resolveTimesheetExtras(odoo, CONFIG));
  const ticketRead = odoo.reads.find((r) => r.model === "helpdesk.ticket");
  assert.deepEqual(ticketRead.domain.slice(0, 2), [["user_id", "=", UID], ["stage_id.fold", "=", false]]);
  assert.deepEqual(res.tickets[0].ultimo_registro, {
    fecha: "2026-10-07",
    proyecto_id: 30,
    proyecto: "Globex - Bolsa",
    tarea_id: 301,
    tarea: "Bolsa de horas",
    tipo_actividad_id: 2,
    tipo_actividad: "Reunión interna",
  });
  assert.equal((await listMyTickets(odoo, { uid: UID }, { activity: null, ticketFields: [] })).disponible, false);
});

test("listActivityTypes y listMyTimesheets exponen el tipo de actividad configurado", async () => {
  const odoo = mockOdoo({
    lines: [{ id: 1, date: "2026-11-03", project_id: [10, "Acme"], task_id: [101, "Go Live"], name: "x", unit_amount: 2, x_activity_type_id: [1, "Reunión con cliente"], x_ticket_id: false }],
  });
  const extras = await resolveTimesheetExtras(odoo, CONFIG);
  const tipos = await listActivityTypes(odoo, extras);
  assert.equal(tipos.obligatorio, true);
  assert.deepEqual(tipos.tipos.map((t) => t.nombre), ["Reunión con cliente", "Reunión interna"]);
  assert.equal((await listActivityTypes(odoo, { activity: null, ticketFields: [] })).disponible, false);
  const horas = await listMyTimesheets(odoo, { uid: UID, desde: "2026-11-03", hasta: "2026-11-03" }, extras);
  assert.equal(horas.lineas[0].tipo_actividad, "Reunión con cliente");
});

test("solo_favoritos filtra proyectos y tareas por is_favorite; la búsqueda incluye el cliente", async () => {
  const odoo = mockOdoo();
  await listTimesheetProjectsTasks(odoo, { solo_favoritos: true, query: "acme" });
  const proj = odoo.reads.find((r) => r.model === "project.project");
  assert.deepEqual(proj.domain, [["allow_timesheets", "=", true], ["is_favorite", "=", true], "|", ["name", "ilike", "acme"], ["partner_id.name", "ilike", "acme"]]);
  const task = odoo.reads.find((r) => r.model === "project.task");
  assert.ok(task.domain.some((d) => Array.isArray(d) && d[0] === "project_id.is_favorite"));
});

test("con proyecto_id, query filtra las tareas de ese proyecto por nombre", async () => {
  const odoo = mockOdoo();
  await listTimesheetProjectsTasks(odoo, { proyecto_id: 10, query: "interno" });
  const task = odoo.reads.find((r) => r.model === "project.task");
  assert.deepEqual(task.domain.slice(0, 3), [["project_id.allow_timesheets", "=", true], ["project_id", "=", 10], ["name", "ilike", "interno"]]);
});
