import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";
import {
  DEFAULT_MAX_HOURS_PER_DAY,
  DEFAULT_TIMEZONE,
  MAX_LINES_PER_CALL,
  executeTimesheetRegistration,
  listMyTimesheets,
  listTimesheetProjectsTasks,
  listActivityTypes,
  listMyTickets,
  normalizeTimesheetConfig,
  resolveTimesheetExtras,
  normalizeTimesheetLines,
  prepareTimesheetRegistration,
  publicLine,
  resolveCurrentUid,
  summarizePreparation,
} from "./timesheets.js";
import { requestOrExecuteAction } from "./governance.js";
import { decideApproval, getApprovalStatus, APPROVAL_TTL_MS } from "./approvals.js";
import { answerSopQuery } from "./sops.js";
import { runFullBusinessAudit, inspectStudioFields } from "./audit-business.js";
import { inspectDashboard, validateSpreadsheetDefinition, createOrUpdateDashboard } from "./spreadsheet.js";

export const READ_ONLY_TOOLS = new Set([
  "consultar_orden_venta",
  "consultar_orden_compra",
  "consultar_precio_producto",
  "consultar_inventario",
  "consultar_facturas_pendientes",
  "consultar_clientes",
  "consultar_oportunidades_crm",
  "consultar_procedimiento_sop",
  "ejecutar_auditoria_negocio",
  "inspeccionar_campos_studio",
  "inspeccionar_tablero",
  "validar_tablero",
  "consultar_mis_proyectos_tareas",
  "consultar_mis_horas",
  "consultar_tipos_actividad",
  "consultar_mis_tickets",
]);

// Escrituras que pueden habilitarse en modo carpeta local (sin BD de control) mediante
// `local_write_tools` en cliente.yaml. cliente.yaml puede ser editado por el agente que usa
// el MCP, así que la lista se intersecta SIEMPRE con esta constante del código, y cada
// llamada exige aprobación humana (elicitation MCP o token "APLICAR <id>").
export const LOCAL_WRITE_ALLOWED = Object.freeze(new Set(["registrar_horas"]));

// Herramientas que solo existen en modo carpeta local (no pasan por agent.tool_policies).
const LOCAL_ONLY_TOOLS = new Set(["registrar_horas"]);

