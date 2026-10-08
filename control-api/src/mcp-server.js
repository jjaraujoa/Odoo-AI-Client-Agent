import { createInterface } from "node:readline";
import { requestOrExecuteAction, confirmOperationalAction } from "./governance.js";
import { answerSopQuery } from "./sops.js";
import { runFullBusinessAudit, inspectStudioFields } from "./audit-business.js";
import { inspectDashboard, validateSpreadsheetDefinition, createOrUpdateDashboard } from "./spreadsheet.js";

export const MCP_TOOLS = [
  {
    name: "consultar_orden_venta",
    description: "Consulta órdenes de venta y cotizaciones en Odoo 19 por cliente, estado o fecha.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "array", description: "Filtros de dominio de Odoo, ej. [['state', '=', 'sale']]" },
        fields: { type: "array", items: { type: "string" }, description: "Campos a recuperar" },
        limit: { type: "integer", default: 10 },
      },
    },
  },
  {
    name: "consultar_orden_compra",
    description: "Consulta pedidos de compra a proveedores en Odoo 19.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "array", description: "Filtros de dominio de Odoo" },
        fields: { type: "array", items: { type: "string" } },
        limit: { type: "integer", default: 10 },
      },
    },
  },
  {
    name: "consultar_precio_producto",
    description: "Consulta productos, referencias internas y precios de venta vigentes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nombre o referencia interna del producto" },
        limit: { type: "integer", default: 5 },
      },
    },
  },
  {
    name: "consultar_inventario",
    description: "Consulta existencias a mano, libres y pronosticadas por producto.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "integer", description: "ID del producto en Odoo" },
        warehouse: { type: "string", description: "Almacén opcional" },
      },
    },
  },
  {
    name: "consultar_facturas_pendientes",
    description: "Consulta facturas de clientes, saldos pendientes y estados de pago.",
    inputSchema: {
      type: "object",
      properties: {
        partner_id: { type: "integer", description: "ID del cliente" },
        payment_state: { type: "string", description: "not_paid, paid, etc." },
        limit: { type: "integer", default: 10 },
      },
    },
  },
  {
    name: "consultar_clientes",
    description: "Consulta contactos y datos empresariales de clientes en Odoo.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nombre o NIT del cliente" },
        limit: { type: "integer", default: 5 },
      },
    },
  },
  {
    name: "consultar_oportunidades_crm",
    description: "Consulta iniciativas y oportunidades del CRM en Odoo 19 por cliente, etapa o ingreso esperado.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "array", description: "Filtros de dominio de Odoo, ej. [['stage_id', '=', 1]]" },
        fields: { type: "array", items: { type: "string" }, description: "Campos a recuperar" },
        limit: { type: "integer", default: 10 },
      },
    },
  },
  {
    name: "crear_borrador_orden_venta",
    description: "Crea una nueva cotización / orden de venta en estado borrador (Nivel 1 - Autónomo).",
    inputSchema: {
      type: "object",
      required: ["partnerId", "orderLines"],
      properties: {
        partnerId: { type: "integer", description: "ID del cliente en Odoo" },
        orderLines: {
          type: "array",
          items: {
            type: "object",
            required: ["productId", "quantity", "priceUnit"],
            properties: {
              productId: { type: "integer" },
              quantity: { type: "number" },
              priceUnit: { type: "number" },
              discount: { type: "number", description: "Porcentaje de descuento (ej. 10 para 10%)" },
              name: { type: "string" },
            },
          },
        },
        note: { type: "string" },
      },
    },
  },
  {
    name: "crear_borrador_factura_cliente",
    description: "Crea una factura de cliente en estado borrador (Nivel 1 - Autónomo).",
    inputSchema: {
      type: "object",
      required: ["partnerId", "invoiceLines"],
      properties: {
        partnerId: { type: "integer", description: "ID del cliente" },
        invoiceDate: { type: "string", description: "YYYY-MM-DD" },
        invoiceLines: {
          type: "array",
          items: {
            type: "object",
            required: ["productId", "quantity", "priceUnit"],
            properties: {
              productId: { type: "integer" },
              quantity: { type: "number" },
              priceUnit: { type: "number" },
              name: { type: "string" },
            },
          },
        },
        ref: { type: "string" },
      },
    },
  },
  {
    name: "asignar_responsable",
    description: "Asigna un usuario responsable a un documento en Odoo (Nivel 1 - Autónomo).",
    inputSchema: {
      type: "object",
      required: ["model", "resId", "userId"],
      properties: {
        model: { type: "string" },
        resId: { type: "integer" },
        userId: { type: "integer" },
      },
    },
  },
  {
    name: "cambiar_etapa_registro",
    description: "Actualiza el estado o etapa de un registro (Nivel 2 - Asistido con aviso).",
    inputSchema: {
      type: "object",
      required: ["model", "resId"],
      properties: {
        model: { type: "string" },
        resId: { type: "integer" },
        stageId: { type: "integer" },
        state: { type: "string" },
      },
    },
  },
  {
    name: "confirmar_orden_venta",
    description: "Confirma una orden de venta en Odoo (Nivel 3 - Requiere aprobación interactiva).",
    inputSchema: {
      type: "object",
      required: ["resId"],
      properties: {
        resId: { type: "integer", description: "ID de la orden de venta" },
      },
    },
  },
  {
    name: "validar_albaran_entrega",
    description: "Valida un albarán de inventario en Odoo (Nivel 3 - Requiere aprobación interactiva).",
    inputSchema: {
      type: "object",
      required: ["resId"],
      properties: {
        resId: { type: "integer", description: "ID del albarán" },
      },
    },
  },
  {
    name: "confirmar_accion_critica",
    description: "Aprueba y ejecuta una acción crítica de Nivel 3 mediante su código de confirmación.",
    inputSchema: {
      type: "object",
      required: ["actionId", "confirmationCode"],
      properties: {
        actionId: { type: "string", description: "UUID de la acción pendiente" },
        confirmationCode: { type: "string", description: "Código de 6 dígitos" },
      },
    },
  },
  {
    name: "consultar_procedimiento_sop",
    description: "Consulta los procedimientos operativos estándar (SOPs), políticas y manuales de la empresa (Zero-Tokens / Cero alucinaciones).",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Pregunta o término de búsqueda sobre el procedimiento (ej. 'devolución', 'descuento')" },
        category: { type: "string", description: "Categoría opcional (ventas, compras, inventario, facturacion, general)" },
      },
    },
  },
  {
    name: "ejecutar_auditoria_negocio",
    description: "Ejecuta un diagnóstico continuo de negocio (higiene de datos, cuellos de botella y SLA en Odoo 19).",
    inputSchema: {
      type: "object",
      properties: {
        reportType: { type: "string", enum: ["full", "hygiene", "bottlenecks"], default: "full", description: "Tipo de reporte de auditoría" },
      },
    },
  },
  {
    name: "registrar_pago_factura",
    description: "Registra un pago de factura mediante el wizard account.payment.register (Nivel 3).",
    inputSchema: {
      type: "object",
      required: ["invoiceId"],
      properties: {
        invoiceId: { type: "integer", description: "ID de la factura (account.move)" },
        amount: { type: "number", description: "Monto a pagar (opcional, por defecto el saldo residual)" },
        journalId: { type: "integer", description: "ID del diario de pago (banco/efectivo)" },
        paymentDate: { type: "string", description: "Fecha de pago YYYY-MM-DD" },
        communication: { type: "string", description: "Referencia o memo" },
      },
    },
  },
  {
    name: "crear_anticipo_venta",
    description: "Genera factura de anticipo para una orden de venta mediante sale.advance.payment.inv (Nivel 1).",
    inputSchema: {
      type: "object",
      required: ["saleOrderId"],
      properties: {
        saleOrderId: { type: "integer", description: "ID de la orden de venta" },
        advancePaymentMethod: { type: "string", enum: ["delivered", "percentage", "fixed"], default: "delivered" },
        amount: { type: "number", description: "Porcentaje o monto fijo si aplica" },
        depositAccountId: { type: "integer", description: "ID de la cuenta contable de anticipo" },
      },
    },
  },
  {
    name: "crear_nota_credito",
    description: "Emite una nota de crédito / rectificativa mediante account.move.reversal (Nivel 3).",
    inputSchema: {
      type: "object",
      required: ["moveId"],
      properties: {
        moveId: { type: "integer", description: "ID de la factura a rectificar" },
        reason: { type: "string", description: "Motivo de la rectificación" },
        refundMethod: { type: "string", enum: ["refund", "cancel"], default: "refund" },
        date: { type: "string", description: "Fecha contable YYYY-MM-DD" },
      },
    },
  },
  {
    name: "convertir_iniciativa_crm",
    description: "Convierte una iniciativa en oportunidad comercial en el CRM mediante crm.lead2opportunity.partner (Nivel 2).",
    inputSchema: {
      type: "object",
      required: ["leadId"],
      properties: {
        leadId: { type: "integer", description: "ID de la iniciativa" },
        action: { type: "string", enum: ["create", "exist", "nothing"], default: "create" },
        partnerId: { type: "integer", description: "ID de cliente existente si action es 'exist'" },
        userId: { type: "integer", description: "ID del comercial asignado" },
        teamId: { type: "integer", description: "ID del equipo de ventas" },
      },
    },
  },
  {
    name: "perder_oportunidad_crm",
    description: "Marca una oportunidad como perdida en el CRM mediante crm.lead.lost (Nivel 2).",
    inputSchema: {
      type: "object",
      required: ["leadId"],
      properties: {
        leadId: { type: "integer", description: "ID de la oportunidad" },
        lostReasonId: { type: "integer", description: "ID del motivo de pérdida (crm.lost.reason)" },
        lostFeedback: { type: "string", description: "Comentarios u observaciones" },
      },
    },
  },
  {
    name: "cancelar_orden_venta",
    description: "Cancela una orden de venta de forma controlada sin borrado físico (Nivel 3).",
    inputSchema: {
      type: "object",
      required: ["resId"],
      properties: {
        resId: { type: "integer", description: "ID de la orden de venta" },
      },
    },
  },
  {
    name: "cancelar_factura",
    description: "Cancela una factura en borrador o publicada sin borrado físico (Nivel 3).",
    inputSchema: {
      type: "object",
      required: ["resId"],
      properties: {
        resId: { type: "integer", description: "ID de la factura" },
      },
    },
  },
  {
    name: "cancelar_albaran_entrega",
    description: "Cancela un albarán de entrega o recepción sin borrado físico (Nivel 3).",
    inputSchema: {
      type: "object",
      required: ["resId"],
      properties: {
        resId: { type: "integer", description: "ID del albarán" },
      },
    },
  },
  {
    name: "inspeccionar_campos_studio",
    description: "Inspecciona campos personalizados Studio (x_ o x_studio_) en un modelo de Odoo.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: { type: "string", description: "Nombre técnico del modelo en Odoo, ej. 'sale.order', 'res.partner'" },
      },
    },
  },
  {
    name: "inspeccionar_tablero",
    description: "Inspecciona y descarga la definición de hojas de cálculo o tableros en Odoo 18/19.",
    inputSchema: {
      type: "object",
      properties: {
        dashboardId: { type: "integer", description: "ID opcional del tablero (spreadsheet.dashboard) a inspeccionar" },
      },
    },
  },
  {
    name: "validar_tablero",
    description: "Valida la estructura de una hoja de cálculo Odoo (enlaces odoo://view con action anidado, AST 2D y Unicode).",
    inputSchema: {
      type: "object",
      required: ["spreadsheetData"],
      properties: {
        spreadsheetData: { type: "object", description: "Estructura JSON de la hoja de cálculo a validar" },
      },
    },
  },
  {
    name: "crear_o_actualizar_tablero",
    description: "Crea o actualiza un tablero de hoja de cálculo en Odoo asegurando conformidad estricta (Nivel 2).",
    inputSchema: {
      type: "object",
      required: ["name", "spreadsheetData"],
      properties: {
        name: { type: "string", description: "Nombre del tablero" },
        spreadsheetData: { type: "object", description: "JSON de la hoja de cálculo" },
        dashboardId: { type: "integer", description: "ID si se desea actualizar uno existente" },
      },
    },
  },
];

