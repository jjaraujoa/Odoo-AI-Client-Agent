import { AppError } from "./errors.js";
import { relationId, relationName } from "./odoo.js";

// Partes de horas (account.analytic.line con project_id) del propio usuario de la API key.
// Herramientas cerradas: modelos, campos y dominios fijos; el LLM solo aporta filtros acotados.

export const TIMESHEET_MODEL = "account.analytic.line";
export const TIMESHEET_FIELDS = Object.freeze(["id", "date", "project_id", "task_id", "name", "unit_amount"]);
export const DEFAULT_MAX_HOURS_PER_DAY = 12;
export const MAX_LINES_PER_CALL = 50;
export const DEFAULT_TIMEZONE = "America/Bogota";

const TIMESHEET_CONTEXT = Object.freeze({
  tracking_source: "ai_agent",
  mail_create_nosubscribe: true,
});

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const CLOSED_TASK_STATES = ["1_done", "1_canceled"];

function isValidIsoDate(value) {
  if (typeof value !== "string" || !DATE_REGEX.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requireIsoDate(value, field) {
  if (!isValidIsoDate(value)) {
    throw new AppError(400, "invalid_date", `Fecha ${field} inválida: ${value} (formato YYYY-MM-DD).`);
  }
  return value;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function roundHours(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Fecha local (YYYY-MM-DD) en la zona horaria indicada. */
export function localIsoDate(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Descripción normalizada para comparar líneas (idempotencia). */
export function normalizeDescription(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function timesheetKey({ date, projectId, taskId, description }) {
  return [date, projectId || 0, taskId || 0, normalizeDescription(description)].join("|");
}

/**
 * Campos opcionales de la instancia (módulos propios del cliente), detectados con fields_get:
 * - activity_type_id: si existe, el tipo de actividad es OBLIGATORIO en cada línea.
 * - Ticket: prg_ticket_id (+ x_studio_ticket_id, que siempre van juntos) o, si no existen,
 *   el nativo helpdesk_ticket_id.
 */
export async function detectTimesheetExtras(odoo) {
  let fields = {};
  try {
    fields = (await odoo.call(TIMESHEET_MODEL, "fields_get", {
      allfields: ["activity_type_id", "prg_ticket_id", "x_studio_ticket_id", "helpdesk_ticket_id"],
      attributes: ["type", "relation"],
    })) || {};
  } catch {
    fields = {};
  }
  const m2o = (name, relation) => fields[name]?.type === "many2one" && (!relation || fields[name].relation === relation);
  const ticketFields = m2o("prg_ticket_id", "helpdesk.ticket")
    ? ["prg_ticket_id", ...(m2o("x_studio_ticket_id", "helpdesk.ticket") ? ["x_studio_ticket_id"] : [])]
    : m2o("helpdesk_ticket_id", "helpdesk.ticket")
      ? ["helpdesk_ticket_id"]
      : [];
  return {
    activityModel: m2o("activity_type_id") ? fields.activity_type_id.relation : null,
    ticketFields,
  };
}

/** UID del usuario dueño de la API key. */
export async function resolveCurrentUid(odoo, login) {
  const adapter = odoo?.adapter ?? odoo;
  if (typeof adapter?.authenticateLegacy === "function") {
    return adapter.authenticateLegacy();
  }
  if (!login) {
    throw new AppError(
      400,
      "login_required",
      "Para identificar al usuario se requiere ODOO_LOGIN (en .env) u odoo_login (en cliente.yaml).",
    );
  }
  const users = await odoo.searchRead("res.users", [["login", "=", String(login)]], ["id"], { limit: 1 });
  const uid = positiveInt(users?.[0]?.id);
  if (!uid) {
    throw new AppError(404, "user_not_found", "No se encontró el usuario de Odoo asociado al login configurado.");
  }
  return uid;
}

/** consultar_mis_proyectos_tareas */
export async function listTimesheetProjectsTasks(odoo, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 100) : "";
  const projectId = args.proyecto_id !== undefined && args.proyecto_id !== null ? positiveInt(args.proyecto_id) : null;
  if (args.proyecto_id !== undefined && args.proyecto_id !== null && !projectId) {
    throw new AppError(400, "invalid_project_id", "proyecto_id debe ser un entero positivo.");
  }
  const limit = clampLimit(args.limit, 80, 200);

  const onlyFavorites = args.solo_favoritos === true;

  const projectDomain = [["allow_timesheets", "=", true]];
  if (onlyFavorites) projectDomain.push(["is_favorite", "=", true]);
  if (projectId) projectDomain.push(["id", "=", projectId]);
  else if (query) projectDomain.push("|", ["name", "ilike", query], ["partner_id.name", "ilike", query]);

  const projects = await odoo.searchRead(
    "project.project",
    projectDomain,
    ["id", "name", "partner_id", "is_favorite"],
    { limit, order: "is_favorite desc, name asc" },
  );

  const taskBase = [["project_id.allow_timesheets", "=", true]];
  if (onlyFavorites) taskBase.push(["project_id.is_favorite", "=", true]);
  if (projectId) {
    taskBase.push(["project_id", "=", projectId]);
    if (query) taskBase.push(["name", "ilike", query]);
  } else if (query) {
    taskBase.push("|", ["name", "ilike", query], ["project_id.name", "ilike", query]);
  }

  const includeClosed = args.incluir_cerradas === true;
  const taskFields = ["id", "name", "project_id", "stage_id"];
  let tasks;
  if (includeClosed) {
    tasks = await odoo.searchRead("project.task", taskBase, taskFields, { limit, order: "project_id, name" });
  } else {
    try {
      tasks = await odoo.searchRead(
        "project.task",
        [...taskBase, ["state", "not in", CLOSED_TASK_STATES]],
        taskFields,
        { limit, order: "project_id, name" },
      );
    } catch {
      // Odoo < 17 no tiene project.task.state: se listan sin ese filtro.
      tasks = await odoo.searchRead("project.task", taskBase, taskFields, { limit, order: "project_id, name" });
    }
  }

  return {
    proyectos: (projects || []).map((p) => ({
      id: p.id,
      nombre: p.name,
      cliente: relationName(p.partner_id) || null,
      favorito: p.is_favorite === true,
    })),
    tareas: (tasks || []).map((t) => ({
      id: t.id,
      nombre: t.name,
      proyecto_id: relationId(t.project_id),
      proyecto: relationName(t.project_id),
      etapa: relationName(t.stage_id) || null,
    })),
  };
}

function extraFieldNames(extras) {
  return [
    ...(extras?.activityModel ? ["activity_type_id"] : []),
    ...(extras?.ticketFields?.length ? [extras.ticketFields[0]] : []),
  ];
}

async function readOwnTimesheets(odoo, uid, desde, hasta, limit = 2000, extras = null) {
  return odoo.searchRead(
    TIMESHEET_MODEL,
    [
      ["employee_id.user_id", "=", uid],
      ["project_id", "!=", false],
      ["date", ">=", desde],
      ["date", "<=", hasta],
    ],
    [...TIMESHEET_FIELDS, ...extraFieldNames(extras)],
    { limit, order: "date asc, id asc" },
  );
}

/** consultar_tipos_actividad */
export async function listActivityTypes(odoo, extras) {
  if (!extras?.activityModel) {
    return { disponible: false, mensaje: "Esta base no tiene tipo de actividad en los partes de horas.", tipos: [] };
  }
  let rows;
  try {
    rows = await odoo.searchRead(extras.activityModel, [], ["id", "name", "area", "description", "is_invoiceable"], { limit: 500, order: "name asc" });
  } catch {
    rows = await odoo.searchRead(extras.activityModel, [], ["id", "name"], { limit: 500, order: "name asc" });
  }
  return {
    disponible: true,
    obligatorio: true,
    tipos: (rows || []).map((r) => ({
      id: r.id,
      nombre: r.name,
      ...(r.area !== undefined ? { area: r.area || null } : {}),
      ...(r.description !== undefined ? { descripcion: r.description || null } : {}),
      ...(r.is_invoiceable !== undefined ? { facturable: r.is_invoiceable === true } : {}),
    })),
  };
}

/** consultar_mis_tickets: tickets abiertos asignados al usuario y dónde se imputaron por última vez. */
export async function listMyTickets(odoo, { uid, query, limit } = {}, extras) {
  if (!extras?.ticketFields?.length) {
    return { disponible: false, mensaje: "Esta base no vincula partes de horas con tickets de Helpdesk.", tickets: [] };
  }
  const domain = [["user_id", "=", uid], ["stage_id.fold", "=", false]];
  const q = typeof query === "string" ? query.trim().slice(0, 100) : "";
  if (q) domain.push("|", ["name", "ilike", q], ["partner_id.name", "ilike", q]);
  const tickets = await odoo.searchRead(
    "helpdesk.ticket",
    domain,
    ["id", "name", "partner_id", "project_id", "team_id", "stage_id"],
    { limit: clampLimit(limit, 50, 200), order: "id desc" },
  );
  const ids = (tickets || []).map((t) => t.id);
  const field = extras.ticketFields[0];
  const lastUse = new Map();
  if (ids.length) {
    const used = await odoo.searchRead(
      TIMESHEET_MODEL,
      [["employee_id.user_id", "=", uid], [field, "in", ids]],
      ["date", "project_id", "task_id", field, ...(extras.activityModel ? ["activity_type_id"] : [])],
      { limit: 1000, order: "date desc, id desc" },
    );
    for (const l of used || []) {
      const tid = relationId(l[field]);
      if (!lastUse.has(tid)) lastUse.set(tid, l);
    }
  }
  return {
    disponible: true,
    tickets: (tickets || []).map((t) => {
      const last = lastUse.get(t.id);
      return {
        id: t.id,
        nombre: t.name,
        cliente: relationName(t.partner_id) || null,
        equipo: relationName(t.team_id) || null,
        etapa: relationName(t.stage_id) || null,
        proyecto_ticket_id: relationId(t.project_id),
        proyecto_ticket: relationName(t.project_id) || null,
        ultimo_registro: last
          ? {
              fecha: last.date,
              proyecto_id: relationId(last.project_id),
              proyecto: relationName(last.project_id),
              tarea_id: relationId(last.task_id),
              tarea: relationName(last.task_id) || null,
              ...(extras.activityModel
                ? { tipo_actividad_id: relationId(last.activity_type_id), tipo_actividad: relationName(last.activity_type_id) || null }
                : {}),
            }
          : null,
      };
    }),
  };
}

/** consultar_mis_horas */
export async function listMyTimesheets(odoo, { uid, desde, hasta, limit } = {}, extras = null) {
  requireIsoDate(desde, "desde");
  requireIsoDate(hasta, "hasta");
  if (desde > hasta) {
    throw new AppError(400, "invalid_range", "La fecha 'desde' no puede ser posterior a 'hasta'.");
  }
  const ticketField = extras?.ticketFields?.[0];
  const lines = await readOwnTimesheets(odoo, uid, desde, hasta, clampLimit(limit, 500, 2000), extras);
  const porDia = {};
  let total = 0;
  const lineas = (lines || []).map((l) => {
    const horas = roundHours(l.unit_amount);
    porDia[l.date] = roundHours((porDia[l.date] || 0) + horas);
    total = roundHours(total + horas);
    return {
      id: l.id,
      fecha: l.date,
      proyecto_id: relationId(l.project_id),
      proyecto: relationName(l.project_id),
      tarea_id: relationId(l.task_id),
      tarea: relationName(l.task_id) || null,
      descripcion: l.name,
      horas,
      ...(extras?.activityModel ? { tipo_actividad: relationName(l.activity_type_id) || null } : {}),
      ...(ticketField ? { ticket_id: relationId(l[ticketField]), ticket: relationName(l[ticketField]) || null } : {}),
    };
  });
  return { desde, hasta, total_horas: total, horas_por_dia: porDia, lineas };
}

/** Normaliza y valida la forma de cada línea (sin consultar Odoo). */
export function normalizeTimesheetLines(rawLines, { today, timeZone = DEFAULT_TIMEZONE, now = new Date() } = {}) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new AppError(400, "empty_lines", "Debe incluir al menos una línea en 'lineas'.");
  }
  if (rawLines.length > MAX_LINES_PER_CALL) {
    throw new AppError(400, "too_many_lines", `Máximo ${MAX_LINES_PER_CALL} líneas por llamada.`);
  }
  const todayIso = today || localIsoDate(now, timeZone);

  return rawLines.map((raw, index) => {
    const pos = `línea ${index + 1}`;
    if (!raw || typeof raw !== "object") {
      throw new AppError(400, "invalid_line", `${pos}: debe ser un objeto.`);
    }
    const date = raw.fecha;
    if (!isValidIsoDate(date)) {
      throw new AppError(400, "invalid_date", `${pos}: fecha inválida '${date}' (YYYY-MM-DD).`);
    }
    if (date > todayIso) {
      throw new AppError(400, "future_date", `${pos}: no se registran horas en fechas futuras (${date} > ${todayIso}).`);
    }
    const projectId = positiveInt(raw.proyecto_id);
    if (!projectId) {
      throw new AppError(400, "invalid_project_id", `${pos}: proyecto_id debe ser un entero positivo.`);
    }
    let taskId = null;
    if (raw.tarea_id !== undefined && raw.tarea_id !== null) {
      taskId = positiveInt(raw.tarea_id);
      if (!taskId) {
        throw new AppError(400, "invalid_task_id", `${pos}: tarea_id debe ser un entero positivo.`);
      }
    }
    const hours = Number(raw.horas);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new AppError(400, "invalid_hours", `${pos}: las horas deben ser mayores que 0.`);
    }
    const description = String(raw.descripcion ?? "").trim().replace(/\s+/g, " ");
    if (!description) {
      throw new AppError(400, "missing_description", `${pos}: la descripción es obligatoria.`);
    }
    const optionalId = (value, field, code) => {
      if (value === undefined || value === null) return null;
      const id = positiveInt(value);
      if (!id) throw new AppError(400, code, `${pos}: ${field} debe ser un entero positivo.`);
      return id;
    };
    return {
      date,
      projectId,
      taskId,
      hours: roundHours(hours),
      description: description.slice(0, 500),
      activityTypeId: optionalId(raw.tipo_actividad_id, "tipo_actividad_id", "invalid_activity_type_id"),
      ticketId: optionalId(raw.ticket_id, "ticket_id", "invalid_ticket_id"),
    };
  });
}

/** Valores exactos que se envían a Odoo. Sin employee_id: Odoo usa el empleado del usuario de la API key. */
export function buildTimesheetValues(line, extras = null) {
  const values = {
    project_id: line.projectId,
    ...(line.taskId ? { task_id: line.taskId } : {}),
    date: line.date,
    unit_amount: line.hours,
    name: line.description,
  };
  if (line.activityTypeId) values.activity_type_id = line.activityTypeId;
  if (line.ticketId) {
    for (const field of extras?.ticketFields || []) values[field] = line.ticketId;
  }
  return values;
}

/**
 * Prepara un registro: valida contra Odoo (proyecto/tarea), aplica idempotencia y el
 * límite diario. No escribe nada.
 */
export async function prepareTimesheetRegistration(odoo, rawLines, {
  uid,
  today,
  timeZone = DEFAULT_TIMEZONE,
  now = new Date(),
  maxHoursPerDay = DEFAULT_MAX_HOURS_PER_DAY,
} = {}) {
  if (!positiveInt(uid)) {
    throw new AppError(400, "uid_required", "No se pudo determinar el usuario de Odoo.");
  }
  const lines = normalizeTimesheetLines(rawLines, { today, timeZone, now });

  // Proyectos y tareas: existen, admiten partes de horas y son coherentes entre sí.
  const projectIds = [...new Set(lines.map((l) => l.projectId))];
  const taskIds = [...new Set(lines.map((l) => l.taskId).filter(Boolean))];
  const projects = await odoo.searchRead(
    "project.project",
    [["id", "in", projectIds]],
    ["id", "name", "allow_timesheets"],
    { limit: projectIds.length },
  );
  const projectById = new Map((projects || []).map((p) => [p.id, p]));
  const tasks = taskIds.length
    ? await odoo.searchRead("project.task", [["id", "in", taskIds]], ["id", "name", "project_id"], { limit: taskIds.length })
    : [];
  const taskById = new Map((tasks || []).map((t) => [t.id, t]));

  // Tipo de actividad (obligatorio si la base lo tiene) y ticket de Helpdesk.
  const extras = await detectTimesheetExtras(odoo);
  const activityIds = [...new Set(lines.map((l) => l.activityTypeId).filter(Boolean))];
  let activityById = new Map();
  if (extras.activityModel) {
    const missing = lines.findIndex((l) => !l.activityTypeId);
    if (missing >= 0) {
      throw new AppError(400, "activity_type_required", `línea ${missing + 1}: tipo_actividad_id es obligatorio en esta base (consulta consultar_tipos_actividad).`);
    }
    const rows = await odoo.searchRead(extras.activityModel, [["id", "in", activityIds]], ["id", "name"], { limit: activityIds.length });
    activityById = new Map((rows || []).map((r) => [r.id, r]));
  } else if (activityIds.length) {
    throw new AppError(400, "activity_type_unsupported", "Esta base no tiene tipo de actividad en los partes de horas.");
  }
  const ticketIds = [...new Set(lines.map((l) => l.ticketId).filter(Boolean))];
  let ticketById = new Map();
  if (ticketIds.length) {
    if (!extras.ticketFields.length) {
      throw new AppError(400, "tickets_unsupported", "Esta base no vincula partes de horas con tickets de Helpdesk.");
    }
    const rows = await odoo.searchRead("helpdesk.ticket", [["id", "in", ticketIds]], ["id", "name"], { limit: ticketIds.length });
    ticketById = new Map((rows || []).map((r) => [r.id, r]));
  }

  for (const [index, line] of lines.entries()) {
    const pos = `línea ${index + 1}`;
    if (line.activityTypeId) {
      const activity = activityById.get(line.activityTypeId);
      if (!activity) throw new AppError(404, "activity_type_not_found", `${pos}: el tipo de actividad ${line.activityTypeId} no existe.`);
      line.activityName = activity.name;
    }
    if (line.ticketId) {
      const ticket = ticketById.get(line.ticketId);
      if (!ticket) throw new AppError(404, "ticket_not_found", `${pos}: el ticket ${line.ticketId} no existe o no es visible para tu usuario.`);
      line.ticketName = ticket.name;
    }
    const project = projectById.get(line.projectId);
    if (!project) {
      throw new AppError(404, "project_not_found", `${pos}: el proyecto ${line.projectId} no existe o no es visible para tu usuario.`);
    }
    if (project.allow_timesheets === false) {
      throw new AppError(400, "project_without_timesheets", `${pos}: el proyecto '${project.name}' no admite partes de horas.`);
    }
    line.projectName = project.name;
    if (line.taskId) {
      const task = taskById.get(line.taskId);
      if (!task) {
        throw new AppError(404, "task_not_found", `${pos}: la tarea ${line.taskId} no existe o no es visible para tu usuario.`);
      }
      if (relationId(task.project_id) !== line.projectId) {
        throw new AppError(400, "task_project_mismatch", `${pos}: la tarea '${task.name}' no pertenece al proyecto '${project.name}'.`);
      }
      line.taskName = task.name;
    }
  }

  // Idempotencia contra lo ya registrado y dentro del propio lote.
  const dates = lines.map((l) => l.date).sort();
  const existing = await readOwnTimesheets(odoo, uid, dates[0], dates[dates.length - 1]);
  const existingKeys = new Map();
  const existingHoursByDate = {};
  for (const e of existing || []) {
    existingHoursByDate[e.date] = roundHours((existingHoursByDate[e.date] || 0) + Number(e.unit_amount || 0));
    existingKeys.set(
      timesheetKey({
        date: e.date,
        projectId: relationId(e.project_id),
        taskId: relationId(e.task_id),
        description: e.name,
      }),
      e.id,
    );
  }

  const toCreate = [];
  const skipped = [];
  const seen = new Set();
  for (const line of lines) {
    const key = timesheetKey(line);
    if (existingKeys.has(key)) {
      skipped.push({ ...line, motivo: "ya_registrada", odoo_id: existingKeys.get(key) });
    } else if (seen.has(key)) {
      skipped.push({ ...line, motivo: "duplicada_en_lote" });
    } else {
      seen.add(key);
      toCreate.push(line);
    }
  }

  // Límite diario: lo ya registrado + lo nuevo.
  const newHoursByDate = {};
  for (const line of toCreate) {
    newHoursByDate[line.date] = roundHours((newHoursByDate[line.date] || 0) + line.hours);
  }
  for (const [date, hours] of Object.entries(newHoursByDate)) {
    const total = roundHours((existingHoursByDate[date] || 0) + hours);
    if (total > maxHoursPerDay) {
      throw new AppError(
        400,
        "daily_limit_exceeded",
        `El ${date} quedaría con ${total} h (ya registradas: ${existingHoursByDate[date] || 0} h). Máximo ${maxHoursPerDay} h por día.`,
      );
    }
  }

  return {
    toCreate,
    skipped,
    existingHoursByDate,
    newHoursByDate,
    extras,
  };
}

function lineLabel(line) {
  const target = line.taskName ? `${line.projectName} / ${line.taskName}` : line.projectName || `proyecto ${line.projectId}`;
  const extra = [
    line.activityName ? `tipo: ${line.activityName}` : null,
    line.ticketName ? `ticket: ${line.ticketName}` : null,
  ].filter(Boolean);
  return `${line.date} | ${target} | ${line.hours} h | ${line.description}${extra.length ? ` | ${extra.join(" | ")}` : ""}`;
}

export function summarizePreparation(prep) {
  const parts = [];
  if (prep.toCreate.length) {
    parts.push(`Se registrarán ${prep.toCreate.length} línea(s) de horas en Odoo:`);
    for (const line of prep.toCreate) parts.push(`  • ${lineLabel(line)}`);
    const totals = Object.entries(prep.newHoursByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, hours]) => {
        const prev = prep.existingHoursByDate[date] || 0;
        return `  ${date}: +${hours} h (total del día ${roundHours(prev + hours)} h)`;
      });
    parts.push("Totales por día:", ...totals);
  } else {
    parts.push("No hay líneas nuevas para registrar.");
  }
  if (prep.skipped.length) {
    parts.push(`Se omiten ${prep.skipped.length} línea(s):`);
    for (const line of prep.skipped) {
      const why = line.motivo === "ya_registrada" ? `ya existe en Odoo (#${line.odoo_id})` : "repetida en esta solicitud";
      parts.push(`  • ${lineLabel(line)} — ${why}`);
    }
  }
  return parts.join("\n");
}

