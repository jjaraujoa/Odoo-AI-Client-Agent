import { deliverTelegramMessage } from "./telegram.js";

export function buildOdooDeepLink(baseUrl, model, resId) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  return `${cleanBase}/web#id=${encodeURIComponent(resId)}&model=${encodeURIComponent(model)}&view_type=form`;
}

export function formatEventNotificationText({
  title,
  modelLabel,
  recordName,
  summary,
  deepLink,
  urgency = "normal",
}) {
  const icon = urgency === "critical" ? "🚨" : urgency === "high" ? "⚠️" : "ℹ️";
  const lines = [
    `${icon} *${title}*`,
    "",
    `• *Registro*: ${modelLabel || "Documento"} ${recordName ? `\`${recordName}\`` : ""}`.trim(),
    summary ? `• *Detalle*: ${summary}` : null,
    deepLink ? `\n🔗 [Ver en Odoo](${deepLink})` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

export async function dispatchNotification({
  telegram = null,
  odoo = null,
}) {
  const delivered = [];

  if (telegram?.botToken && telegram?.chatId && telegram?.text) {
    await deliverTelegramMessage(telegram.botToken, {
      chat_id: telegram.chatId,
      text: telegram.text,
      protect_content: false,
    });
    delivered.push("telegram");
  }

  if (odoo?.client && odoo?.model && odoo?.resId && odoo?.body) {
    await odoo.client.postChatterMessage(
      odoo.model,
      odoo.resId,
      odoo.body,
      { partnerIds: odoo.partnerIds || [] },
    );
    delivered.push("odoo_chatter");
  }

  return delivered;
}
