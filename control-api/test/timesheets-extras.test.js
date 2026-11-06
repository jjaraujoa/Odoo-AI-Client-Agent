import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTimesheetValues,
  detectTimesheetExtras,
  listActivityTypes,
  listMyTickets,
  listMyTimesheets,
  listTimesheetProjectsTasks,
  prepareTimesheetRegistration,
  summarizePreparation,
} from "../src/timesheets.js";

const UID = 251;
const NOW = new Date("2026-11-06T20:00:00Z");

const PRG_FIELDS = {
  activity_type_id: { type: "many2one", relation: "project_e10s.activity_type" },
  prg_ticket_id: { type: "many2one", relation: "helpdesk.ticket" },
  x_studio_ticket_id: { type: "many2one", relation: "helpdesk.ticket" },
  helpdesk_ticket_id: { type: "many2one", relation: "helpdesk.ticket" },
};

function mockOdoo({ fields = PRG_FIELDS, lines = [] } = {}) {
  const reads = [];
  const created = [];
  return {
    reads,
    created,
    async call(model, method) {
      assert.equal(model, "account.analytic.line");
      assert.equal(method, "fields_get");
      return fields;
    },
    async searchRead(model, domain, fieldNames, options = {}) {
      reads.push({ model, domain, fieldNames, options });
      if (model === "project.project") return [{ id: 999, name: "Rodatech-Implementación", allow_timesheets: true, is_favorite: true }];
      if (model === "project.task") return [{ id: 32303, name: "Go Live", project_id: [999, "Rodatech-Implementación"] }];
      if (model === "project_e10s.activity_type") {
        return [{ id: 2, name: "Reunión con cliente" }, { id: 23, name: "Reunión Interna" }, { id: 65, name: "Capacitación interna" }]
          .filter((r) => !domain.length || domain[0][2].includes(r.id));
      }
      if (model === "helpdesk.ticket") {
        return [{ id: 20278, name: "HATOVIEJO - Horas de consultoría", partner_id: false, project_id: [719, "Consultoría <10 H"], team_id: [5, "Consultoría"], stage_id: [2, "Asignado"] }];
      }
      if (model === "account.analytic.line") return lines.filter((l) => !fieldNames.includes("prg_ticket_id") || l.prg_ticket_id);
      throw new Error(`modelo inesperado ${model}`);
    },
    async create(model, values) {
      created.push({ model, values });
      return 1;
    },
  };
}

const LINE = { fecha: "2026-11-05", proyecto_id: 999, tarea_id: 32303, horas: 1, descripcion: "Rodatech – seguimiento" };

test("detectTimesheetExtras prefiere prg_ticket_id + x_studio_ticket_id y detecta el tipo de actividad", async () => {
  assert.deepEqual(await detectTimesheetExtras(mockOdoo()), {
    activityModel: "project_e10s.activity_type",
    ticketFields: ["prg_ticket_id", "x_studio_ticket_id"],
  });
  assert.deepEqual(await detectTimesheetExtras(mockOdoo({ fields: { helpdesk_ticket_id: PRG_FIELDS.helpdesk_ticket_id } })), {
    activityModel: null,
    ticketFields: ["helpdesk_ticket_id"],
  });
  const failing = { async call() { throw new Error("sin permiso"); } };
  assert.deepEqual(await detectTimesheetExtras(failing), { activityModel: null, ticketFields: [] });
});

test("con tipo de actividad en la base, es obligatorio y debe existir", async () => {
  await assert.rejects(prepareTimesheetRegistration(mockOdoo(), [LINE], { uid: UID, now: NOW }), /tipo_actividad_id es obligatorio/);
  await assert.rejects(
    prepareTimesheetRegistration(mockOdoo(), [{ ...LINE, tipo_actividad_id: 9999 }], { uid: UID, now: NOW }),
    /tipo de actividad 9999 no existe/,
  );
  // Base sin el campo: no se exige y se rechaza si se envía
  const plain = mockOdoo({ fields: {} });
  assert.equal((await prepareTimesheetRegistration(plain, [LINE], { uid: UID, now: NOW })).toCreate.length, 1);
  await assert.rejects(prepareTimesheetRegistration(plain, [{ ...LINE, tipo_actividad_id: 2 }], { uid: UID, now: NOW }), /no tiene tipo de actividad/);
});

