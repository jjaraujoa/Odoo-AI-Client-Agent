import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { decryptNamedSecret, decryptSecret } from "./crypto.js";
import { buildOdooDeepLink, dispatchNotification, formatEventNotificationText } from "./notifications.js";
import { OdooJson2Client } from "./odoo.js";
import { processEventThroughWorkflows } from "./workflow-engine.js";

export function computeEventFingerprint(clientId, model, resId, payload) {
  const content = [
    clientId,
    model,
    resId,
    payload.write_date || payload.event_type || "",
    payload.fields?.state || "",
    payload.fields?.priority || "",
  ].join(":");
  return createHash("sha256").update(content).digest("hex");
}

export function isLoopEvent(payload, client) {
  const botUserId = client.settings?.bot_service_user_id || client.service_user_id;
  if (!botUserId) return false;

  const eventWriteUid = Number(payload.write_uid || payload.user_id);
  if (Number.isInteger(eventWriteUid) && eventWriteUid === Number(botUserId)) {
    return true;
  }

  if (payload.is_bot_generated === true) {
    return true;
  }

  return false;
}

export function classifyEventPriority(model, payload) {
  const fields = payload.fields || {};
  const isUrgentPriority = fields.priority === "1" || fields.priority === "2" || fields.priority === 1;
  const isExplicitUrgent = fields.is_urgent === true || fields.urgent === true;

  if (isUrgentPriority || isExplicitUrgent) {
    return "critical";
  }

  if (model === "stock.picking" && fields.state === "assigned") {
    return "high";
  }

  if (model === "sale.order" && Number(fields.amount_total) >= 10_000_000) {
    return "high";
  }

  if (model === "account.move" && fields.payment_state === "not_paid" && fields.state === "posted") {
    return "normal";
  }

  return "normal";
}

export function getModelLabel(model) {
  const map = {
    "sale.order": "Orden de venta",
    "purchase.order": "Orden de compra",
    "account.move": "Factura",
    "stock.picking": "Albarán / Movimiento de almacén",
    "product.product": "Producto",
    "res.partner": "Contacto / Cliente",
  };
  return map[model] || model;
}

