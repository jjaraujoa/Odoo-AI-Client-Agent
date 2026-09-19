import { createInterface } from "node:readline";
import { AppError } from "./errors.js";
import { executeOperationalAction } from "./operational-actions.js";
import { requestOrExecuteAction, confirmOperationalAction } from "./governance.js";
import { answerSopQuery } from "./sops.js";
import { runFullBusinessAudit } from "./audit-business.js";

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
