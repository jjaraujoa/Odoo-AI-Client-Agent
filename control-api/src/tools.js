import { AppError } from "./errors.js";
import { relationId, relationName } from "./odoo.js";

const TOOL_BY_INTENT = Object.freeze({
  sale_order: "consultar_orden_venta",
  purchase_order: "consultar_orden_compra",
  product_price: "consultar_precio_producto",
  inventory: "consultar_inventario",
  pending_invoices: "consultar_facturas_pendientes",
});

export async function requireToolPolicy(db, clientId, toolName) {
  const result = await db.query(
    `SELECT * FROM agent.tool_policies
      WHERE client_id = $1 AND tool_name = $2 AND enabled`,
    [clientId, toolName],
  );
  if (!result.rows[0]) {
    throw new AppError(403, "tool_disabled", "Esta operación no está habilitada para el cliente.");
  }
  return result.rows[0];
}

function contains(value) {
  return ["ilike", `%${String(value).trim()}%`];
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
  const normalizedLeft = normalizedSearchText(left);
  const normalizedRight = normalizedSearchText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.92;
  const editScore = (first, second) =>
    1 - editDistance(first, second) / Math.max(first.length, second.length);
  const sortedLeft = normalizedLeft.split(" ").sort().join(" ");
  const sortedRight = normalizedRight.split(" ").sort().join(" ");
  return Math.max(
    editScore(normalizedLeft, normalizedRight),
    editScore(sortedLeft, sortedRight),
  );
}

function fuzzySeedDomain(query) {
  const tokens = normalizedSearchText(query).split(" ").filter((token) => token.length >= 3);
  const seeds = [...new Set(tokens.map((token) => token.slice(0, Math.min(token.length, 4))))].slice(0, 4);
  const conditions = seeds.flatMap((seed) => [
    ["name", "ilike", `%${seed}%`],
    ["default_code", "ilike", `%${seed}%`],
  ]);
  if (!conditions.length) return [];
  return [...Array(Math.max(conditions.length - 1, 0)).fill("|"), ...conditions];
}

function productSimilarity(query, product) {
  return Math.max(
    similarity(query, product.name),
    similarity(query, product.display_name),
    similarity(query, product.default_code),
  );
}

async function findProducts({ odoo, query, fields, limit, context }) {
  const requestedFields = [...new Set(["name", "display_name", "default_code", ...fields])];
  const exact = await odoo.searchRead(
    "product.product",
    ["|", ["name", ...contains(query)], ["default_code", ...contains(query)]],
    requestedFields,
    { limit, context },
  );
  if (exact.length) return { records: exact, interpretedAs: null, suggestions: [] };

  const seedDomain = fuzzySeedDomain(query);
  let candidates = await odoo.searchRead(
    "product.product",
    seedDomain,
    requestedFields,
    { limit: 100, order: "name", context },
  );
  if (!candidates.length && seedDomain.length) {
    candidates = await odoo.searchRead(
      "product.product", [], requestedFields,
      { limit: 100, order: "name", context },
    );
  }
  const ranked = candidates
    .map((record) => ({ record, score: productSimilarity(query, record) }))
    .filter((candidate) => candidate.score >= 0.72)
    .sort((left, right) => right.score - left.score || String(left.record.display_name).localeCompare(String(right.record.display_name)));
  if (!ranked.length) return { records: [], interpretedAs: null, suggestions: [] };

  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best.score >= 0.78 && (!runnerUp || best.score - runnerUp.score >= 0.08)) {
    return {
      records: [best.record],
      interpretedAs: best.record.display_name || best.record.name,
      suggestions: [],
    };
  }
  return {
    records: [],
    interpretedAs: null,
    suggestions: ranked.slice(0, 5).map((candidate) => candidate.record.display_name || candidate.record.name),
  };
}

async function productUserContext(odoo, identity, context = {}) {
  if (!identity.odoo_user_id) return context;
  const users = await odoo.searchRead(
    "res.users",
    [["id", "=", identity.odoo_user_id]],
    ["lang"],
    { limit: 1 },
  );
  const language = users[0]?.lang;
  return language ? { ...context, lang: language } : context;
}