const LOCAL_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export const MCP_TOOLS = [
  {
    name: "consultar_orden_venta",
    description: "Consulta órdenes de venta y cotizaciones en Odoo 19 por cliente, estado o fecha.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Número de documento (ilike)" },
        partner: { type: "string", description: "Nombre del cliente (ilike sobre partner_id)" },
        state: {
          type: "string",
          enum: ["draft", "sent", "sale", "done", "cancel"],
          description: "Estado de la orden de venta",
        },
        date_from: { type: "string", description: "Fecha desde (YYYY-MM-DD) sobre date_order" },
        date_to: { type: "string", description: "Fecha hasta (YYYY-MM-DD) sobre date_order" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Límite de registros (1..50, default 10)" },
      },
    },
  },
  {
    name: "consultar_orden_compra",
    description: "Consulta pedidos de compra a proveedores en Odoo 19.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Número de documento (ilike)" },
        partner: { type: "string", description: "Nombre del proveedor (ilike sobre partner_id)" },
        state: {
          type: "string",
          enum: ["draft", "sent", "to approve", "purchase", "done", "cancel"],
          description: "Estado de la orden de compra",
        },
        date_from: { type: "string", description: "Fecha desde (YYYY-MM-DD) sobre date_order" },
        date_to: { type: "string", description: "Fecha hasta (YYYY-MM-DD) sobre date_order" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Límite de registros (1..50, default 10)" },
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
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Nombre de la iniciativa u oportunidad (ilike)" },
        partner: { type: "string", description: "Nombre del cliente o contacto (ilike sobre partner_id)" },
        stage: { type: "string", description: "Nombre de la etapa (ilike sobre stage_id)" },
        type: {
          type: "string",
          enum: ["lead", "opportunity"],
          description: "Tipo de registro (lead u oportunidad)",
        },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Límite de registros (1..50, default 10)" },
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
            required: ["productId", "quantity"],
            properties: {
              productId: { type: "integer" },
              quantity: { type: "number" },
              priceUnit: { type: "number", description: "Opcional: si se omite, Odoo aplica la lista de precios del cliente." },
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
            required: ["productId", "quantity"],
            properties: {
              productId: { type: "integer" },
              quantity: { type: "number" },
              priceUnit: { type: "number", description: "Opcional: si se omite, Odoo aplica la lista de precios del cliente." },
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
    description: "Confirma una orden de venta en Odoo (Nivel 3 - el usuario debe aprobarla. Para varios registros envía todos los IDs en resIds en UNA sola llamada.).",
    inputSchema: {
      type: "object",
      properties: {
        resId: { type: "integer", description: "ID de la orden de venta" },
        resIds: {
          type: "array",
          items: { type: "integer" },
          maxItems: 50,
          description: "Varios IDs en una sola llamada: se mostrará un solo resumen y una sola aprobación.",
        },
      },
    },
  },
  {
    name: "validar_albaran_entrega",
    description: "Valida un albarán de inventario en Odoo (Nivel 3 - el usuario debe aprobarla. Para varios registros envía todos los IDs en resIds en UNA sola llamada.).",
    inputSchema: {
      type: "object",
      properties: {
        resId: { type: "integer", description: "ID del albarán" },
        resIds: {
          type: "array",
          items: { type: "integer" },
          maxItems: 50,
          description: "Varios IDs en una sola llamada: se mostrará un solo resumen y una sola aprobación.",
        },
      },
    },
  },
  {
    name: "consultar_estado_accion",
    description: "Consulta el estado de una solicitud de aprobación de Nivel 3 (solo lectura).",
    inputSchema: {
      type: "object",
      required: ["actionId"],
      properties: {
        actionId: { type: "string", description: "UUID de la solicitud" },
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
    description: "Cancela una orden de venta de forma controlada sin borrado físico (Nivel 3 - el usuario debe aprobarla. Para varios registros envía todos los IDs en resIds en UNA sola llamada.).",
    inputSchema: {
      type: "object",
      properties: {
        resId: { type: "integer", description: "ID de la orden de venta" },
        resIds: {
          type: "array",
          items: { type: "integer" },
          maxItems: 50,
          description: "Varios IDs en una sola llamada: se mostrará un solo resumen y una sola aprobación.",
        },
      },
    },
  },
  {
    name: "cancelar_factura",
    description: "Cancela una factura en borrador o publicada sin borrado físico (Nivel 3 - el usuario debe aprobarla. Para varios registros envía todos los IDs en resIds en UNA sola llamada.).",
    inputSchema: {
      type: "object",
      properties: {
        resId: { type: "integer", description: "ID de la factura" },
        resIds: {
          type: "array",
          items: { type: "integer" },
          maxItems: 50,
          description: "Varios IDs en una sola llamada: se mostrará un solo resumen y una sola aprobación.",
        },
      },
    },
  },
  {
    name: "cancelar_albaran_entrega",
    description: "Cancela un albarán de entrega o recepción sin borrado físico (Nivel 3 - el usuario debe aprobarla. Para varios registros envía todos los IDs en resIds en UNA sola llamada.).",
    inputSchema: {
      type: "object",
      properties: {
        resId: { type: "integer", description: "ID del albarán" },
        resIds: {
          type: "array",
          items: { type: "integer" },
          maxItems: 50,
          description: "Varios IDs en una sola llamada: se mostrará un solo resumen y una sola aprobación.",
        },
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
  {
    name: "consultar_mis_proyectos_tareas",
    description:
      "Lista los proyectos que admiten partes de horas y sus tareas abiertas, para saber dónde imputar horas (solo lectura).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Texto a buscar en el nombre del proyecto o de la tarea (ilike)" },
        proyecto_id: { type: "integer", description: "Limitar a un proyecto concreto" },
        incluir_cerradas: { type: "boolean", default: false, description: "Incluir tareas terminadas o canceladas" },
        solo_favoritos: { type: "boolean", default: false, description: "Solo proyectos marcados como favoritos por el usuario (búsqueda habitual)" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 80 },
      },
    },
  },
  {
    name: "consultar_tipos_actividad",
    description: "Lista los tipos de actividad que se pueden asignar a una línea de horas (solo lectura).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "consultar_mis_tickets",
    description:
      "Lista los tickets de Helpdesk abiertos asignados al usuario, con el proyecto/tarea y tipo de actividad de su último registro de horas (solo lectura).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Texto a buscar en el nombre del ticket o del cliente" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    },
  },
  {
    name: "consultar_mis_horas",
    description:
      "Consulta las horas ya registradas (partes de horas) del propio usuario entre dos fechas, con totales por día (solo lectura).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["desde", "hasta"],
      properties: {
        desde: { type: "string", description: "Fecha inicial YYYY-MM-DD (incluida)" },
        hasta: { type: "string", description: "Fecha final YYYY-MM-DD (incluida)" },
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
      },
    },
  },
  {
    name: "registrar_horas",
    description:
      "Registra líneas de parte de horas del propio usuario (account.analytic.line). Requiere aprobación humana: " +
      "se pide por elicitation; si el cliente no la soporta, devuelve un id y solo debe repetirse la llamada con " +
      "confirmacion='APLICAR <id>' cuando el usuario haya escrito esa frase en el chat. Omite líneas ya registradas " +
      "(misma fecha, proyecto, tarea y descripción), rechaza fechas futuras y más de 12 h por día.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["lineas"],
      properties: {
        lineas: {
          type: "array",
          minItems: 1,
          maxItems: MAX_LINES_PER_CALL,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["fecha", "proyecto_id", "horas", "descripcion"],
            properties: {
              fecha: { type: "string", description: "YYYY-MM-DD" },
              proyecto_id: { type: "integer", description: "ID de project.project" },
              tarea_id: { type: "integer", description: "ID de project.task (opcional)" },
              horas: { type: "number", exclusiveMinimum: 0, maximum: 12, description: "Horas decimales (1.5 = 1 h 30 min)" },
              descripcion: { type: "string", maxLength: 500, description: "Descripción de la actividad" },
              tipo_actividad_id: {
                type: "integer",
                description: "Tipo de actividad (consultar_tipos_actividad). Solo si el cliente configura registro_horas.campo_tipo_actividad; puede ser obligatorio.",
              },
              ticket_id: {
                type: "integer",
                description: "Ticket de Helpdesk al que se imputan las horas (consultar_mis_tickets), opcional",
              },
            },
          },
        },
        confirmacion: {
          type: "string",
          description: "Solo en el segundo paso sin elicitation: exactamente 'APLICAR <id>' tal como lo escribió el usuario.",
        },
      },
    },
  },
];

