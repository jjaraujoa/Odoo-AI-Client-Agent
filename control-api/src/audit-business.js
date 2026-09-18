export async function auditDataHygiene(odoo) {
  const issues = [];

  // 1. Clientes sin identificación fiscal
  try {
    const noVatPartners = await odoo.searchRead(
      "res.partner",
      [["customer_rank", ">", 0], "|", ["vat", "=", false], ["vat", "=", ""]],
      ["name", "email", "phone"],
      { limit: 10 },
    );
    if (noVatPartners.length > 0) {
      issues.push({
        code: "partners_missing_vat",
        category: "data_hygiene",
        severity: "warning",
        title: "Clientes sin Identificación Fiscal (NIT/RUT)",
        count: noVatPartners.length,
        items: noVatPartners.map((p) => ({ id: p.id, name: p.name })),
        recommendation: "Completar la identificación fiscal de estos clientes para evitar rechazos en facturación electrónica.",
      });
    }
  } catch {
    // Tolerancia ante modelos o campos no disponibles en ciertas versiones
  }

  // 2. Productos sin costo estándar
  try {
    const noCostProducts = await odoo.searchRead(
      "product.product",
      [["standard_price", "<=", 0], ["type", "!=", "service"]],
      ["name", "default_code", "standard_price"],
      { limit: 10 },
    );
    if (noCostProducts.length > 0) {
      issues.push({
        code: "products_missing_cost",
        category: "data_hygiene",
        severity: "warning",
        title: "Productos físicos sin Costo Estándar configurado",
        count: noCostProducts.length,
        items: noCostProducts.map((p) => ({ id: p.id, name: p.name, code: p.default_code })),
        recommendation: "Asignar costo de reposición a los productos para reflejar márgenes brutos reales en reportes de venta.",
      });
    }
  } catch {}

  // 3. Productos con stock negativo
  try {
    const negativeStock = await odoo.searchRead(
      "product.product",
      [["qty_available", "<", 0]],
      ["name", "default_code", "qty_available"],
      { limit: 10 },
    );
    if (negativeStock.length > 0) {
      issues.push({
        code: "negative_inventory",
        category: "data_hygiene",
        severity: "critical",
        title: "Productos con Inventario Negativo en Bodega",
        count: negativeStock.length,
        items: negativeStock.map((p) => ({ id: p.id, name: p.name, qty: p.qty_available })),
        recommendation: "Realizar inventario físico o ajuste de existencias para corregir desfases antes del cierre de mes.",
      });
    }
  } catch {}

  // 4. Cotizaciones abandonadas (> 30 días en borrador)
  try {
    const date30DaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const abandonedOrders = await odoo.searchRead(
      "sale.order",
      [["state", "=", "draft"], ["create_date", "<", date30DaysAgo]],
      ["name", "partner_id", "create_date", "amount_total"],
      { limit: 10 },
    );
    if (abandonedOrders.length > 0) {
      issues.push({
        code: "abandoned_quotations",
        category: "data_hygiene",
        severity: "info",
        title: "Cotizaciones en Borrador Abandonadas (> 30 días)",
        count: abandonedOrders.length,
        items: abandonedOrders.map((o) => ({ id: o.id, name: o.name, date: o.create_date })),
        recommendation: "Cancelar o archivar cotizaciones obsoletas para limpiar el embudo comercial.",
      });
    }
  } catch {}

  return issues;
}

export async function auditBottlenecks(odoo) {
  const issues = [];

  // 1. Órdenes confirmadas pendientes de entrega o facturación (> 2 días)
  try {
    const date2DaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const delayedSales = await odoo.searchRead(
      "sale.order",
      [["state", "=", "sale"], ["invoice_status", "=", "to invoice"], ["date_order", "<", date2DaysAgo]],
      ["name", "partner_id", "date_order", "amount_total"],
      { limit: 10 },
    );
    if (delayedSales.length > 0) {
      issues.push({
        code: "sales_pending_invoice",
        category: "sla_bottlenecks",
        severity: "warning",
        title: "Órdenes de Venta Confirmadas sin Facturar (> 48h)",
        count: delayedSales.length,
        items: delayedSales.map((s) => ({ id: s.id, name: s.name, total: s.amount_total })),
        recommendation: "Verificar si las entregas ya ocurrieron y generar las facturas para no demorar la cartera.",
      });
    }
  } catch {}

  // 2. Albaranes de almacén retrasados frente a fecha programada
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const delayedPickings = await odoo.searchRead(
      "stock.picking",
      [["state", "in", ["confirmed", "assigned"]], ["scheduled_date", "<", todayStr]],
      ["name", "scheduled_date", "partner_id"],
      { limit: 10 },
    );
    if (delayedPickings.length > 0) {
      issues.push({
        code: "delayed_stock_pickings",
        category: "sla_bottlenecks",
        severity: "critical",
        title: "Movimientos de Inventario Retrasados vs Fecha Programada",
        count: delayedPickings.length,
        items: delayedPickings.map((p) => ({ id: p.id, name: p.name, date: p.scheduled_date })),
        recommendation: "Revisar con bodega si la mercancía está retenida o si faltan insumos para despachar.",
      });
    }
  } catch {}

  return issues;
}

export function formatBusinessAuditReport(findings, clientName) {
  const timestamp = new Date().toLocaleDateString("es-CO", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const header = `📊 *Informe de Auditoría Operativa y de Negocio*\n🏢 *${clientName}* | _${timestamp}_\n`;

  if (!findings || findings.length === 0) {
    return `${header}\n✅ *Excelente estado operativo*: No se detectaron anomalías de higiene de datos ni cuellos de botella en los procesos analizados.`;
  }

  const sections = [];
  for (const item of findings) {
    const icon = item.severity === "critical" ? "🚨" : item.severity === "warning" ? "⚠️" : "ℹ️";
    const lines = [
      `${icon} *${item.title}* (${item.count}):`,
      `• *Diagnóstico*: Se detectaron ${item.count} registros con esta condición.`,
      `• *Recomendación*: ${item.recommendation}`,
    ];
    sections.push(lines.join("\n"));
  }

  return `${header}\n${sections.join("\n\n")}\n\n_Auditoría ejecutada por Agente de Negocio Odoo AI._`;
}

export async function runFullBusinessAudit({
  db,
  config,
  odoo,
  client,
  clientId,
  reportType = "operational_health",
}) {
  const cId = typeof client === "string" ? client : (client?.id || clientId);
  const cName = client?.name || "la empresa";
  const cSlug = client?.slug || "empresa";

  const dataHygieneIssues = await auditDataHygiene(odoo);
  const bottleneckIssues = await auditBottlenecks(odoo);

  const allFindings = [...dataHygieneIssues, ...bottleneckIssues];

  // Calcular severidad global
  let severity = "info";
  if (allFindings.some((f) => f.severity === "critical")) {
    severity = "critical";
  } else if (allFindings.some((f) => f.severity === "warning")) {
    severity = "warning";
  }

  const summaryText = formatBusinessAuditReport(allFindings, cName);

  // Registrar en base de datos
  const res = await db.query(
    `INSERT INTO agent.business_audit_reports
       (client_id, report_type, summary, findings, severity)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [cId, reportType, summaryText, JSON.stringify(allFindings), severity],
  );

  return {
    report_id: res.rows[0].id,
    client_slug: cSlug,
    severity,
    findings_count: allFindings.length,
    findings: allFindings,
    text: summaryText,
  };
}