function recordUrl(baseUrl, model, id) {
  return `${baseUrl.replace(/\/$/, "")}/web#id=${id}&model=${encodeURIComponent(model)}&view_type=form`;
}

function clampLimit(requested, limits) {
  return Math.min(Number(requested || 5), Number(limits.max_display_records), 10);
}

function ambiguity(records, exactField, requested) {
  if (records.length <= 1 || !requested) return false;
  return !records.some((record) => String(record[exactField] ?? "").toLowerCase() === requested.toLowerCase());
}

function requestedDocumentNumbers(args) {
  const values = [
    ...(Array.isArray(args.document_numbers) ? args.document_numbers : []),
    ...(args.document_number ? [args.document_number] : []),
  ];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 10);
}

function invoiceStatusLabel(value) {
  return ({
    invoiced: "Facturada",
    "to invoice": "Pendiente de facturar",
    no: "Nada que facturar",
    upselling: "Pendiente por venta adicional",
  })[value] ?? (value ? String(value) : "No informado por Odoo");
}

function accountingStateLabel(value) {
  return ({ posted: "Publicada", draft: "Borrador", cancel: "Cancelada" })[value]
    ?? (value ? String(value) : "No informado");
}

function paymentStateLabel(value) {
  return ({
    paid: "Pagada",
    not_paid: "No pagada",
    in_payment: "En proceso de pago",
    partial: "Pago parcial",
    reversed: "Revertida",
    invoicing_legacy: "Sistema anterior",
  })[value] ?? (value ? String(value) : "No informado");
}

function selectOrderResults(records, mode) {
  if (mode === "with_invoices") return records.filter((record) => record.invoiceCount > 0);
  if (mode === "without_invoices") return records.filter((record) => record.invoiceCount === 0);
  if (mode === "earliest") {
    return [...records].sort((left, right) => String(left.date ?? "").localeCompare(String(right.date ?? ""))).slice(0, 1);
  }
  if (mode === "latest") {
    return [...records].sort((left, right) => String(right.date ?? "").localeCompare(String(left.date ?? ""))).slice(0, 1);
  }
  return records;
}

export async function executeIntent({ db, odoo, identity, limits, classification }) {
  const toolName = TOOL_BY_INTENT[classification.intent];
  if (!toolName) throw new AppError(400, "unsupported_intent", "No existe una herramienta para esa solicitud.");
  await requireToolPolicy(db, identity.client_id, toolName);
  const args = classification.parameters;
  const limit = clampLimit(args.max_results, limits);
  switch (classification.intent) {
    case "sale_order":
      return queryOrders({
        odoo, identity, limit, args, model: "sale.order",
        fields: [
          "name", "partner_id", "date_order", "state", "amount_total", "currency_id",
          "user_id", "company_id", "invoice_status", "invoice_ids",
        ],
        numberField: "name", toolName,
        maxDisplayLimit: Math.min(Number(limits.max_display_records), 10),
      });
    case "purchase_order":
      return queryOrders({
        odoo, identity, limit, args, model: "purchase.order",
        fields: [
          "name", "partner_id", "date_order", "state", "amount_total", "currency_id",
          "user_id", "company_id", "invoice_status", "invoice_ids",
        ],
        numberField: "name", toolName,
        maxDisplayLimit: Math.min(Number(limits.max_display_records), 10),
      });
    case "product_price":
      return queryProductPrice({ odoo, identity, limit, args, toolName });
    case "inventory":
      return queryInventory({ odoo, identity, limit, args, toolName });
    case "pending_invoices":
      return queryPendingInvoices({ odoo, identity, limit, args, toolName });
    default:
      throw new AppError(400, "unsupported_intent", "Intención no soportada.");
  }
}