export const CLOSED_QUERY_FIELDS = {
  sale: ["name", "partner_id", "date_order", "state", "amount_total", "currency_id", "user_id"],
  purchase: ["name", "partner_id", "date_order", "state", "amount_total", "currency_id", "user_id"],
  crm: ["name", "partner_id", "stage_id", "expected_revenue", "probability", "user_id", "type"],
};

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function buildClosedQuery(toolName, args = {}) {
  let model;
  let fixedFields;

  if (toolName === "consultar_orden_venta") {
    model = "sale.order";
    fixedFields = CLOSED_QUERY_FIELDS.sale;
  } else if (toolName === "consultar_orden_compra") {
    model = "purchase.order";
    fixedFields = CLOSED_QUERY_FIELDS.purchase;
  } else if (toolName === "consultar_oportunidades_crm") {
    model = "crm.lead";
    fixedFields = CLOSED_QUERY_FIELDS.crm;
  } else {
    throw new AppError(400, "invalid_filter", `Herramienta desconocida: ${toolName}`);
  }

  let limit = 10;
  if (args?.limit !== undefined && args?.limit !== null) {
    const parsed = Number(args.limit);
    if (!Number.isNaN(parsed)) {
      limit = Math.max(1, Math.min(50, Math.floor(parsed)));
    }
  }

  const domain = [];

  if (typeof args?.name === "string" && args.name.length > 0) {
    domain.push(["name", "ilike", args.name.slice(0, 100)]);
  }

  if (typeof args?.partner === "string" && args.partner.length > 0) {
    domain.push(["partner_id", "ilike", args.partner.slice(0, 100)]);
  }

  if (toolName === "consultar_orden_venta" || toolName === "consultar_orden_compra") {
    if (args?.state !== undefined && args?.state !== null && args?.state !== "") {
      const validStates =
        toolName === "consultar_orden_venta"
          ? ["draft", "sent", "sale", "done", "cancel"]
          : ["draft", "sent", "to approve", "purchase", "done", "cancel"];

      if (!validStates.includes(args.state)) {
        throw new AppError(400, "invalid_filter", `Estado inválido: ${args.state}`);
      }
      domain.push(["state", "=", args.state]);
    }

    if (args?.date_from !== undefined && args?.date_from !== null && args?.date_from !== "") {
      if (typeof args.date_from !== "string" || !DATE_REGEX.test(args.date_from)) {
        throw new AppError(400, "invalid_date", `Fecha date_from inválida: ${args.date_from}`);
      }
      domain.push(["date_order", ">=", args.date_from]);
    }

    if (args?.date_to !== undefined && args?.date_to !== null && args?.date_to !== "") {
      if (typeof args.date_to !== "string" || !DATE_REGEX.test(args.date_to)) {
        throw new AppError(400, "invalid_date", `Fecha date_to inválida: ${args.date_to}`);
      }
      domain.push(["date_order", "<=", args.date_to]);
    }
  }

  if (toolName === "consultar_oportunidades_crm") {
    if (typeof args?.stage === "string" && args.stage.length > 0) {
      domain.push(["stage_id", "ilike", args.stage.slice(0, 100)]);
    }

    if (args?.type !== undefined && args?.type !== null && args?.type !== "") {
      const validTypes = ["lead", "opportunity"];
      if (!validTypes.includes(args.type)) {
        throw new AppError(400, "invalid_filter", `Tipo inválido: ${args.type}`);
      }
      domain.push(["type", "=", args.type]);
    }
  }

  return {
    model,
    domain,
    fields: [...fixedFields],
    limit,
  };
}