export class McpServer {
  constructor({ odoo, client, db, config, linkedUser = null }) {
    this.odoo = odoo;
    this.client = client;
    this.db = db;
    this.config = config;
    this.linkedUser = linkedUser;
  }

  async handleMessage(raw) {
    let request;
    try {
      request = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
    }

    if (!request || typeof request !== "object") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    const { id, method, params } = request;

    // Notificaciones no requieren respuesta
    if (id === undefined && method?.startsWith("notifications/")) {
      return null;
    }

    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "odoo-ai-mcp",
              version: "0.2.0",
            },
          },
        };
      }

      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }

      if (method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: MCP_TOOLS },
        };
      }

      if (method === "tools/call") {
        const { name, arguments: toolArgs = {} } = params || {};
        const result = await this.#executeTool(name, toolArgs);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
            isError: false,
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Error ejecutando herramienta: ${error.message}`,
            },
          ],
          isError: true,
        },
      };
    }
  }

  async #executeTool(name, args) {
    // 1. Confirmar acción crítica
    if (name === "confirmar_accion_critica") {
      return confirmOperationalAction({
        db: this.db,
        odoo: this.odoo,
        actionId: args.actionId,
        confirmationCode: args.confirmationCode,
        confirmedByUserId: this.linkedUser?.id,
      });
    }

    // 2. Acciones de lectura estándar hacia Odoo
    if (name === "consultar_orden_venta") {
      return this.odoo.searchRead("sale.order", args.domain || [], args.fields || ["name", "partner_id", "date_order", "state", "amount_total"], { limit: args.limit || 10 });
    }
    if (name === "consultar_orden_compra") {
      return this.odoo.searchRead("purchase.order", args.domain || [], args.fields || ["name", "partner_id", "date_order", "state", "amount_total"], { limit: args.limit || 10 });
    }
    if (name === "consultar_precio_producto") {
      const domain = args.query ? ["|", ["name", "ilike", args.query], ["default_code", "ilike", args.query]] : [];
      return this.odoo.searchRead("product.product", domain, ["name", "default_code", "lst_price", "uom_id"], { limit: args.limit || 5 });
    }
    if (name === "consultar_inventario") {
      const domain = args.product_id ? [["id", "=", Number(args.product_id)]] : [];
      return this.odoo.searchRead("product.product", domain, ["name", "default_code", "qty_available", "free_qty", "virtual_available"], { limit: 5 });
    }
    if (name === "consultar_facturas_pendientes") {
      const domain = [["move_type", "=", "out_invoice"]];
      if (args.partner_id) domain.push(["partner_id", "=", Number(args.partner_id)]);
      if (args.payment_state) domain.push(["payment_state", "=", args.payment_state]);
      return this.odoo.searchRead("account.move", domain, ["name", "partner_id", "invoice_date", "amount_total", "amount_residual", "payment_state"], { limit: args.limit || 10 });
    }
    if (name === "consultar_clientes") {
      const domain = args.query ? ["|", ["name", "ilike", args.query], ["vat", "ilike", args.query]] : [["customer_rank", ">", 0]];
      return this.odoo.searchRead("res.partner", domain, ["name", "vat", "email", "phone", "city"], { limit: args.limit || 5 });
    }
    if (name === "consultar_oportunidades_crm") {
      return this.odoo.searchRead("crm.lead", args.domain || [], args.fields || ["name", "partner_id", "stage_id", "expected_revenue", "probability", "user_id"], { limit: args.limit || 10 });
    }

    // SOPs y Auditoría de Negocio
    if (name === "consultar_procedimiento_sop") {
      if (!this.db) {
        return "Base de datos de SOPs no conectada en modo directo. Consulta los archivos en sops/ del cliente.";
      }
      return answerSopQuery({
        db: this.db,
        client: this.client,
        query: args.query,
        category: args.category,
      });
    }
    if (name === "ejecutar_auditoria_negocio") {
      if (!this.db) {
        return "La auditoría histórica requiere conexión a la base de datos de control (PostgreSQL).";
      }
      return runFullBusinessAudit({
        db: this.db,
        odoo: this.odoo,
        client: this.client,
        reportType: args.reportType || "operational_health",
      });
    }

    // Inspección Studio y Tableros / Hojas de Cálculo
    if (name === "inspeccionar_campos_studio") {
      return inspectStudioFields(this.odoo, args.model);
    }
    if (name === "inspeccionar_tablero") {
      return inspectDashboard(this.odoo, args.dashboardId);
    }
    if (name === "validar_tablero") {
      return validateSpreadsheetDefinition(args.spreadsheetData);
    }
    if (name === "crear_o_actualizar_tablero") {
      return createOrUpdateDashboard(this.odoo, args);
    }

    // 3. Acciones operativas bajo motor de gobernanza
    return requestOrExecuteAction({
      db: this.db,
      config: this.config,
      client: this.client,
      linkedUser: this.linkedUser,
      actionName: name,
      params: args,
      odoo: this.odoo,
    });
  }

  startStdio(inStream = process.stdin, outStream = process.stdout) {
    const rl = createInterface({ input: inStream, terminal: false });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      const response = await this.handleMessage(line);
      if (response) {
        outStream.write(`${JSON.stringify(response)}\n`);
      }
    });
  }
}
