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

export async function registerInvoicePayment(odoo, {
  invoiceId,
  moveId,
  amount,
  journalId,
  paymentDate = null,
  paymentMethodLineId = null,
}) {
  const move = Number(invoiceId || moveId);
  const payAmount = Number(amount);
  const journal = Number(journalId);
  if (!Number.isInteger(move) || move <= 0) {
    throw new AppError(400, "invalid_move_id", "El ID de la factura (invoiceId/moveId) es requerido y debe ser entero positivo.");
  }
  if (isNaN(payAmount) || payAmount <= 0) {
    throw new AppError(400, "invalid_amount", "El monto del pago debe ser mayor a cero.");
  }
  if (!Number.isInteger(journal) || journal <= 0) {
    throw new AppError(400, "invalid_journal_id", "El ID del diario de banco/caja (journalId) es requerido.");
  }

  const context = {
    active_model: "account.move",
    active_id: move,
    active_ids: [move],
    ...DEFAULT_CONTEXT,
  };

  const values = {
    amount: payAmount,
    journal_id: journal,
    group_payment: true,
    ...(paymentDate ? { payment_date: String(paymentDate) } : {}),
    ...(paymentMethodLineId ? { payment_method_line_id: Number(paymentMethodLineId) } : {}),
  };

  const created = await odoo.create("account.payment.register", values, context);
  const wizardId = extractRecordId(created);

  await odoo.call("account.payment.register", "action_create_payments", {
    ids: [wizardId],
    context,
  });

  return {
    success: true,
    model: "account.move",
    record_id: move,
    wizard_id: wizardId,
    summary: `Pago registrado exitosamente por $${payAmount} para la factura #${move}.`,
  };
}

export async function createSaleAdvancePayment(odoo, {
  saleOrderId,
  orderId,
  percentage = null,
  amount = null,
  advancePaymentMethod = "percentage",
}) {
  const order = Number(saleOrderId || orderId);
  if (!Number.isInteger(order) || order <= 0) {
    throw new AppError(400, "invalid_order_id", "El ID del pedido de venta (saleOrderId/orderId) es requerido.");
  }

  const context = {
    active_model: "sale.order",
    active_id: order,
    active_ids: [order],
    ...DEFAULT_CONTEXT,
  };

  const values = {
    advance_payment_method: advancePaymentMethod,
  };

  if (advancePaymentMethod === "percentage") {
    const pct = Number(percentage ?? amount);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      throw new AppError(400, "invalid_percentage", "El porcentaje de anticipo debe ser entre 0.01 y 100.");
    }
    values.amount = pct;
  } else {
    const fixed = Number(amount ?? percentage);
    if (isNaN(fixed) || fixed <= 0) {
      throw new AppError(400, "invalid_amount", "El importe fijo del anticipo debe ser mayor a cero.");
    }
    values.fixed_amount = fixed;
  }

  const created = await odoo.create("sale.advance.payment.inv", values, context);
  const wizardId = extractRecordId(created);

  await odoo.call("sale.advance.payment.inv", "create_invoices", {
    ids: [wizardId],
    context,
  });

  return {
    success: true,
    model: "sale.order",
    record_id: order,
    wizard_id: wizardId,
    summary: `Factura de anticipo creada para la orden #${order}.`,
  };
}

export async function createCreditNote(odoo, {
  moveId,
  reason = "",
  date = null,
  journalId = null,
}) {
  const move = Number(moveId);
  if (!Number.isInteger(move) || move <= 0) {
    throw new AppError(400, "invalid_move_id", "El ID de la factura (moveId) es requerido.");
  }

  const context = {
    active_model: "account.move",
    active_id: move,
    active_ids: [move],
    ...DEFAULT_CONTEXT,
  };

  const values = {
    ...(reason ? { reason: String(reason).slice(0, 200) } : {}),
    ...(date ? { date: String(date) } : {}),
    ...(journalId ? { journal_id: Number(journalId) } : {}),
  };

  const created = await odoo.create("account.move.reversal", values, context);
  const wizardId = extractRecordId(created);

  await odoo.call("account.move.reversal", "reverse_moves", {
    ids: [wizardId],
    context,
  });

  return {
    success: true,
    model: "account.move",
    record_id: move,
    wizard_id: wizardId,
    summary: `Nota de crédito rectificativa creada exitosamente para la factura #${move}.`,
  };
}

