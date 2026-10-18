import { AppError } from "./errors.js";
import { executeOperationalAction } from "./operational-actions.js";
import { requireToolPolicy } from "./tools.js";
import { buildOdooDeepLink, dispatchNotification, formatEventNotificationText } from "./notifications.js";
import { decryptNamedSecret } from "./crypto.js";
import { createApprovalRequest, decideApproval } from "./approvals.js";
import { sendApprovalToTelegram } from "./approval-telegram.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requestOrExecuteAction({
  db,
  config,
  client,
  linkedUser = null,
  actionName,
  params,
  odoo,
  telegramChatId = null,
  approvalChannel = null,
  approver = null,
}) {
  // 1. Validar política de la herramienta en el cliente
  const policy = await requireToolPolicy(db, client.id, actionName);
  const riskLevel = Number(policy.risk_level || 1);
  const confirmationRequired = Boolean(policy.confirmation_required);
  const env = String(client.settings?.environment || "production").toLowerCase();
  const isUuid = typeof client?.id === "string" && UUID_REGEX.test(client.id);
  const isStaging = isUuid && (env === "staging" || env === "test");

  // En staging: Las acciones de Nivel 3 o con confirmación obligatoria se auto-aprueban
  // para agilizar pruebas de integración y desarrollo sin bloquear al usuario
  if (isStaging && (confirmationRequired || riskLevel >= 3)) {
    let result;
    try {
      result = await executeOperationalAction(actionName, odoo, params);
      await db.query(
        `INSERT INTO agent.action_executions
           (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'executed_staging', $7, $8)`,
        [
          client.id,
          linkedUser?.id || null,
          actionName,
          result.model || "unknown",
          result.record_id || null,
          riskLevel,
          JSON.stringify(params),
          JSON.stringify(result),
        ],
      );
      return {
        status: "executed",
        risk_level: riskLevel,
        staging_bypass: true,
        environment: "staging",
        note: "Auto-aprobado en entorno Staging para validación ágil.",
        result,
        supervisor_notified: false,
      };
    } catch (err) {
      await db.query(
        `INSERT INTO agent.action_executions
           (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8)`,
        [
          client.id,
          linkedUser?.id || null,
          actionName,
          params.model || "unknown",
          params.resId ? Number(params.resId) : null,
          riskLevel,
          JSON.stringify(params),
          JSON.stringify({ error: err.message }),
        ],
      );
      throw err;
    }
  }

  // Nivel 1 o 2 sin confirmación obligatoria: ejecución directa
  if (!confirmationRequired && riskLevel <= 2) {
    let result;
    try {
      result = await executeOperationalAction(actionName, odoo, params);
      await db.query(
        `INSERT INTO agent.action_executions
           (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'executed', $7, $8)`,
        [
          client.id,
          linkedUser?.id || null,
          actionName,
          result.model || "unknown",
          result.record_id || null,
          riskLevel,
          JSON.stringify(params),
          JSON.stringify(result),
        ],
      );
    } catch (err) {
      await db.query(
        `INSERT INTO agent.action_executions
           (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
         VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8)`,
        [
          client.id,
          linkedUser?.id || null,
          actionName,
          params.model || "unknown",
          params.resId ? Number(params.resId) : null,
          riskLevel,
          JSON.stringify(params),
          JSON.stringify({ error: err.message }),
        ],
      );
      throw err;
    }

    // Nivel 2: Asistido con aviso al supervisor (solo en producción para no generar spam en staging)
    let supervisorNotified = false;
    if (riskLevel === 2 && !isStaging) {
      const deepLink = result.record_id && result.model
        ? buildOdooDeepLink(client.odoo_base_url, result.model, result.record_id)
        : null;

      const channelRes = await db.query(
        `SELECT token_ciphertext AS ciphertext,
                token_nonce AS nonce,
                token_auth_tag AS auth_tag,
                token_key_version AS key_version
           FROM agent.channel_credentials
          WHERE client_id = $1 AND active AND channel = 'telegram'`,
        [client.id],
      );

      const supervisorChatId = client.settings?.supervisor_chat_id || client.settings?.alert_chat_id;
      if (channelRes.rows[0] && supervisorChatId) {
        const botToken = decryptNamedSecret(
          channelRes.rows[0],
          config.credentialMasterKey,
          "telegram-bot-token",
        );
        const text = formatEventNotificationText({
          title: "Acción Operativa Asistida (Nivel 2)",
          modelLabel: result.model,
          recordName: `#${result.record_id}`,
          summary: `${result.summary} (Verifique si requiere ajuste).`,
          deepLink,
          urgency: "normal",
        });
        await dispatchNotification({
          telegram: { botToken, chatId: supervisorChatId, text },
        });
        supervisorNotified = true;
      }
    }

    return {
      status: "executed",
      risk_level: riskLevel,
      result,
      supervisor_notified: supervisorNotified,
    };
  }

  // Nivel 3: Aprobación obligatoria interactiva (Human-in-the-Loop)
  if (!approvalChannel) {
    throw new AppError(
      409,
      "approval_channel_unavailable",
      "Esta acción requiere aprobación humana y no hay un canal de aprobación disponible (Telegram vinculado o cliente MCP con soporte de preguntas).",
    );
  }

  if (approvalChannel === "telegram" || approvalChannel === "workflow") {
    if (!approver?.id || !approver?.telegram_chat_id) {
      throw new AppError(
        409,
        "approval_channel_unavailable",
        "Esta acción requiere aprobación humana y no hay un canal de aprobación disponible (Telegram vinculado o cliente MCP con soporte de preguntas).",
      );
    }
  }

  const request = await createApprovalRequest({
    db,
    odoo,
    client,
    linkedUser,
    approverLinkedUserId: approver?.id ?? null,
    actionName,
    params,
    channel: approvalChannel,
    telegramChatId: approver?.telegram_chat_id ?? telegramChatId ?? null,
  });

  if (approvalChannel === "telegram" || approvalChannel === "workflow") {
    try {
      await sendApprovalToTelegram({
        db,
        config,
        clientId: client.id,
        chatId: approver.telegram_chat_id,
        actionId: request.actionId,
        summaryText: request.summaryText,
      });
    } catch (err) {
      // Si nadie recibió la solicitud, no debe quedar pendiente de aprobación.
      await db.query(
        `UPDATE agent.pending_actions
            SET status = 'cancelled', decision_note = 'telegram_delivery_failed'
          WHERE id = $1 AND client_id = $2 AND status = 'pending'`,
        [request.actionId, client.id],
      );
      throw err;
    }
  }

  let messageText;
  if (approvalChannel === "telegram" || approvalChannel === "workflow") {
    messageText = "Se envió la solicitud de aprobación por Telegram. La acción se ejecutará solo cuando la persona la confirme.";
  } else if (approvalChannel === "admin") {
    messageText = "Pendiente de aprobación por un administrador.";
  } else if (approvalChannel === "mcp_elicitation") {
    messageText = "Pendiente de aprobación del usuario.";
  } else {
    messageText = "Pendiente de aprobación.";
  }

  return {
    status: "awaiting_approval",
    risk_level: 3,
    action_id: request.actionId,
    channel: approvalChannel,
    expires_at: request.expiresAt,
    summary: request.summaryText,
    items: request.items.map((i) => ({ resId: i.resId, display: i.display })),
    excluded: request.excluded,
    message: messageText,
  };
}

export async function confirmOperationalAction({
  db,
  odoo,
  clientId,
  actionId,
  decision = "confirm",
  confirmedByUserId = null,
  via = "admin",
  note = null,
}) {
  return decideApproval({
    db,
    odoo,
    clientId,
    actionId,
    decision,
    deciderLinkedUserId: confirmedByUserId,
    via,
    note,
  });
}

export async function findSupervisorApprover(db, client) {
  const supervisorChatId = client?.settings?.supervisor_chat_id || client?.settings?.alert_chat_id;
  if (!supervisorChatId) {
    return null;
  }

  const res = await db.query(
    `SELECT id, telegram_chat_id, telegram_user_id
       FROM agent.linked_users
      WHERE client_id = $1 AND active AND (telegram_chat_id = $2 OR telegram_user_id = $2)
      LIMIT 1`,
    [client.id, supervisorChatId],
  );

  const row = res?.rows?.[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    telegram_chat_id: row.telegram_chat_id ?? row.telegram_user_id,
  };
}