async function queryOrders({ odoo, identity, limit, maxDisplayLimit, args, model, fields, numberField, toolName }) {
  const domain = [];
  const documentNumbers = requestedDocumentNumbers(args);
  if (documentNumbers.length === 1) domain.push([numberField, ...contains(documentNumbers[0])]);
  if (documentNumbers.length > 1) domain.push([numberField, "in", documentNumbers]);
  if (args.customer || args.supplier) domain.push(["partner_id.name", ...contains(args.customer || args.supplier)]);
  if (args.date_from) domain.push(["date_order", ">=", args.date_from]);
  if (args.date_to) domain.push(["date_order", "<=", `${args.date_to} 23:59:59`]);
  const effectiveLimit = Math.min(Math.max(limit, documentNumbers.length), maxDisplayLimit);
  const order = args.result_mode === "earliest" && !documentNumbers.length ? "date_order asc" : "date_order desc";
  const records = await odoo.searchRead(model, domain, fields, { limit: effectiveLimit + 1, order });
  if (!records.length) return { toolName, status: "not_found", records: [], text: "No encontré registros con esos datos." };
  if (documentNumbers.length === 1 && ambiguity(records, numberField, documentNumbers[0])) {
    return {
      toolName,
      status: "ambiguous",
      records: records.slice(0, effectiveLimit),
      text: `Encontré varias coincidencias: ${records.slice(0, effectiveLimit).map((r) => r.name).join(", ")}. Indica el número exacto.`,
    };
  }
  const candidates = records.slice(0, effectiveLimit).map((r) => ({
    id: r.id,
    number: r.name,
    partner: relationName(r.partner_id),
    date: r.date_order,
    state: r.state,
    total: r.amount_total,
    currency: relationName(r.currency_id),
    owner: relationName(r.user_id),
    company: relationName(r.company_id),
    invoiceStatus: invoiceStatusLabel(r.invoice_status),
    invoiceCount: Array.isArray(r.invoice_ids) ? r.invoice_ids.length : 0,
    url: recordUrl(identity.odoo_base_url, model, r.id),
  }));
  const foundNumbers = new Set(candidates.map((record) => String(record.number).toLowerCase()));
  const missingNumbers = documentNumbers.filter((number) => !foundNumbers.has(number.toLowerCase()));
  const shown = selectOrderResults(candidates, args.result_mode || "list");
  if (!shown.length) {
    const text = args.result_mode === "with_invoices"
      ? "Ninguna de las órdenes consultadas tiene facturas relacionadas."
      : args.result_mode === "without_invoices"
        ? "Todas las órdenes consultadas tienen facturas relacionadas."
        : "No encontré registros que cumplan esa condición.";
    return { toolName, status: "not_found", records: [], text };
  }
  const currencies = new Set(shown.map((record) => record.currency).filter(Boolean));
  const combinedTotal = shown.reduce((total, record) => total + Number(record.total || 0), 0);
  const summary = shown.length > 1 && currencies.size === 1
    ? `Total combinado: ${combinedTotal} ${shown[0].currency}\n\n`
    : "";
  const invoiceLine = (record) => args.include_invoice_status
    ? `\nFacturación: ${record.invoiceStatus} · Facturas relacionadas: ${record.invoiceCount}`
    : "";
  const comparisonLine = args.result_mode === "earliest"
    ? `${shown[0].number} fue creada antes que las demás órdenes comparadas.\n`
    : args.result_mode === "latest"
      ? `${shown[0].number} fue creada después que las demás órdenes comparadas.\n`
      : "";
  const missingLine = missingNumbers.length
    ? `\n\nNo encontré: ${missingNumbers.join(", ")}.`
    : "";
  return {
    toolName,
    status: missingNumbers.length ? "partial" : records.length > effectiveLimit ? "truncated" : "ok",
    records: shown,
    text: `${comparisonLine}${summary}${shown.map((r) =>
      `${r.number} · ${r.partner} · ${r.state} · ${r.total} ${r.currency}\nFecha: ${r.date || "No informada"}${invoiceLine(r)}\n${r.url}`).join("\n\n")}${missingLine}`,
  };
}

