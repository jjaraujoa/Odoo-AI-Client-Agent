import { AppError } from "./errors.js";
import { decryptNamedSecret } from "./crypto.js";
import { buildOdooDeepLink, dispatchNotification } from "./notifications.js";
import { getModelLabel } from "./events.js";

export function formatDigestMessage({
  clientName,
  role,
  events,
  baseUrl,
}) {
  const timestamp = new Date().toLocaleDateString("es-CO", {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const header = `📋 *Resumen Operativo: ${clientName}*\n📅 _${timestamp}_ | Área: *${role.toUpperCase()}*\n`;

  if (!events || events.length === 0) {
    return `${header}\n✅ *Todo al día*: No hay novedades o incidencias pendientes en este periodo.`;
  }

  // Agrupar eventos por modelo
  const byModel = new Map();
  for (const event of events) {
    const list = byModel.get(event.model) || [];
    list.push(event);
    byModel.set(event.model, list);
  }

  const sections = [];
  for (const [model, modelEvents] of byModel.entries()) {
    const label = getModelLabel(model);
    const lines = [`*${label}* (${modelEvents.length}):`];
    for (const item of modelEvents.slice(0, 10)) {
      const name = item.payload?.fields?.name || item.payload?.fields?.display_name || `#${item.res_id}`;
      const link = buildOdooDeepLink(baseUrl, model, item.res_id);
      const summary = item.payload?.summary ? ` - ${item.payload.summary}` : "";
      lines.push(`• [${name}](${link})${summary}`);
    }
    if (modelEvents.length > 10) {
      lines.push(`_... y ${modelEvents.length - 10} más._`);
    }
    sections.push(lines.join("\n"));
  }

  return `${header}\n${sections.join("\n\n")}\n\n_Mensaje consolidado para evitar saturación de alertas._`;
}

export async function generateOperationalDigest({
  db,
  config,
  clientSlug,
  role = "general",
}) {
  if (!clientSlug) {
    throw new AppError(400, "missing_client_slug", "Debe proporcionar client_slug.");
  }

  const clientRes = await db.query(
    `SELECT id, slug, name, odoo_base_url, settings
       FROM agent.clients
      WHERE slug = $1 AND active`,
    [clientSlug],
  );
  const client = clientRes.rows[0];
  if (!client) {
    throw new AppError(404, "client_not_found", "Cliente no encontrado.");
  }

  // Obtener eventos pendientes no incluidos en digests anteriores
  const pendingEventsRes = await db.query(
    `SELECT id, model, res_id, event_type, priority, payload, created_at
       FROM agent.events
      WHERE client_id = $1 AND status = 'pending' AND digest_id IS NULL
      ORDER BY created_at ASC
      LIMIT 100`,
    [client.id],
  );
  const events = pendingEventsRes.rows;

  const digestText = formatDigestMessage({
    clientName: client.name,
    role,
    events,
    baseUrl: client.odoo_base_url,
  });

  // Despachar a Telegram si está configurado
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

  const digestChatId = client.settings?.digest_chat_id || client.settings?.alert_chat_id;
  const deliveredChannels = [];

  if (botToken && digestChatId) {
    const delivered = await dispatchNotification({
      telegram: {
        botToken,
        chatId: digestChatId,
        text: digestText,
      },
    });
    deliveredChannels.push(...delivered);
  }

  // Registrar digest
  const digestRes = await db.query(
    `INSERT INTO agent.digests
       (client_id, role, summary, event_count, delivered_channels)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [client.id, role, digestText, events.length, JSON.stringify(deliveredChannels)],
  );
  const digestId = digestRes.rows[0].id;

  // Actualizar eventos como procesados y asociados a este digest
  if (events.length > 0) {
    const eventIds = events.map((e) => e.id);
    await db.query(
      `UPDATE agent.events
          SET status = 'processed', digest_id = $1, processed_at = now()
        WHERE id = ANY($2::uuid[])`,
      [digestId, eventIds],
    );
  }

  return {
    digest_id: digestId,
    client_slug: clientSlug,
    role,
    event_count: events.length,
    delivered_channels: deliveredChannels,
    text: digestText,
  };
}