test("los valores enviados incluyen activity_type_id y ambos campos de ticket; el resumen los muestra", async () => {
  const odoo = mockOdoo();
  const prep = await prepareTimesheetRegistration(odoo, [{ ...LINE, tipo_actividad_id: 2, ticket_id: 20278 }], { uid: UID, now: NOW });
  assert.deepEqual(buildTimesheetValues(prep.toCreate[0], prep.extras), {
    project_id: 999,
    task_id: 32303,
    date: "2026-11-05",
    unit_amount: 1,
    name: "Rodatech – seguimiento",
    activity_type_id: 2,
    prg_ticket_id: 20278,
    x_studio_ticket_id: 20278,
  });
  const summary = summarizePreparation(prep);
  assert.match(summary, /tipo: Reunión con cliente/);
  assert.match(summary, /ticket: HATOVIEJO - Horas de consultoría/);
});

test("listMyTickets filtra por asignado y abiertos, y propone el último proyecto/tarea usado", async () => {
  const odoo = mockOdoo({
    lines: [
      { date: "2026-10-07", project_id: [1025, "HATOVIEJO - Horas"], task_id: [32589, "Bolsa de 5 horas"], prg_ticket_id: [20278, "HATOVIEJO"], activity_type_id: [9, "Consultoría Odoo"] },
      { date: "2026-09-01", project_id: [1, "viejo"], task_id: false, prg_ticket_id: [20278, "HATOVIEJO"], activity_type_id: false },
    ],
  });
  const res = await listMyTickets(odoo, { uid: UID, query: "hato" }, await detectTimesheetExtras(odoo));
  const ticketRead = odoo.reads.find((r) => r.model === "helpdesk.ticket");
  assert.deepEqual(ticketRead.domain.slice(0, 2), [["user_id", "=", UID], ["stage_id.fold", "=", false]]);
  assert.equal(res.tickets[0].id, 20278);
  assert.deepEqual(res.tickets[0].ultimo_registro, {
    fecha: "2026-10-07",
    proyecto_id: 1025,
    proyecto: "HATOVIEJO - Horas",
    tarea_id: 32589,
    tarea: "Bolsa de 5 horas",
    tipo_actividad_id: 9,
    tipo_actividad: "Consultoría Odoo",
  });
  assert.equal((await listMyTickets(odoo, { uid: UID }, { activityModel: null, ticketFields: [] })).disponible, false);
});

test("listActivityTypes y listMyTimesheets exponen el tipo de actividad", async () => {
  const odoo = mockOdoo({
    lines: [{ id: 1, date: "2026-11-03", project_id: [999, "Rodatech"], task_id: [32303, "Go Live"], name: "x", unit_amount: 2, activity_type_id: [2, "Reunión con cliente"], prg_ticket_id: false }],
  });
  const extras = await detectTimesheetExtras(odoo);
  const tipos = await listActivityTypes(odoo, extras);
  assert.equal(tipos.obligatorio, true);
  assert.ok(tipos.tipos.some((t) => t.nombre === "Reunión Interna"));
  const horas = await listMyTimesheets(mockOdoo({ lines: [{ id: 1, date: "2026-11-03", project_id: [999, "Rodatech"], task_id: [32303, "Go Live"], name: "x", unit_amount: 2, activity_type_id: [2, "Reunión con cliente"], prg_ticket_id: false }] }), { uid: UID, desde: "2026-11-03", hasta: "2026-11-03" }, { activityModel: "project_e10s.activity_type", ticketFields: [] });
  assert.equal(horas.lineas[0].tipo_actividad, "Reunión con cliente");
});

test("solo_favoritos filtra proyectos y tareas por is_favorite; la búsqueda incluye el cliente", async () => {
  const odoo = mockOdoo();
  await listTimesheetProjectsTasks(odoo, { solo_favoritos: true, query: "rodatech" });
  const proj = odoo.reads.find((r) => r.model === "project.project");
  assert.deepEqual(proj.domain, [["allow_timesheets", "=", true], ["is_favorite", "=", true], "|", ["name", "ilike", "rodatech"], ["partner_id.name", "ilike", "rodatech"]]);
  const task = odoo.reads.find((r) => r.model === "project.task");
  assert.ok(task.domain.some((d) => Array.isArray(d) && d[0] === "project_id.is_favorite"));
});
