import { AppError } from "./errors.js";
import { decryptNamedSecret } from "./crypto.js";
import { fetchJson } from "./http.js";
import { deliverTelegramMessage } from "./telegram.js";
import { setApprovalTelegramMessage, decideApproval } from "./approvals.js";


const CALLBACK_REGEX = /^ap:([cxm]):([0-9a-f]{32})$/;

/**
 * Construye el teclado inline para aprobación de acciones operativas de Nivel 3.
 * Garantiza que callback_data <= 64 bytes.
 */
export function buildApprovalKeyboard(actionId) {
  const hex = String(actionId || "").replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new AppError(400, "invalid_action_id", "Identificador de acción inválido para generar el teclado.");
  }

  return {
    inline_keyboard: [
      [
        { text: "✅ Confirmar", callback_data: `ap:c:${hex}` },
        { text: "❌ Cancelar", callback_data: `ap:x:${hex}` },
        { text: "✏️ Modificar", callback_data: `ap:m:${hex}` },
      ],
    ],
  };
}

/**
 * Parsea y valida el callback_data de una decisión de aprobación de Telegram.
 */
export function parseApprovalCallback(data) {
  if (typeof data !== "string") {
    return null;
  }
  const match = CALLBACK_REGEX.exec(data);
  if (!match) {
    return null;
  }

  const [, code, hex] = match;
  const decisionMap = {
    c: "confirm",
    x: "cancel",
    m: "modify",
  };
  const decision = decisionMap[code];
  if (!decision) {
    return null;
  }

  const actionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return {
    decision,
    actionId,
  };
}

/**
 * Resuelve y descifra el bot token de Telegram configurado para el cliente.
 */
export async function resolveTelegramBotToken(db, config, clientId) {
  const channelRes = await db.query(
    `SELECT token_ciphertext AS ciphertext,
            token_nonce AS nonce,
            token_auth_tag AS auth_tag,
            token_key_version AS key_version
       FROM agent.channel_credentials
      WHERE client_id = $1 AND active AND channel = 'telegram'`,
    [clientId],
  );
  const row = channelRes?.rows?.[0];
  if (!row) {
    return null;
  }
  return decryptNamedSecret(
    row,
    config.credentialMasterKey,
    "telegram-bot-token",
  );
}

/**
 * Envía la solicitud de aprobación humana al chat de Telegram con teclado interactivo.
 */
export async function sendApprovalToTelegram({
  db,
  config,
  clientId,
  chatId,
  actionId,
  summaryText,
  deliver = deliverTelegramMessage,
}) {
  const botToken = await resolveTelegramBotToken(db, config, clientId);
  if (!botToken) {
    throw new AppError(
      409,
      "approval_channel_unavailable",
      "No hay canal de Telegram configurado para aprobar esta acción.",
    );
  }

  const replyMarkup = buildApprovalKeyboard(actionId);
  const text = `${summaryText}\n\nToca un botón para decidir.`;

  const result = await deliver(botToken, {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    protect_content: true,
  });

  if (result?.message_id) {
    await setApprovalTelegramMessage(db, actionId, result.message_id);
  }

  return result;
}

/**
 * Edita un mensaje de Telegram para actualizar texto o quitar teclado interactivo.
 * Errores de Telegram se ignoran porque editar es cosmético.
 */
export async function editTelegramMessage(
  botToken,
  { chatId, messageId, text = null, removeKeyboard = true },
  { request = fetchJson } = {},
) {
  try {
    if (text !== null && text !== undefined) {
      return await request(
        `https://api.telegram.org/bot${botToken}/editMessageText`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text,
            reply_markup: removeKeyboard ? { inline_keyboard: [] } : undefined,
          }),
        },
        10_000,
      );
    }
    return await request(
      `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        }),
      },
      10_000,
    );
  } catch {
    return null;
  }
}

/**
 * Responde a una consulta de callback query de Telegram.
 */
export async function answerTelegramCallback(
  botToken,
  callbackQueryId,
  text = null,
  { request = fetchJson } = {},
) {
  try {
    const payload = { callback_query_id: callbackQueryId };
    if (text !== null && text !== undefined) {
      payload.text = text;
    }
    return await request(
      `https://api.telegram.org/bot${botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      10_000,
    );
  } catch {
    return null;
  }
}

/**
 * Determina si la actualización entrante de Telegram corresponde a un botón de aprobación interactiva.
 */
export function isApprovalCallback(parsed) {
  return Boolean(parsed?.callbackId) && typeof parsed.text === "string" && parsed.text.startsWith("ap:");
}

/**
 * Procesa el callback interactivo de Telegram para una decisión de aprobación de Nivel 3.
 */
export async function processApprovalCallback({
  db,
  odoo,
  identity,
  parsed,
  botToken,
  session = null,
  deps = {},
}) {
  const {
    decide = decideApproval,
    edit = editTelegramMessage,
    answer = answerTelegramCallback,
    remember = null,
  } = deps;

  const cb = parseApprovalCallback(parsed.text);
  if (!cb) {
    throw new AppError(400, "invalid_callback", "Botón no válido.");
  }

  await answer(botToken, parsed.callbackId, "Procesando…");
  parsed.callbackId = undefined;

  let result;
  try {
    result = await decide({
      db,
      odoo,
      clientId: identity.client_id,
      actionId: cb.actionId,
      decision: cb.decision,
      deciderLinkedUserId: identity.id,
      via: "telegram",
    });
  } catch (err) {
    await edit(botToken, { chatId: parsed.chatId, messageId: parsed.messageId });
    throw err;
  }

  await edit(botToken, { chatId: parsed.chatId, messageId: parsed.messageId });

  if (cb.decision === "confirm") {
    const itemLines = (result.results || []).map((it) => {
      let statusStr;
      if (it.status === "executed") {
        statusStr = "ejecutada";
      } else if (it.status === "skipped") {
        statusStr = "omitida (cambió desde la aprobación)";
      } else {
        statusStr = `fallida: ${it.error || "error"}`;
      }
      return `• #${it.resId}: ${statusStr}`;
    });
    const header = `✅ Aprobado.\n${result.summaryText}`;
    const text = itemLines.length > 0 ? `${header}\n${itemLines.join("\n")}` : header;
    const recordIds = (result.results || [])
      .filter((it) => it.status === "executed")
      .map((it) => it.resId);

    return {
      text,
      eventType: "operational_approval",
      toolName: result.actionName,
      recordIds,
    };
  }

  if (cb.decision === "cancel") {
    return {
      text: "❌ Solicitud cancelada. No se ejecutó nada.",
      eventType: "operational_approval_cancel",
    };
  }

  if (cb.decision === "modify") {
    if (typeof remember === "function") {
      await remember("assistant", "summary", {
        modification_requested: true,
        action: result.actionName,
        records: result.records,
      });
    }
    return {
      text: "✏️ Solicitud cancelada para modificarla. Escribe qué quieres cambiar y se preparará una nueva solicitud.",
      eventType: "operational_approval_modify",
    };
  }

  throw new AppError(400, "invalid_decision", "Decisión no soportada.");
}