export async function convertCrmLead(odoo, {
  leadId,
  action = "create",
  partnerId = null,
  userId = null,
  teamId = null,
}) {
  const lead = Number(leadId);
  if (!Number.isInteger(lead) || lead <= 0) {
    throw new AppError(400, "invalid_lead_id", "El ID de la iniciativa (leadId) es requerido.");
  }
  const partner = partnerId ? Number(partnerId) : null;
  if (action === "exist" && (!Number.isInteger(partner) || partner <= 0)) {
    throw new AppError(400, "invalid_partner_id", "El ID del contacto/cliente (partnerId) es requerido cuando action es 'exist'.");
  }

  const context = {
    active_model: "crm.lead",
    active_id: lead,
    active_ids: [lead],
    ...DEFAULT_CONTEXT,
  };

  const values = {
    name: "convert",
    action: action,
    ...(partner ? { partner_id: partner } : {}),
    force_assignment: true,
    ...(userId ? { user_id: Number(userId) } : {}),
    ...(teamId ? { team_id: Number(teamId) } : {}),
  };

  const created = await odoo.create("crm.lead2opportunity.partner", values, context);
  const wizardId = extractRecordId(created);

  await odoo.call("crm.lead2opportunity.partner", "action_apply", {
    ids: [wizardId],
    context,
  });

  return {
    success: true,
    model: "crm.lead",
    record_id: lead,
    wizard_id: wizardId,
    summary: `Iniciativa #${lead} convertida a oportunidad exitosamente.`,
  };
}

export async function markCrmLeadLost(odoo, {
  leadId,
  lostReasonId,
}) {
  const lead = Number(leadId);
  const reason = Number(lostReasonId);
  if (!Number.isInteger(lead) || lead <= 0) {
    throw new AppError(400, "invalid_lead_id", "El ID de la oportunidad (leadId) es requerido.");
  }
  if (!Number.isInteger(reason) || reason <= 0) {
    throw new AppError(400, "invalid_reason_id", "El ID del motivo de pérdida (lostReasonId) es requerido.");
  }

  const context = {
    active_model: "crm.lead",
    active_id: lead,
    active_ids: [lead],
    ...DEFAULT_CONTEXT,
  };

  const values = {
    lead_ids: [[6, 0, [lead]]],
    lost_reason_id: reason,
  };

  const created = await odoo.create("crm.lead.lost", values, context);
  const wizardId = extractRecordId(created);

  await odoo.call("crm.lead.lost", "action_lost_reason_apply", {
    ids: [wizardId],
    context,
  });

  return {
    success: true,
    model: "crm.lead",
    record_id: lead,
    wizard_id: wizardId,
    summary: `Oportunidad #${lead} marcada como perdida con motivo #${reason}.`,
  };
}

export async function cancelSaleOrder(odoo, { resId }) {
  const id = Number(resId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, "invalid_res_id", "El ID de la orden de venta es inválido.");
  }

  await odoo.call("sale.order", "action_cancel", {
    ids: [id],
    context: DEFAULT_CONTEXT,
  });

  return {
    success: true,
    model: "sale.order",
    record_id: id,
    summary: `Orden de venta #${id} cancelada exitosamente.`,
  };
}

export async function cancelInvoice(odoo, { resId }) {
  const id = Number(resId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, "invalid_res_id", "El ID de la factura es inválido.");
  }

  await odoo.call("account.move", "button_cancel", {
    ids: [id],
    context: DEFAULT_CONTEXT,
  });

  return {
    success: true,
    model: "account.move",
    record_id: id,
    summary: `Factura o apunte contable #${id} cancelado exitosamente.`,
  };
}

export async function cancelStockPicking(odoo, { resId }) {
  const id = Number(resId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(400, "invalid_res_id", "El ID del albarán es inválido.");
  }

  await odoo.call("stock.picking", "action_cancel", {
    ids: [id],
    context: DEFAULT_CONTEXT,
  });

  return {
    success: true,
    model: "stock.picking",
    record_id: id,
    summary: `Albarán de inventario #${id} cancelado exitosamente.`,
  };
}

export const OPERATIONAL_ACTIONS = Object.freeze({
  crear_borrador_orden_venta: createDraftSaleOrder,
  crear_borrador_factura_cliente: createDraftCustomerInvoice,
  asignar_responsable: assignResponsibleUser,
  cambiar_etapa_registro: changeRecordStage,
  confirmar_orden_venta: confirmSaleOrder,
  validar_albaran_entrega: validateStockPicking,
  registrar_pago_factura: registerInvoicePayment,
  crear_anticipo_venta: createSaleAdvancePayment,
  crear_nota_credito: createCreditNote,
  convertir_iniciativa_crm: convertCrmLead,
  perder_oportunidad_crm: markCrmLeadLost,
  cancelar_orden_venta: cancelSaleOrder,
  cancelar_factura: cancelInvoice,
  cancelar_albaran_entrega: cancelStockPicking,
});

export async function executeOperationalAction(actionName, odoo, params) {
  const handler = OPERATIONAL_ACTIONS[actionName];
  if (!handler) {
    throw new AppError(400, "unknown_operational_action", `Acción operativa desconocida: ${actionName}`);
  }
  return handler(odoo, params);
}