export class McpServer {
  #crmAvailable = null;
  #pendingServerRequests = new Map();
  #nextServerRequestId = 0;
  #output = null;
  #elicitationByToolCall = new Map();
  #pendingLocalConfirmations = new Map();
  #currentUid = null;
  #timesheetExtras = null;

  constructor({
    odoo,
    client,
    db,
    config,
    linkedUser = null,
    approvalUser = null,
    elicitationTimeoutMs = APPROVAL_TTL_MS,
    localWriteTools = [],
    auditor = null,
    timeZone = DEFAULT_TIMEZONE,
    maxHoursPerDay = DEFAULT_MAX_HOURS_PER_DAY,
    timesheetConfig = null,
    now = () => new Date(),
  }) {
    this.odoo = odoo;
    this.client = client;
    this.db = db;
    this.config = config;
    this.linkedUser = linkedUser;
    this.approvalUser = approvalUser;
    this.elicitationTimeoutMs = elicitationTimeoutMs;
    this.elicitationSupported = false;
    // Solo en modo carpeta local y solo lo que permite el código.
    this.localWriteTools = new Set(
      !db && Array.isArray(localWriteTools)
        ? localWriteTools.filter((t) => LOCAL_WRITE_ALLOWED.has(t))
        : [],
    );
    this.auditor = auditor;
    this.timeZone = timeZone || DEFAULT_TIMEZONE;
    this.maxHoursPerDay = maxHoursPerDay;
    // Campos propios del cliente (tipo de actividad, ticket): vienen de su configuración privada.
    this.timesheetConfig = normalizeTimesheetConfig(timesheetConfig);
    this.now = now;
  }

