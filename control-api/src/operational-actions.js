import { AppError } from "./errors.js";

const DEFAULT_CONTEXT = Object.freeze({
  tracking_source: "ai_agent",
  mail_create_nosubscribe: true,
});

function extractRecordId(created) {
  if (Array.isArray(created)) {
    const first = created[0];
    if (typeof first === "object" && first !== null) {
      return Number(first.id);
    }
    return Number(first);
  }
  if (typeof created === "object" && created !== null) {
    return Number(created.id);
  }
  return Number(created);
}

export async function createDraftSaleOrder(odoo, {
  partnerId,
  orderLines = [],
  note = "",
  paymentTermId = null,
}) {
  const partner = Number(partnerId);
  if (!Number.isInteger(partner) || partner <= 0) {
    throw new AppError(400, "invalid_partner_id", "El partnerId del cliente es requerido y debe ser un entero.");
  }
  if (!Array.isArray(orderLines) || orderLines.length === 0) {
    throw new AppError(400, "empty_order_lines", "Debe incluir al menos una línea de pedido.");
  }

  const values = {
    partner_id: partner,
    state: "draft",
    note: String(note || ""),
    ...(paymentTermId ? { payment_term_id: Number(paymentTermId) } : {}),
    order_line: orderLines.map((line) => [0, 0, {
      product_id: Number(line.productId || line.product_id),
      product_uom_qty: Number(line.quantity || line.product_uom_qty || 1),
      price_unit: Number(line.priceUnit || line.price_unit || 0),
      name: String(line.name || line.description || "Línea de producto"),
      ...(line.discount !== undefined ? { discount: Number(line.discount) } : {}),
    }]),
  };

  const created = await odoo.create("sale.order", values, DEFAULT_CONTEXT);
  const orderId = extractRecordId(created);

  return {
    success: true,
    model: "sale.order",
    record_id: orderId,
    summary: `Cotización de venta borrador creada exitosamente (#${orderId}).`,
  };
}

export async function createDraftCustomerInvoice(odoo, {
  partnerId,
  invoiceDate = null,
  invoiceLines = [],
  ref = "",
}) {
  const partner = Number(partnerId);
  if (!Number.isInteger(partner) || partner <= 0) {
    throw new AppError(400, "invalid_partner_id", "El partnerId del cliente es requerido y debe ser un entero.");
  }
  if (!Array.isArray(invoiceLines) || invoiceLines.length === 0) {
    throw new AppError(400, "empty_invoice_lines", "Debe incluir al menos una línea de factura.");
  }

  const values = {
    move_type: "out_invoice",
    partner_id: partner,
    state: "draft",
    ref: String(ref || ""),
    ...(invoiceDate ? { invoice_date: invoiceDate } : {}),
    invoice_line_ids: invoiceLines.map((line) => [0, 0, {
      product_id: Number(line.productId || line.product_id),
      quantity: Number(line.quantity || 1),
      price_unit: Number(line.priceUnit || line.price_unit || 0),
      name: String(line.name || line.description || "Línea de servicio o producto"),
    }]),
  };

  const created = await odoo.create("account.move", values, DEFAULT_CONTEXT);
  const moveId = extractRecordId(created);

  return {
    success: true,
    model: "account.move",
    record_id: moveId,
    summary: `Factura de cliente borrador creada exitosamente (#${moveId}).`,
  };
}

export async function assignResponsibleUser(odoo, {
  model,
  resId,
  userId,
}) {
  const id = Number(resId);
  const user = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, "invalid_res_id", "El ID del registro a reasignar es inválido.");
  }
  if (!Number.isInteger(user) || user <= 0) {
    throw new AppError(400, "invalid_user_id", "El ID del usuario responsable es inválido.");
  }
  if (!["sale.order", "purchase.order", "stock.picking", "account.move", "crm.lead"].includes(model)) {
    throw new AppError(400, "unsupported_model", `El modelo ${model} no admite asignación directa.`);
  }

  await odoo.write(model, id, { user_id: user }, DEFAULT_CONTEXT);

  return {
    success: true,
    model,
    record_id: id,
    summary: `Usuario responsable asignado (#${user}) en ${model} #${id}.`,
  };
}

export async function changeRecordStage(odoo, {
  model,
  resId,
  stageId = null,
  state = null,
}) {
  const id = Number(resId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, "invalid_res_id", "El ID del registro es inválido.");
  }
  const vals = {};
  if (stageId) vals.stage_id = Number(stageId);
  if (state) vals.state = String(state);

  if (Object.keys(vals).length === 0) {
    throw new AppError(400, "missing_stage_or_state", "Debe proporcionar stageId o state.");
  }

  await odoo.write(model, id, vals, DEFAULT_CONTEXT);

  return {
    success: true,
    model,
    record_id: id,
    summary: `Estado o etapa actualizada en ${model} #${id}.`,
  };
}

export async function confirmSaleOrder(odoo, { resId }) {
  const id = Number(resId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, "invalid_res_id", "El ID de la orden de venta es inválido.");
  }

  await odoo.call("sale.order", "action_confirm", {
    ids: [id],
    context: DEFAULT_CONTEXT,
  });

  return {
    success: true,
    model: "sale.order",
    record_id: id,
    summary: `Orden de venta confirmada exitosamente (#${id}).`,
  };
}

export async function validateStockPicking(odoo, { resId }) {
  const id = Number(resId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, "invalid_res_id", "El ID del albarán es inválido.");
  }

  await odoo.call("stock.picking", "button_validate", {
    ids: [id],
    context: DEFAULT_CONTEXT,
  });

  return {
    success: true,
    model: "stock.picking",
    record_id: id,
    summary: `Albarán de inventario validado exitosamente (#${id}).`,
  };
}

export const OPERATIONAL_ACTIONS = Object.freeze({
  crear_borrador_orden_venta: createDraftSaleOrder,
  crear_borrador_factura_cliente: createDraftCustomerInvoice,
  asignar_responsable: assignResponsibleUser,
  cambiar_etapa_registro: changeRecordStage,
  confirmar_orden_venta: confirmSaleOrder,
  validar_albaran_entrega: validateStockPicking,
});

export async function executeOperationalAction(actionName, odoo, params) {
  const handler = OPERATIONAL_ACTIONS[actionName];
  if (!handler) {
    throw new AppError(400, "unknown_operational_action", `Acción operativa desconocida: ${actionName}`);
  }
  return handler(odoo, params);
}