async function resolveSingle(odoo, model, query, fields, label) {
  if (!query) return null;
  const records = await odoo.searchRead(model, [
    "|", ["name", ...contains(query)], ["default_code", ...contains(query)],
  ], fields, { limit: 6, order: "name" });
  if (!records.length) throw new AppError(404, `${label}_not_found`, `No encontré ${label} con “${query}”.`);
  const exact = records.filter((record) =>
    [record.name, record.default_code].filter(Boolean).some((value) => String(value).toLowerCase() === query.toLowerCase()));
  if (exact.length === 1) return exact[0];
  if (records.length === 1) return records[0];
  throw new AppError(409, `${label}_ambiguous`, `Encontré varias coincidencias para “${query}”: ${records.map((r) => r.display_name || r.name).join(", ")}.`);
}

async function queryProductPrice({ odoo, identity, limit, args, toolName }) {
  if (!args.product) throw new AppError(400, "product_required", "Indica el producto.");
  let context;
  if (args.customer) {
    const partners = await odoo.searchRead("res.partner", [["name", ...contains(args.customer)]], ["name", "property_product_pricelist"], { limit: 2 });
    if (partners.length !== 1) {
      throw new AppError(409, "customer_ambiguous", "Indica un cliente único para calcular su lista de precios.");
    }
    context = {
      partner: partners[0].id,
      pricelist: relationId(partners[0].property_product_pricelist),
    };
  }
  context = await productUserContext(odoo, identity, context);
  const lookup = await findProducts({
    odoo,
    query: args.product,
    fields: ["lst_price", "currency_id", "uom_id"],
    limit,
    context,
  });
  const products = lookup.records;
  if (lookup.suggestions.length) return {
    toolName,
    status: "ambiguous",
    records: [],
    text: `Encontré productos con nombres parecidos: ${lookup.suggestions.join(", ")}. Indica cuál deseas consultar.`,
  };
  if (!products.length) return {
    toolName,
    status: "not_found",
    records: [],
    text: "No encontré el producto entre los registros visibles para tu usuario mediante la API de Odoo.",
  };
  const rows = products.map((p) => ({
    id: p.id,
    product: p.display_name,
    code: p.default_code,
    price: p.lst_price,
    currency: relationName(p.currency_id),
    uom: relationName(p.uom_id),
    url: recordUrl(identity.odoo_base_url, "product.product", p.id),
  }));
  return {
    toolName,
    status: rows.length > 1 ? "ambiguous" : "ok",
    records: rows,
    text: rows.length > 1
      ? `Encontré varios productos:\n${rows.map((r) => `• ${r.code || "s/c"} · ${r.product}`).join("\n")}`
      : `${lookup.interpretedAs ? `Interpreté “${args.product}” como “${lookup.interpretedAs}”.\n` : ""}${rows[0].product}: ${rows[0].price} ${rows[0].currency} por ${rows[0].uom}.\n${rows[0].url}`,
  };
}

async function queryInventory({ odoo, identity, limit, args, toolName }) {
  if (!args.product) throw new AppError(400, "product_required", "Indica el producto.");
  let context;
  if (args.warehouse) {
    const warehouses = await odoo.searchRead("stock.warehouse", [["name", ...contains(args.warehouse)]], ["name"], { limit: 3 });
    if (warehouses.length !== 1) throw new AppError(409, "warehouse_ambiguous", "Indica un almacén único.");
    context = { warehouse: warehouses[0].id };
  }
  context = await productUserContext(odoo, identity, context);
  const lookup = await findProducts({
    odoo,
    query: args.product,
    fields: ["qty_available", "free_qty", "virtual_available", "uom_id"],
    limit,
    context,
  });
  const products = lookup.records;
  if (lookup.suggestions.length) return {
    toolName,
    status: "ambiguous",
    records: [],
    text: `Encontré productos con nombres parecidos: ${lookup.suggestions.join(", ")}. Indica cuál deseas consultar.`,
  };
  if (!products.length) return {
    toolName,
    status: "not_found",
    records: [],
    text: "No encontré el producto entre los registros visibles para tu usuario mediante la API de Odoo.",
  };
  const rows = products.map((p) => ({
    id: p.id, product: p.display_name, code: p.default_code,
    onHand: p.qty_available, free: p.free_qty, forecast: p.virtual_available,
    uom: relationName(p.uom_id),
    url: recordUrl(identity.odoo_base_url, "product.product", p.id),
  }));
  return {
    toolName,
    status: rows.length > 1 ? "ambiguous" : "ok",
    records: rows,
    text: rows.length > 1
      ? `Encontré varios productos:\n${rows.map((r) => `• ${r.code || "s/c"} · ${r.product}`).join("\n")}`
      : `${lookup.interpretedAs ? `Interpreté “${args.product}” como “${lookup.interpretedAs}”.\n` : ""}${rows[0].product}: ${rows[0].onHand} en mano, ${rows[0].free} libres y ${rows[0].forecast} pronosticadas (${rows[0].uom}).\n${rows[0].url}`,
  };
}