  #sendRequest(method, params, { timeoutMs, toolCallId } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#output) {
        return reject(
          new AppError(503, "no_client_channel", "No hay canal de comunicación con el cliente MCP.")
        );
      }

      const id = `srv-${++this.#nextServerRequestId}`;
      const effectiveTimeout = timeoutMs ?? this.elicitationTimeoutMs;

      let timer = null;
      if (effectiveTimeout && effectiveTimeout > 0) {
        timer = setTimeout(() => {
          this.#pendingServerRequests.delete(id);
          if (toolCallId !== undefined && toolCallId !== null) {
            this.#elicitationByToolCall.delete(toolCallId);
          }
          reject(new AppError(408, "elicitation_timeout", "El usuario no respondió a tiempo."));
        }, effectiveTimeout);
      }

      this.#pendingServerRequests.set(id, { resolve, reject, timer });
      if (toolCallId !== undefined && toolCallId !== null) {
        this.#elicitationByToolCall.set(toolCallId, id);
      }

      try {
        this.#output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.#pendingServerRequests.delete(id);
        if (toolCallId !== undefined && toolCallId !== null) {
          this.#elicitationByToolCall.delete(toolCallId);
        }
        reject(err);
      }
    });
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

    // Respuestas a peticiones servidor -> cliente
    if (!request.method && request.id !== undefined && (request.result !== undefined || request.error !== undefined)) {
      const pending = this.#pendingServerRequests.get(request.id);
      if (pending) {
        this.#pendingServerRequests.delete(request.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (request.error !== undefined) {
          pending.reject(request.error);
        } else {
          pending.resolve(request.result);
        }
      }
      return null;
    }

    const { id, method, params } = request;

    // Notificación "notifications/cancelled" con params.requestId
    if (method === "notifications/cancelled") {
      const clientRequestId = params?.requestId;
      if (clientRequestId !== undefined && clientRequestId !== null) {
        const serverReqId = this.#elicitationByToolCall.get(clientRequestId);
        if (serverReqId) {
          this.#elicitationByToolCall.delete(clientRequestId);
          const pending = this.#pendingServerRequests.get(serverReqId);
          if (pending) {
            this.#pendingServerRequests.delete(serverReqId);
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(
              new AppError(499, "elicitation_cancelled", "La solicitud fue cancelada por el cliente.")
            );
          }
        }
      }
      return null;
    }

    // Notificaciones no requieren respuesta
    if (id === undefined && method?.startsWith("notifications/")) {
      return null;
    }

    try {
      if (method === "initialize") {
        const clientVersion = params?.protocolVersion;
        const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)
          ? clientVersion
          : "2025-11-25";

        const clientElicitation = params?.capabilities?.elicitation;
        const isElicitationObj =
          clientElicitation !== null &&
          typeof clientElicitation === "object" &&
          !Array.isArray(clientElicitation);
        const hasFormSupport =
          isElicitationObj &&
          (Object.keys(clientElicitation).length === 0 || "form" in clientElicitation);

        this.elicitationSupported =
          (negotiatedVersion === "2025-06-18" || negotiatedVersion === "2025-11-25") &&
          hasFormSupport;

        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiatedVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: "odoo-ai-mcp",
              version: "0.3.0",
            },
          },
        };
      }

      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }

      if (method === "tools/list") {
        let tools = !this.db
          ? MCP_TOOLS.filter((t) => READ_ONLY_TOOLS.has(t.name) || this.localWriteTools.has(t.name))
          : MCP_TOOLS.filter((t) => !LOCAL_ONLY_TOOLS.has(t.name));
        if (!(await this.#isCrmAvailable())) {
          tools = tools.filter((t) => t.name !== "consultar_oportunidades_crm");
        }
        return {
          jsonrpc: "2.0",
          id,
          result: { tools },
        };
      }

      if (method === "tools/call") {
        const { name, arguments: toolArgs = {} } = params || {};
        const result = await this.#executeTool(name, toolArgs, { toolCallId: id });
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

  async #isCrmAvailable() {
    if (this.#crmAvailable !== null) {
      return this.#crmAvailable;
    }
    if (!this.odoo || typeof this.odoo.searchRead !== "function") {
      this.#crmAvailable = true;
      return true;
    }
    try {
      const res = await this.odoo.searchRead(
        "ir.model",
        [["model", "=", "crm.lead"]],
        ["id"],
        { limit: 1 },
      );
      this.#crmAvailable = Array.isArray(res) && res.length > 0;
    } catch {
      // si lanza error → asumir disponible (no ocultar por error de permisos)
      this.#crmAvailable = true;
    }
    return this.#crmAvailable;
  }

  async #resolveAllowedFields(toolName, baseFields) {
    if (!this.db || typeof this.db.query !== "function") {
      return [...baseFields];
    }
    const clientId = typeof this.client === "string" ? this.client : (this.client?.id || null);
    if (!clientId) {
      return [...baseFields];
    }
    try {
      const res = await this.db.query(
        "SELECT allowed_fields FROM agent.tool_policies WHERE client_id=$1 AND tool_name=$2 AND enabled",
        [clientId, toolName],
      );
      const row = res?.rows?.[0];
      if (row && Array.isArray(row.allowed_fields) && row.allowed_fields.length > 0) {
        const allowed = new Set(row.allowed_fields);
        const intersected = baseFields.filter((f) => f === "name" || allowed.has(f));
        if (!intersected.includes("name")) {
          intersected.unshift("name");
        }
        return intersected;
      }
    } catch {
      // Si no hay fila o falla la consulta, usar los campos fijos
    }
    return [...baseFields];
  }

  async #executeTool(name, args, { toolCallId } = {}) {
    if (name === "consultar_estado_accion") {
      if (!this.db) {
        return "Requiere la base de datos de control.";
      }
      return getApprovalStatus({
        db: this.db,
        clientId: this.client.id,
        actionId: args.actionId,
        linkedUserId: this.linkedUser?.id ?? null,
      });
    }

    if (!this.db && !READ_ONLY_TOOLS.has(name) && !this.localWriteTools.has(name)) {
      throw new AppError(
        409,
        "write_tools_require_control_db",
        "Las acciones de escritura requieren la base de datos de control (modo BD con DATABASE_URL y el cliente registrado). En modo carpeta local solo están disponibles las consultas."
      );
    }

    // Partes de horas del propio usuario
    if (name === "consultar_mis_proyectos_tareas") {
      return listTimesheetProjectsTasks(this.odoo, args);
    }
    if (name === "consultar_mis_horas") {
      const uid = await this.#resolveUid();
      return listMyTimesheets(this.odoo, { uid, desde: args?.desde, hasta: args?.hasta, limit: args?.limit }, await this.#extras());
    }
    if (name === "consultar_tipos_actividad") {
      return listActivityTypes(this.odoo, await this.#extras());
    }
    if (name === "consultar_mis_tickets") {
      const uid = await this.#resolveUid();
      return listMyTickets(this.odoo, { uid, query: args?.query, limit: args?.limit }, await this.#extras());
    }
    if (name === "registrar_horas") {
      if (this.db) {
        throw new AppError(409, "local_mode_only", "registrar_horas solo está disponible en modo carpeta local.");
      }
      return this.#registerTimesheetsLocal(args, toolCallId);
    }

    // 2. Acciones de lectura estándar hacia Odoo
    if (
      name === "consultar_orden_venta" ||
      name === "consultar_orden_compra" ||
      name === "consultar_oportunidades_crm"
    ) {
      const query = buildClosedQuery(name, args);
      const fields = await this.#resolveAllowedFields(name, query.fields);

      if (name === "consultar_oportunidades_crm") {
        try {
          return await this.odoo.searchRead(query.model, query.domain, fields, { limit: query.limit });
        } catch (error) {
          const is404 =
            error?.status === 404 ||
            error?.details?.upstreamStatus === 404 ||
            (error?.code === "upstream_error" && error?.details?.upstreamStatus === 404) ||
            (error?.message && String(error.message).includes("404"));
          if (is404) {
            return "El módulo CRM no está instalado o no está disponible en esta base de Odoo.";
          }
          throw error;
        }
      }

      return this.odoo.searchRead(query.model, query.domain, fields, { limit: query.limit });
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
    const approvalChannel = this.elicitationSupported
      ? "mcp_elicitation"
      : this.approvalUser?.id && this.approvalUser?.telegram_chat_id
        ? "telegram"
        : null;

    const approver = approvalChannel === "telegram" ? this.approvalUser : null;

    const result = await requestOrExecuteAction({
      db: this.db,
      config: this.config,
      client: this.client,
      linkedUser: this.linkedUser,
      actionName: name,
      params: args,
      odoo: this.odoo,
      approvalChannel,
      approver,
    });

    if (result.status === "awaiting_approval" && result.channel === "mcp_elicitation") {
      return this.#askUserApproval(result, toolCallId);
    }

    if (result.status === "awaiting_approval" && result.channel === "telegram") {
      return {
        ...result,
        note: "El usuario debe aprobar en Telegram. Puedes consultar el estado con consultar_estado_accion.",
      };
    }

    return result;
  }

  async #extras() {
    if (!this.#timesheetExtras) this.#timesheetExtras = await resolveTimesheetExtras(this.odoo, this.timesheetConfig);
    return this.#timesheetExtras;
  }

  async #resolveUid() {
    if (!this.#currentUid) {
      this.#currentUid = await resolveCurrentUid(this.odoo, this.linkedUser?.odoo_login || null);
    }
    return this.#currentUid;
  }

  async #audit(event) {
    if (!this.auditor) return;
    await this.auditor.record({
      tool: "registrar_horas",
      cliente: this.client?.slug || this.client?.client_slug || null,
      usuario: this.linkedUser?.odoo_login || null,
      ...event,
    });
  }

  #timesheetOptions(uid) {
    return { uid, now: this.now(), timeZone: this.timeZone, maxHoursPerDay: this.maxHoursPerDay, config: this.timesheetConfig };
  }

  #linesFingerprint(rawLines) {
    const normalized = normalizeTimesheetLines(rawLines, { now: this.now(), timeZone: this.timeZone });
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  }

  #purgeExpiredConfirmations() {
    const nowMs = this.now().getTime();
    for (const [id, pending] of this.#pendingLocalConfirmations.entries()) {
      if (pending.expiresAt <= nowMs) this.#pendingLocalConfirmations.delete(id);
    }
  }

  async #registerTimesheetsLocal(args, toolCallId) {
    const uid = await this.#resolveUid();
    const rawLines = args?.lineas;
    const confirmation = typeof args?.confirmacion === "string" ? args.confirmacion.trim() : "";
    this.#purgeExpiredConfirmations();

    // Paso 2 (sin elicitation): el usuario escribió "APLICAR <id>" en el chat.
    if (confirmation) {
      const match = confirmation.match(/^APLICAR\s+([A-F0-9]{6})$/i);
      if (!match) {
        throw new AppError(400, "invalid_confirmation", "La confirmación debe ser exactamente 'APLICAR <id>'.");
      }
      const actionId = match[1].toUpperCase();
      const pending = this.#pendingLocalConfirmations.get(actionId);
      if (!pending) {
        throw new AppError(404, "confirmation_not_found", `No hay una solicitud pendiente ${actionId} (no existe, ya se usó o expiró). Prepara de nuevo.`);
      }
      if (pending.fingerprint !== this.#linesFingerprint(rawLines)) {
        throw new AppError(409, "confirmation_mismatch", "Las líneas no coinciden con las que el usuario aprobó. Prepara una nueva solicitud.");
      }
      this.#pendingLocalConfirmations.delete(actionId);
      await this.#audit({ etapa: "aprobada", action_id: actionId, via: "token" });
      return this.#executeTimesheetsLocal(rawLines, uid, actionId, "token");
    }

    // Paso 1: preparar (valida, idempotencia, límites). No escribe.
    const prep = await prepareTimesheetRegistration(this.odoo, rawLines, this.#timesheetOptions(uid));
    const actionId = randomBytes(3).toString("hex").toUpperCase();
    const summary = summarizePreparation(prep);
    await this.#audit({
      etapa: "preparada",
      action_id: actionId,
      lineas: prep.toCreate.map(publicLine),
      omitidas: prep.skipped.map(publicLine),
    });

    if (prep.toCreate.length === 0) {
      return { status: "nothing_to_do", action_id: actionId, summary, omitidas: prep.skipped.map(publicLine) };
    }

    if (this.elicitationSupported) {
      let response = null;
      try {
        response = await this.#sendRequest(
          "elicitation/create",
          {
            message: `${summary}\n\n¿Registrar estas horas en Odoo?`,
            requestedSchema: {
              type: "object",
              properties: {
                decision: {
                  type: "string",
                  title: "Decisión",
                  description: "confirmar registra las líneas; cancelar no escribe nada",
                  enum: ["confirmar", "cancelar"],
                },
              },
              required: ["decision"],
            },
          },
          { timeoutMs: this.elicitationTimeoutMs, toolCallId },
        );
      } catch {
        response = null;
      } finally {
        if (toolCallId !== undefined && toolCallId !== null) this.#elicitationByToolCall.delete(toolCallId);
      }

      if (response?.action === "accept" && response?.content?.decision === "confirmar") {
        await this.#audit({ etapa: "aprobada", action_id: actionId, via: "mcp_elicitation" });
        return this.#executeTimesheetsLocal(rawLines, uid, actionId, "mcp_elicitation");
      }
      const motivo = !response ? "timeout_or_error" : response.action === "decline" ? "user_declined" : "user_cancelled";
      await this.#audit({ etapa: "cancelada", action_id: actionId, via: "mcp_elicitation", motivo });
      return { status: "cancelled", action_id: actionId, message: "El usuario no aprobó el registro. No se escribió nada." };
    }

    this.#pendingLocalConfirmations.set(actionId, {
      fingerprint: this.#linesFingerprint(rawLines),
      expiresAt: this.now().getTime() + LOCAL_CONFIRMATION_TTL_MS,
    });
    return {
      status: "awaiting_confirmation",
      action_id: actionId,
      summary,
      expires_in_minutes: LOCAL_CONFIRMATION_TTL_MS / 60000,
      instrucciones:
        `Muestra este resumen al usuario. Solo si el usuario escribe en el chat exactamente 'APLICAR ${actionId}', ` +
        `vuelve a llamar registrar_horas con las mismas líneas y confirmacion='APLICAR ${actionId}'. ` +
        "No lo hagas por tu cuenta.",
    };
  }

  async #executeTimesheetsLocal(rawLines, uid, actionId, via) {
    // Se vuelve a preparar justo antes de escribir: idempotencia y límites con datos frescos.
    const prep = await prepareTimesheetRegistration(this.odoo, rawLines, this.#timesheetOptions(uid));
    const result = await executeTimesheetRegistration(this.odoo, prep);
    try {
      await this.#audit({
        etapa: result.success ? "ejecutada" : "fallida",
        action_id: actionId,
        via,
        creadas: result.creadas,
        omitidas: result.omitidas,
        ...(result.success ? {} : { error: result.error, fallida: result.fallida }),
      });
    } catch (error) {
      result.advertencia_auditoria = `No se pudo escribir la auditoría: ${error?.message || error}`;
    }
    return { ...result, action_id: actionId };
  }

  async #askUserApproval(result, toolCallId) {
    try {
      const params = {
        message: `${result.summary}\n\n¿Qué deseas hacer con esta acción?`,
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              title: "Decisión",
              description:
                "confirmar ejecuta la acción; cancelar la descarta; modificar la descarta para pedir cambios",
              enum: ["confirmar", "cancelar", "modificar"],
            },
            cambios: {
              type: "string",
              title: "Cambios (solo si eliges modificar)",
              maxLength: 500,
            },
          },
          required: ["decision"],
        },
      };

      let response;
      try {
        response = await this.#sendRequest("elicitation/create", params, {
          timeoutMs: this.elicitationTimeoutMs,
          toolCallId,
        });
      } catch {
        response = null;
      }

      if (response?.action === "accept" && response?.content?.decision === "confirmar") {
        return await decideApproval({
          db: this.db,
          odoo: this.odoo,
          clientId: this.client.id,
          actionId: result.action_id,
          decision: "confirm",
          deciderLinkedUserId: null,
          via: "mcp_elicitation",
        });
      }

      if (response?.action === "accept" && response?.content?.decision === "modificar") {
        const cambios = String(response.content.cambios || "").slice(0, 500);
        await decideApproval({
          db: this.db,
          odoo: this.odoo,
          clientId: this.client.id,
          actionId: result.action_id,
          decision: "modify",
          deciderLinkedUserId: null,
          via: "mcp_elicitation",
          note: cambios,
        });
        return {
          status: "modification_requested",
          action_id: result.action_id,
          cambios,
          message:
            "El usuario pidió cambios. Propón una nueva solicitud con los ajustes; requerirá una nueva aprobación.",
        };
      }

      let motivo = "user_declined";
      if (response?.action === "accept" && response?.content?.decision === "cancelar") {
        motivo = "user_cancelled";
      } else if (response?.action === "cancel") {
        motivo = "user_cancelled";
      } else if (response?.action === "decline") {
        motivo = "user_declined";
      } else if (!response) {
        motivo = "timeout_or_error";
      }

      try {
        await decideApproval({
          db: this.db,
          odoo: this.odoo,
          clientId: this.client.id,
          actionId: result.action_id,
          decision: "cancel",
          deciderLinkedUserId: null,
          via: "mcp_elicitation",
          note: motivo,
        });
      } catch {}

      return {
        status: "cancelled",
        action_id: result.action_id,
        message: "El usuario no aprobó la acción. No se ejecutó nada.",
      };
    } finally {
      if (toolCallId !== undefined && toolCallId !== null) {
        this.#elicitationByToolCall.delete(toolCallId);
      }
    }
  }

  startStdio(inStream = process.stdin, outStream = process.stdout) {
    this.#output = outStream;
    const rl = createInterface({ input: inStream, terminal: false });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      const response = await this.handleMessage(line);
      if (response) {
        outStream.write(`${JSON.stringify(response)}\n`);
      }
    });
    rl.on("close", () => {
      for (const [id, pending] of this.#pendingServerRequests.entries()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(
          new AppError(503, "client_disconnected", "El cliente MCP se desconectó.")
        );
      }
      this.#pendingServerRequests.clear();
      this.#elicitationByToolCall.clear();
    });
  }
}
