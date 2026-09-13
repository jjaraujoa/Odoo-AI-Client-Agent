import { AppError } from "./errors.js";
import { relationId, relationName } from "./odoo.js";

function recordUrl(baseUrl, model, id) {
  return `${baseUrl.replace(/\/$/, "")}/web#id=${id}&model=${encodeURIComponent(model)}&view_type=form`;
}

function normalizedSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 200);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function similarity(left, right) {
  const a = normalizedSearchText(left);
  const b = normalizedSearchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

function fuzzySeedDomain(query) {
  const tokens = normalizedSearchText(query).split(" ").filter((token) => token.length >= 3);
  const seeds = [...new Set(tokens.map((token) => token.slice(0, Math.min(token.length, 4))))].slice(0, 4);
  const conditions = seeds.flatMap((seed) => [
    ["name", "ilike", `%${seed}%`],
    ["default_code", "ilike", `%${seed}%`],
  ]);
  return conditions.length ? [...Array(conditions.length - 1).fill("|"), ...conditions] : [];
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== false).map((value) =>
    typeof value === "object" ? JSON.stringify(value) : value))].map((value) => {
    if (typeof value !== "string" || !/^[\[{]/.test(value)) return value;
    try { return JSON.parse(value); } catch { return value; }
  });
}

function sourceValues(record, definition) {
  const raw = record.internal?.[definition.source];
  if (definition.type === "relation_list") return Array.isArray(raw) ? raw : [];
  if (definition.type === "relation") return relationId(raw);
  return raw;
}

function resolveDeferredDomain(domain, previousResults, stepById) {
  return domain.map((condition) => {
    if (!condition?.deferred) return condition;
    const sourceResult = previousResults.get(condition.sourceStep);
    const sourceStep = stepById.get(condition.sourceStep);
    const definition = sourceStep?.entity.fields[condition.sourceField];
    const values = unique((sourceResult?.records ?? []).flatMap((record) => {
      const value = sourceValues(record, definition);
      return Array.isArray(value) && definition.type === "relation_list" ? value : [value];
    }));
    return [condition.field, condition.operator, values];
  });
}

async function userContext(odoo, identity, base = {}) {
  if (!identity.odoo_user_id) return base;
  const rows = await odoo.searchRead("res.users", [["id", "=", identity.odoo_user_id]], ["lang"], { limit: 1 });
  return rows[0]?.lang ? { ...base, lang: rows[0].lang } : base;
}

async function resolveContextFilters({ db, odoo, identity, step }) {
  let context = {};
  for (const filter of step.contextFilters) {
    if (filter.resolver === "warehouse") {
      const rows = await odoo.searchRead(
        "stock.warehouse", [["name", "ilike", `%${filter.value}%`]], ["name"], { limit: 4, order: "name" },
      );
      if (!rows.length) return { status: "not_found", message: `No encontré el almacén “${filter.value}”.`, context };
      if (rows.length > 1) return { status: "ambiguous", message: `Encontré varios almacenes: ${rows.map((row) => row.name).join(", ")}.`, context };
      context.warehouse = rows[0].id;
    } else if (filter.resolver === "customer_pricelist") {
      const policy = await db.query(
        `SELECT 1 FROM agent.tool_policies
          WHERE client_id = $1 AND tool_name = 'consultar_clientes' AND enabled`,
        [identity.client_id],
      );
      if (!policy.rows[0]) throw new AppError(403, "tool_disabled", "La consulta de clientes no está habilitada para calcular ese precio.");
      const rows = await odoo.searchRead(
        "res.partner", [["name", "ilike", `%${filter.value}%`]],
        ["name", "property_product_pricelist"], { limit: 3, order: "name" },
      );
      if (!rows.length) return { status: "not_found", message: `No encontré el cliente “${filter.value}”.`, context };
      if (rows.length > 1) return { status: "ambiguous", message: `Encontré varios clientes: ${rows.map((row) => row.name).join(", ")}.`, context };
      context = {
        ...context,
        partner: rows[0].id,
        pricelist: relationId(rows[0].property_product_pricelist),
      };
    }
  }
  return { status: "ok", context: await userContext(odoo, identity, context) };
}

function normalizeValue(definition, raw) {
  if (definition.type === "relation") return relationName(raw) || null;
  if (definition.type === "relation_list") return Array.isArray(raw) ? raw.length : 0;
  if (definition.labels && Object.hasOwn(definition.labels, raw)) return definition.labels[raw];
  return raw ?? null;
}

function normalizeRecord(step, identity, record) {
  const values = {};
  for (const name of step.semanticFields) {
    const definition = step.entity.fields[name];
    if (!definition?.source) continue;
    values[name] = normalizeValue(definition, record[definition.source]);
  }
  return {
    id: record.id,
    entity: step.entity.key,
    values,
    url: recordUrl(identity.odoo_base_url, step.entity.model, record.id),
    internal: Object.fromEntries([...step.technicalFields].map((name) => [name, record[name]])),
  };
}

function orderText(sort) {
  return sort.map((item) => `${item.technicalField} ${item.direction}`).join(", ");
}

function relaxTextDomain(step, domain) {
  const searchable = new Set(step.entity.searchFields.map((name) => {
    const definition = step.entity.fields[name];
    return definition.filterSource || definition.source;
  }));
  let changed = false;
  const relaxed = domain.map((condition) => {
    if (!Array.isArray(condition) || condition[1] !== "=" || typeof condition[2] !== "string" || !searchable.has(condition[0])) return condition;
    changed = true;
    return [condition[0], "ilike", `%${condition[2]}%`];
  });
  return changed ? relaxed : null;
}

async function fuzzyProducts({ odoo, step, context }) {
  const hint = step.searchHints[0];
  if (!hint || !["productos", "inventario"].includes(step.entity.key)) return null;
  const fields = [...new Set(["name", "display_name", "default_code", ...step.technicalFields])];
  const candidates = await odoo.searchRead(
    step.entity.model,
    fuzzySeedDomain(hint.value),
    fields,
    { limit: 100, order: "name", context },
  );
  const ranked = candidates.map((record) => ({
    record,
    score: Math.max(similarity(hint.value, record.name), similarity(hint.value, record.display_name), similarity(hint.value, record.default_code)),
  })).filter((item) => item.score >= 0.72)
    .sort((a, b) => b.score - a.score || String(a.record.display_name).localeCompare(String(b.record.display_name)));
  if (!ranked.length) return { records: [], suggestions: [], interpretedAs: null };
  if (ranked[0].score >= 0.78 && (!ranked[1] || ranked[0].score - ranked[1].score >= 0.08)) {
    return { records: [ranked[0].record], suggestions: [], interpretedAs: ranked[0].record.display_name || ranked[0].record.name };
  }
  return {
    records: [], interpretedAs: null,
    suggestions: ranked.slice(0, 5).map((item) => item.record.display_name || item.record.name),
  };
}

function aggregateRecords(step, records) {
  const fieldDefinition = step.aggregate.field ? step.entity.fields[step.aggregate.field] : null;
  const groups = new Map();
  for (const record of records) {
    const groupValues = step.groupBy.map((name) => normalizeValue(step.entity.fields[name], record[step.entity.fields[name].source]));
    const key = JSON.stringify(groupValues);
    if (!groups.has(key)) groups.set(key, { by: Object.fromEntries(step.groupBy.map((name, index) => [name, groupValues[index]])), values: [] });
    if (step.aggregate.function === "count") groups.get(key).values.push(1);
    else {
      const numeric = Number(record[fieldDefinition.source]);
      if (Number.isFinite(numeric)) groups.get(key).values.push(numeric);
    }
  }
  if (!groups.size && !step.groupBy.length) groups.set("[]", { by: {}, values: [] });
  return [...groups.values()].map((group) => {
    const values = group.values;
    let value;
    if (step.aggregate.function === "count") value = values.length;
    else if (!values.length) value = null;
    else if (step.aggregate.function === "sum") value = values.reduce((total, item) => total + item, 0);
    else if (step.aggregate.function === "average") value = values.reduce((total, item) => total + item, 0) / values.length;
    else if (step.aggregate.function === "min") value = Math.min(...values);
    else value = Math.max(...values);
    return { by: group.by, value, records: values.length };
  });
}

async function executeStep({ db, odoo, identity, limits, step, domain, retryAvailable }) {
  const contextResult = await resolveContextFilters({ db, odoo, identity, step });
  if (contextResult.status !== "ok") {
    return { id: step.id, entity: step.entity.key, operation: step.operation, status: contextResult.status, message: contextResult.message, records: [], truncated: false, retryUsed: false };
  }
  const context = contextResult.context;
  if (step.operation === "count" && !step.groupBy.length) {
    const count = await odoo.searchCount(step.entity.model, domain, { context });
    return { id: step.id, entity: step.entity.key, operation: step.operation, status: "ok", count, records: [], truncated: false, retryUsed: false };
  }
  const aggregate = step.operation === "aggregate";
  const requestLimit = (aggregate ? step.fetchLimit : step.limit) + 1;
  let rawRecords = await odoo.searchRead(
    step.entity.model,
    domain,
    [...step.technicalFields],
    { limit: requestLimit, order: orderText(step.sort), context },
  );
  let retryUsed = false;
  let interpretation = null;
  let suggestions = [];
  if (!rawRecords.length && retryAvailable) {
    const relaxed = relaxTextDomain(step, domain);
    if (relaxed) {
      rawRecords = await odoo.searchRead(
        step.entity.model, relaxed, [...step.technicalFields],
        { limit: requestLimit, order: orderText(step.sort), context },
      );
      retryUsed = true;
    }
    if (!rawRecords.length && ["productos", "inventario"].includes(step.entity.key)) {
      const fuzzy = await fuzzyProducts({ odoo, step, context });
      if (fuzzy) {
        rawRecords = fuzzy.records;
        suggestions = fuzzy.suggestions;
        interpretation = fuzzy.interpretedAs;
        retryUsed = true;
      }
    }
  }
  if (!rawRecords.length) {
    return {
      id: step.id, entity: step.entity.key, operation: step.operation,
      status: suggestions.length ? "ambiguous" : "not_found",
      message: suggestions.length ? `Encontré opciones parecidas: ${suggestions.join(", ")}.` : null,
      suggestions, records: [], truncated: false, retryUsed,
    };
  }
  const cap = aggregate ? step.fetchLimit : step.limit;
  const truncated = rawRecords.length > cap;
  const selected = rawRecords.slice(0, cap);
  if (aggregate) {
    return {
      id: step.id, entity: step.entity.key, operation: step.operation,
      status: truncated ? "incomplete" : "ok",
      incomplete_reason: truncated ? `La consulta supera ${cap} registros; no se calculó un total parcial como si fuera completo.` : null,
      aggregate: truncated ? null : {
        function: step.aggregate.function,
        field: step.aggregate.field,
        groups: aggregateRecords(step, selected),
      },
      records: selected.slice(0, Math.min(step.limit, 10)).map((record) => normalizeRecord(step, identity, record)),
      truncated, retryUsed, interpretation,
    };
  }
  return {
    id: step.id, entity: step.entity.key, operation: step.operation,
    status: truncated ? "truncated" : "ok",
    records: selected.map((record) => normalizeRecord(step, identity, record)),
    truncated, retryUsed, interpretation,
  };
}

export async function executeReadPlan({ db, odoo, identity, limits, compiled }) {
  const results = [];
  const byId = new Map();
  const stepById = new Map(compiled.steps.map((step) => [step.id, step]));
  let retryAvailable = true;
  for (const step of compiled.steps) {
    const domain = resolveDeferredDomain(step.domain, byId, stepById);
    const result = await executeStep({ db, odoo, identity, limits, step, domain, retryAvailable });
    if (result.retryUsed) retryAvailable = false;
    results.push(result);
    byId.set(step.id, result);
  }
  return {
    schema: "read_execution_v1",
    plan_hash: compiled.hash,
    objective: compiled.objective,
    assumptions: compiled.assumptions,
    response: compiled.response,
    retry_used: !retryAvailable,
    steps: results,
  };
}

export function executionForModel(execution) {
  return {
    schema: execution.schema,
    objective: execution.objective,
    assumptions: execution.assumptions,
    retry_used: execution.retry_used,
    steps: execution.steps.map((step) => ({
      id: step.id,
      entity: step.entity,
      operation: step.operation,
      status: step.status,
      message: step.message || null,
      count: step.count ?? null,
      aggregate: step.aggregate ?? null,
      truncated: Boolean(step.truncated),
      incomplete_reason: step.incomplete_reason || null,
      interpretation: step.interpretation || null,
      suggestions: step.suggestions || [],
      records: step.records.map((record) => ({ id: record.id, ...record.values, url: record.url })),
    })),
  };
}

export function summarizeReadExecutionForMemory(compiled, execution) {
  const memoryKeys = new Set([
    "numero", "nombre", "referencia", "cliente", "proveedor", "fecha", "vencimiento",
    "estado", "estado_pago", "estado_facturacion", "facturas_relacionadas", "total", "saldo", "moneda",
  ]);
  return {
    schema: "read_plan_v1",
    plan_hash: compiled.hash,
    objective: compiled.objective,
    assumptions: compiled.assumptions,
    steps: execution.steps.map((step) => ({
      id: step.id,
      entity: step.entity,
      operation: step.operation,
      status: step.status,
      count: step.count ?? null,
      aggregate: step.aggregate ?? null,
      truncated: Boolean(step.truncated),
      records: step.records.slice(0, 10).map((record) => ({
        id: record.id,
        values: Object.fromEntries(Object.entries(record.values).filter(([key]) => memoryKeys.has(key))),
      })),
    })),
  };
}