export async function processOdooEvent({ db, config, body }) {
  if (!body || typeof body !== "object") {
    throw new AppError(400, "invalid_event_body", "El cuerpo del evento no es un objeto válido.");
  }

  const { client_slug, model, res_id, event_type = "on_write", write_uid } = body;
  if (!client_slug || typeof client_slug !== "string") {
    throw new AppError(400, "missing_client_slug", "Falta el identificador del cliente (client_slug).");
  }
  if (!model || typeof model !== "string" || !/^[a-z0-9_.]+$/.test(model)) {
    throw new AppError(400, "invalid_model", "El modelo de Odoo es inválido o no fue especificado.");
  }
  const recordId = Number(res_id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    throw new AppError(400, "invalid_res_id", "El identificador del registro (res_id) es inválido.");
  }

  // 1. Obtener cliente activo
  const clientRes = await db.query(
    `SELECT id, slug, name, odoo_base_url, odoo_database, timezone, active, settings
       FROM agent.clients
      WHERE slug = $1 AND active`,
    [client_slug],
  );
  const client = clientRes.rows[0];
  if (!client) {
    throw new AppError(404, "client_not_found", "Cliente no encontrado o inactivo.");
  }

  // 2. Barrera Anti-Bucles: ¿El evento fue originado por el bot?
  if (isLoopEvent(body, client)) {
    await db.query(
      `INSERT INTO agent.events
         (client_id, model, res_id, event_type, write_uid, priority, status, payload, processed_at)
       VALUES ($1, $2, $3, $4, $5, 'low', 'ignored_loop', $6, now())`,
      [client.id, model, recordId, event_type, write_uid || null, JSON.stringify(body)],
    );
    return {
      status: "ignored_loop",
      reason: "originated_by_bot",
      model,
      res_id: recordId,
    };
  }

  // 3. Deduplicación por Huella (Debounce)
  const fingerprint = computeEventFingerprint(client.id, model, recordId, body);
  const isFresh = await db.query(
    "SELECT agent.check_and_record_deduplication($1, $2, 60) AS fresh",
    [client.id, fingerprint],
  );

  if (!isFresh.rows[0]?.fresh) {
    await db.query(
      `INSERT INTO agent.events
         (client_id, model, res_id, event_type, write_uid, priority, status, payload, processed_at)
       VALUES ($1, $2, $3, $4, $5, 'low', 'ignored_duplicate', $6, now())`,
      [client.id, model, recordId, event_type, write_uid || null, JSON.stringify(body)],
    );
    return {
      status: "ignored_duplicate",
      reason: "debounce_window",
      model,
      res_id: recordId,
    };
  }

  // 4. Clasificación de Prioridad
  const priority = classifyEventPriority(model, body);
  const recordName = body.fields?.name || body.fields?.display_name || `#${recordId}`;
  const deepLink = buildOdooDeepLink(client.odoo_base_url, model, recordId);
  const modelLabel = getModelLabel(model);

  // Registrar evento
  const insertRes = await db.query(
    `INSERT INTO agent.events
       (client_id, model, res_id, event_type, write_uid, priority, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      client.id,
      model,
      recordId,
      event_type,
      write_uid || null,
      priority,
      ["critical", "high"].includes(priority) ? "processed" : "pending",
      JSON.stringify(body),
    ],
  );
  const eventId = insertRes.rows[0].id;

  // 5. Despacho inmediato para eventos Críticos o Altos
  const dispatchedChannels = [];
  if (["critical", "high"].includes(priority)) {
    // Resolver credenciales de Telegram si existen
    const channelRes = await db.query(
      `SELECT token_ciphertext, token_nonce, token_auth_tag, token_key_version
         FROM agent.channel_credentials
        WHERE client_id = $1 AND active AND channel = 'telegram'`,
      [client.id],
    );

    let botToken = null;
    if (channelRes.rows[0]) {
      botToken = decryptNamedSecret(
        channelRes.rows[0],
        config.credentialMasterKey,
        "telegram-bot-token",
      );
    }

    const alertChatId = client.settings?.alert_chat_id;
    const notificationText = formatEventNotificationText({
      title: priority === "critical" ? "Atención Urgente Requerida" : "Notificación de Proceso",
      modelLabel,
      recordName,
      summary: body.summary || (priority === "critical" ? "Registro marcado como prioritario." : "Actualización de estado operativo."),
      deepLink,
      urgency: priority,
    });

    try {
      const delivered = await dispatchNotification({
        telegram: botToken && alertChatId ? {
          botToken,
          chatId: alertChatId,
          text: notificationText,
        } : null,
      });
      dispatchedChannels.push(...delivered);

      await db.query(
        `UPDATE agent.events
            SET status = 'processed', processed_at = now(), dispatched_channels = $2
          WHERE id = $1`,
        [eventId, JSON.stringify(dispatchedChannels)],
      );
    } catch (err) {
      await db.query(
        `UPDATE agent.events
            SET status = 'failed', error_message = $2
          WHERE id = $1`,
        [eventId, err.message],
      );
    }
  }

  // 6. Evaluación y ejecución de flujos de trabajo declarativos (Fase 4)
  let workflowExecutions = null;
  try {
    const userRes = await db.query(
      `SELECT u.*, c.ciphertext, c.nonce, c.auth_tag, c.key_version
         FROM agent.linked_users u
         JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
        WHERE u.client_id = $1 AND u.active
        ORDER BY u.created_at ASC LIMIT 1`,
      [client.id],
    );
    let odooClient = null;
    if (userRes.rows[0]) {
      const apiKey = decryptSecret(userRes.rows[0], config.credentialMasterKey);
      odooClient = new OdooJson2Client({
        baseUrl: client.odoo_base_url,
        database: client.odoo_database,
        apiKey,
      });
    }
    workflowExecutions = await processEventThroughWorkflows({
      db,
      config,
      odoo: odooClient,
      client,
      event: {
        model,
        res_id: recordId,
        event: event_type,
        values: body.fields || {},
        write_uid,
      },
    });
  } catch (wfErr) {
    process.stderr.write(`[events] Error evaluando flujos para ${model}:${recordId}: ${wfErr.message}\n`);
  }

  return {
    event_id: eventId,
    status: ["critical", "high"].includes(priority) ? "processed" : "pending",
    priority,
    dispatched_channels: dispatchedChannels,
    deep_link: deepLink,
    workflows: workflowExecutions,
  };
}
