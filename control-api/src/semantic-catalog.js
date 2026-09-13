import { AppError } from "./errors.js";

const COMMON_TEXT_OPERATORS = ["equals", "not_equals", "contains", "in"];
const COMMON_ORDER_OPERATORS = ["equals", "not_equals", "contains", "in"];
const COMMON_NUMBER_OPERATORS = ["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "in"];
const COMMON_DATE_OPERATORS = ["equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "in"];

const field = (label, source, type, operators, extra = {}) => Object.freeze({
  label, source, type, operators: Object.freeze(operators), ...extra,
});

export const SEMANTIC_CATALOG_VERSION = "read-semantic-catalog/1";

export const SEMANTIC_ENTITIES = Object.freeze({
  ordenes_venta: Object.freeze({
    key: "ordenes_venta",
    label: "órdenes de venta",
    description: "Cotizaciones y órdenes de venta de clientes.",
    model: "sale.order",
    toolName: "consultar_orden_venta",
    defaultFields: ["numero", "cliente", "fecha", "estado", "total", "moneda", "estado_facturacion", "facturas_relacionadas"],
    defaultSort: [{ field: "fecha", direction: "desc" }],
    searchFields: ["numero", "cliente"],
    baseDomain: [],
    fields: Object.freeze({
      numero: field("Número", "name", "string", COMMON_ORDER_OPERATORS, { identifier: true }),
      cliente: field("Cliente", "partner_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "partner_id.name" }),
      fecha: field("Fecha", "date_order", "datetime", COMMON_DATE_OPERATORS),
      estado: field("Estado", "state", "string", COMMON_TEXT_OPERATORS, {
        labels: { draft: "Cotización", sent: "Cotización enviada", sale: "Orden de venta", done: "Bloqueada", cancel: "Cancelada" },
      }),
      total: field("Total", "amount_total", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true, currencyField: "moneda" }),
      moneda: field("Moneda", "currency_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "currency_id.name" }),
      comercial: field("Comercial", "user_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "user_id.name" }),
      compania: field("Compañía", "company_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "company_id.name" }),
      estado_facturacion: field("Estado de facturación", "invoice_status", "string", COMMON_TEXT_OPERATORS, {
        labels: { invoiced: "Facturada", "to invoice": "Pendiente de facturar", no: "Nada que facturar", upselling: "Pendiente por venta adicional" },
      }),
      facturas_relacionadas: field("Facturas relacionadas", "invoice_ids", "relation_list", ["equals", "greater_than", "greater_or_equal"], { dependencyValues: true }),
    }),
  }),
  ordenes_compra: Object.freeze({
    key: "ordenes_compra",
    label: "órdenes de compra",
    description: "Solicitudes de presupuesto y órdenes de compra a proveedores.",
    model: "purchase.order",
    toolName: "consultar_orden_compra",
    defaultFields: ["numero", "proveedor", "fecha", "estado", "total", "moneda", "estado_facturacion", "facturas_relacionadas"],
    defaultSort: [{ field: "fecha", direction: "desc" }],
    searchFields: ["numero", "proveedor"],
    baseDomain: [],
    fields: Object.freeze({
      numero: field("Número", "name", "string", COMMON_ORDER_OPERATORS, { identifier: true }),
      proveedor: field("Proveedor", "partner_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "partner_id.name" }),
      fecha: field("Fecha", "date_order", "datetime", COMMON_DATE_OPERATORS),
      estado: field("Estado", "state", "string", COMMON_TEXT_OPERATORS, {
        labels: { draft: "Solicitud de presupuesto", sent: "Solicitud enviada", to_approve: "Por aprobar", purchase: "Orden de compra", done: "Bloqueada", cancel: "Cancelada" },
      }),
      total: field("Total", "amount_total", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true, currencyField: "moneda" }),
      moneda: field("Moneda", "currency_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "currency_id.name" }),
      responsable: field("Responsable", "user_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "user_id.name" }),
      compania: field("Compañía", "company_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "company_id.name" }),
      estado_facturacion: field("Estado de facturación", "invoice_status", "string", COMMON_TEXT_OPERATORS, {
        labels: { invoiced: "Facturada", "to invoice": "Pendiente de facturar", no: "Nada que facturar" },
      }),
      facturas_relacionadas: field("Facturas relacionadas", "invoice_ids", "relation_list", ["equals", "greater_than", "greater_or_equal"], { dependencyValues: true }),
    }),
  }),
  facturas_cliente: Object.freeze({
    key: "facturas_cliente",
    label: "facturas de cliente",
    description: "Facturas emitidas a clientes, por estado contable y estado de pago.",
    model: "account.move",
    toolName: "consultar_facturas_pendientes",
    defaultFields: ["numero", "cliente", "fecha", "vencimiento", "estado", "estado_pago", "total", "saldo", "moneda"],
    defaultSort: [{ field: "fecha", direction: "desc" }],
    searchFields: ["numero", "cliente"],
    baseDomain: [["move_type", "=", "out_invoice"]],
    fields: Object.freeze({
      numero: field("Número", "name", "string", COMMON_ORDER_OPERATORS, { identifier: true }),
      cliente: field("Cliente", "partner_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "partner_id.name" }),
      fecha: field("Fecha", "invoice_date", "date", COMMON_DATE_OPERATORS),
      vencimiento: field("Vencimiento", "invoice_date_due", "date", COMMON_DATE_OPERATORS),
      estado: field("Estado contable", "state", "string", COMMON_TEXT_OPERATORS, {
        labels: { posted: "Publicada", draft: "Borrador", cancel: "Cancelada" },
        valueAliases: { publicada: "posted", publicadas: "posted", borrador: "draft", borradores: "draft", cancelada: "cancel" },
      }),
      estado_pago: field("Estado de pago", "payment_state", "string", COMMON_TEXT_OPERATORS, {
        labels: { paid: "Pagada", not_paid: "No pagada", in_payment: "En proceso de pago", partial: "Pago parcial", reversed: "Revertida", invoicing_legacy: "Sistema anterior" },
        valueAliases: { pagada: "paid", pagadas: "paid", pendiente: "not_paid", pendientes: "not_paid", "no pagada": "not_paid", parcial: "partial" },
      }),
      total: field("Total", "amount_total", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true, currencyField: "moneda" }),
      saldo: field("Saldo pendiente", "amount_residual", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true, currencyField: "moneda" }),
      moneda: field("Moneda", "currency_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "currency_id.name" }),
      compania: field("Compañía", "company_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "company_id.name" }),
      registro_relacionado: field("Registro relacionado de un paso anterior", "id", "number", ["in"], { selectable: false, dependencyOnly: true }),
    }),
  }),
  productos: Object.freeze({
    key: "productos",
    label: "productos y precios",
    description: "Productos visibles, referencias internas, precio de venta y unidad de medida.",
    model: "product.product",
    toolName: "consultar_precio_producto",
    defaultFields: ["nombre", "referencia", "precio", "moneda", "unidad"],
    defaultSort: [{ field: "nombre", direction: "asc" }],
    searchFields: ["nombre", "referencia"],
    baseDomain: [],
    fields: Object.freeze({
      nombre: field("Producto", "display_name", "string", COMMON_TEXT_OPERATORS, { identifier: true, filterSource: "name" }),
      referencia: field("Referencia interna", "default_code", "string", COMMON_TEXT_OPERATORS),
      precio: field("Precio de venta", "lst_price", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true, currencyField: "moneda" }),
      moneda: field("Moneda", "currency_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "currency_id.name" }),
      unidad: field("Unidad de medida", "uom_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "uom_id.name" }),
      cliente: field("Cliente para lista de precios", null, "virtual", ["equals", "contains"], { filterOnly: true, contextResolver: "customer_pricelist" }),
    }),
  }),
  inventario: Object.freeze({
    key: "inventario",
    label: "inventario de productos",
    description: "Existencias en mano, libres y pronosticadas por producto y almacén opcional.",
    model: "product.product",
    toolName: "consultar_inventario",
    defaultFields: ["nombre", "referencia", "en_mano", "libres", "pronosticadas", "unidad"],
    defaultSort: [{ field: "nombre", direction: "asc" }],
    searchFields: ["nombre", "referencia"],
    baseDomain: [],
    fields: Object.freeze({
      nombre: field("Producto", "display_name", "string", COMMON_TEXT_OPERATORS, { identifier: true, filterSource: "name" }),
      referencia: field("Referencia interna", "default_code", "string", COMMON_TEXT_OPERATORS),
      en_mano: field("Cantidad en mano", "qty_available", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true }),
      libres: field("Cantidad libre", "free_qty", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true }),
      pronosticadas: field("Cantidad pronosticada", "virtual_available", "number", COMMON_NUMBER_OPERATORS, { aggregatable: true }),
      unidad: field("Unidad de medida", "uom_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "uom_id.name" }),
      almacen: field("Almacén", null, "virtual", ["equals", "contains"], { filterOnly: true, contextResolver: "warehouse" }),
    }),
  }),
  clientes: Object.freeze({
    key: "clientes",
    label: "clientes",
    description: "Contactos marcados como clientes y sus datos empresariales básicos.",
    model: "res.partner",
    toolName: "consultar_clientes",
    defaultFields: ["nombre", "identificacion", "correo", "telefono", "ciudad", "pais", "tipo", "activo"],
    defaultSort: [{ field: "nombre", direction: "asc" }],
    searchFields: ["nombre", "identificacion", "correo", "telefono"],
    baseDomain: [["customer_rank", ">", 0]],
    fields: Object.freeze({
      nombre: field("Cliente", "name", "string", COMMON_TEXT_OPERATORS, { identifier: true }),
      identificacion: field("Identificación fiscal", "vat", "string", COMMON_TEXT_OPERATORS),
      correo: field("Correo", "email", "string", COMMON_TEXT_OPERATORS),
      telefono: field("Teléfono", "phone", "string", COMMON_TEXT_OPERATORS),
      movil: field("Móvil", "mobile", "string", COMMON_TEXT_OPERATORS),
      ciudad: field("Ciudad", "city", "string", COMMON_TEXT_OPERATORS),
      pais: field("País", "country_id", "relation", COMMON_TEXT_OPERATORS, { filterSource: "country_id.name" }),
      tipo: field("Tipo", "company_type", "string", COMMON_TEXT_OPERATORS, { labels: { company: "Empresa", person: "Persona" } }),
      activo: field("Activo", "active", "boolean", ["equals", "not_equals"]),
    }),
  }),
});

export const SEMANTIC_ENTITY_KEYS = Object.freeze(Object.keys(SEMANTIC_ENTITIES));

function safeSettings(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function readPlannerMode(identity) {
  const value = safeSettings(identity?.client_settings).read_planner_mode;
  return ["legacy", "shadow", "active"].includes(value) ? value : "legacy";
}

export async function loadSemanticCatalog(db, clientId) {
  const result = await db.query(
    `SELECT entity_key, enabled, settings, catalog_version
       FROM agent.semantic_entities
      WHERE client_id = $1 AND enabled
      ORDER BY entity_key`,
    [clientId],
  );
  const enabled = new Map(result.rows.map((row) => [row.entity_key, row]));
  const catalog = {};
  for (const key of SEMANTIC_ENTITY_KEYS) {
    if (!enabled.has(key)) continue;
    catalog[key] = {
      ...SEMANTIC_ENTITIES[key],
      clientSettings: safeSettings(enabled.get(key).settings),
      catalogVersion: enabled.get(key).catalog_version || SEMANTIC_CATALOG_VERSION,
    };
  }
  if (!Object.keys(catalog).length) {
    throw new AppError(403, "semantic_catalog_empty", "No hay entidades de lectura habilitadas para este cliente.");
  }
  return Object.freeze(catalog);
}

export function catalogForPlanner(catalog) {
  return Object.values(catalog).map((entity) => ({
    entity: entity.key,
    description: entity.description,
    fields: Object.entries(entity.fields).map(([key, definition]) => ({
      field: key,
      description: definition.label,
      type: definition.type,
      filterable: definition.operators.length > 0,
      operators: definition.operators,
      filter_only: Boolean(definition.filterOnly || definition.selectable === false),
      aggregatable: Boolean(definition.aggregatable),
    })),
    defaults: {
      fields: entity.defaultFields,
      sort: entity.defaultSort,
      limit: 10,
    },
  }));
}

export function requireSemanticEntity(catalog, key) {
  const entity = catalog[key];
  if (!entity) {
    throw new AppError(403, "semantic_entity_disabled", "La entidad solicitada no está habilitada para este cliente.");
  }
  return entity;
}