async function queryPendingInvoices({ odoo, identity, limit, args, toolName }) {
  const invoiceState = args.invoice_state || "posted";
  const paymentFilter = args.payment_filter || "pending";
  const domain = [["move_type", "=", "out_invoice"]];
  if (invoiceState !== "all") domain.push(["state", "=", invoiceState]);
  if (paymentFilter === "pending") {
    if (invoiceState === "all") domain.push(["state", "=", "posted"]);
    domain.push(["payment_state", "not in", ["paid", "reversed"]]);
  } else if (paymentFilter === "paid") {
    domain.push(["payment_state", "=", "paid"]);
  }
  if (args.customer) domain.push(["partner_id.name", ...contains(args.customer)]);
  if (args.date_from) domain.push(["invoice_date", ">=", args.date_from]);
  if (args.date_to) domain.push(["invoice_date", "<=", args.date_to]);
  const invoices = await odoo.searchRead(
    "account.move", domain,
    ["name", "move_type", "state", "partner_id", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "currency_id", "payment_state", "company_id"],
    { limit: limit + 1, order: paymentFilter === "pending" ? "invoice_date_due asc, invoice_date desc" : "invoice_date desc, id desc" },
  );
  const rows = invoices.slice(0, limit).map((r) => ({
    id: r.id, number: r.name, customer: relationName(r.partner_id),
    date: r.invoice_date, due: r.invoice_date_due, total: r.amount_total,
    residual: r.amount_residual, currency: relationName(r.currency_id),
    state: r.state, paymentState: r.payment_state,
    invoiceStateLabel: accountingStateLabel(r.state),
    paymentStateLabel: paymentStateLabel(r.payment_state),
    company: relationName(r.company_id),
    url: recordUrl(identity.odoo_base_url, "account.move", r.id),
  }));
  const filterDescription = invoiceState === "posted"
    ? "publicadas"
    : invoiceState === "draft"
      ? "en borrador"
      : "registradas";
  const truncatedLine = invoices.length > limit
    ? `Mostrando las primeras ${limit} facturas ${filterDescription}.\n\n`
    : "";
  return {
    toolName,
    status: !rows.length ? "not_found" : invoices.length > limit ? "truncated" : "ok",
    records: rows,
    text: !rows.length
      ? `No encontré facturas de cliente ${filterDescription} con esos filtros.`
      : `${truncatedLine}${rows.map((r) =>
        `${r.number} · ${r.customer} · ${r.invoiceStateLabel}\nFecha: ${r.date || "sin fecha"} · Vence: ${r.due || "sin fecha"}\nTotal: ${r.total} ${r.currency} · Saldo: ${r.residual} ${r.currency} · Pago: ${r.paymentStateLabel}\n${r.url}`).join("\n\n")}`,
  };
}

export function summarizeToolForMemory(classification, result) {
  const first = result.records?.[0];
  const references = (result.records ?? []).slice(0, 10).map((record) => ({
    id: record.id,
    number: record.number,
    product: record.product,
    partner: record.partner || record.customer,
    date: record.date,
    state: record.state,
    total: record.total,
    currency: record.currency,
    invoice_status: record.invoiceStatus,
    invoice_count: record.invoiceCount,
  }));
  return {
    intent: classification.intent,
    parameters: classification.parameters,
    result_status: result.status,
    records: references,
    selected_record: first ? {
      id: first.id,
      number: first.number,
      product: first.product,
      partner: first.partner || first.customer,
      date: first.date,
    } : null,
  };
}