export function publicLine(line) {
  return {
    fecha: line.date,
    proyecto_id: line.projectId,
    proyecto: line.projectName ?? null,
    tarea_id: line.taskId,
    tarea: line.taskName ?? null,
    horas: line.hours,
    descripcion: line.description,
    ...(line.activityTypeId ? { tipo_actividad_id: line.activityTypeId, tipo_actividad: line.activityName ?? null } : {}),
    ...(line.ticketId ? { ticket_id: line.ticketId, ticket: line.ticketName ?? null } : {}),
    ...(line.motivo ? { motivo: line.motivo } : {}),
    ...(line.odoo_id ? { odoo_id: line.odoo_id } : {}),
  };
}

function extractCreatedId(created) {
  if (Array.isArray(created)) {
    const first = created[0];
    return Number(typeof first === "object" && first !== null ? first.id : first);
  }
  if (typeof created === "object" && created !== null) return Number(created.id);
  return Number(created);
}

/** Crea las líneas preparadas, una a una. Si una falla, se detiene e informa lo creado. */
export async function executeTimesheetRegistration(odoo, prep) {
  const created = [];
  for (const line of prep.toCreate) {
    try {
      const result = await odoo.create(TIMESHEET_MODEL, buildTimesheetValues(line, prep.extras), TIMESHEET_CONTEXT);
      created.push({ ...publicLine(line), odoo_id: extractCreatedId(result) });
    } catch (error) {
      return {
        success: false,
        creadas: created,
        omitidas: prep.skipped.map(publicLine),
        fallida: publicLine(line),
        error: error?.message || String(error),
        pendientes: prep.toCreate.length - created.length,
      };
    }
  }
  return {
    success: true,
    creadas: created,
    omitidas: prep.skipped.map(publicLine),
    summary: `Registradas ${created.length} línea(s) de horas; omitidas ${prep.skipped.length}.`,
  };
}
