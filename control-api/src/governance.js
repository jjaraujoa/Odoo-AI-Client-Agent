import { randomInt, randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { executeOperationalAction } from "./operational-actions.js";
import { requireToolPolicy } from "./tools.js";
import { buildOdooDeepLink, dispatchNotification, formatEventNotificationText } from "./notifications.js";
import { decryptNamedSecret } from "./crypto.js";

export async function requestOrExecuteAction({
  db,
  config,
  client,
  linkedUser = null,
  actionName,
  params,
  odoo,
  telegramChatId = null,
}) {
  // 1. Validar política de la herramienta en el cliente
  const policy = await requireToolPolicy(db, client.id, actionName);
  const riskLevel = Number(policy.risk_level || 1);
  const confirmationRequired = Boolean(policy.confirmation_required);

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

    // Nivel 2: Asistido con aviso al supervisor
    let supervisorNotified = false;
    if (riskLevel === 2) {
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
  const confirmationCode = String(randomInt(100000, 999999));
  const idempotencyKey = randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos de caducidad

  const insertPending = await db.query(
    `INSERT INTO agent.pending_actions
       (client_id, linked_user_id, telegram_chat_id, action_type, status, preview, idempotency_key, confirmation_code, expires_at)
     VALUES ($1, $2, $3, 'operational_action', 'pending', $4, $5, $6, $7)
     RETURNING id`,
    [
      client.id,
      linkedUser?.id || null,
      telegramChatId || client.settings?.alert_chat_id || 0,
      JSON.stringify({ actionName, params, summary: `Confirmación requerida para ${actionName}` }),
      idempotencyKey,
      confirmationCode,
      expiresAt.toISOString(),
    ],
  );

  const actionId = insertPending.rows[0].id;

  await db.query(
    `INSERT INTO agent.action_executions
       (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
     VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_approval', $7, $8)`,
    [
      client.id,
      linkedUser?.id || null,
      actionName,
      params.model || "unknown",
      params.resId ? Number(params.resId) : null,
      3,
      JSON.stringify(params),
      JSON.stringify({ action_id: actionId, confirmation_code: confirmationCode }),
    ],
  );

  return {
    status: "awaiting_approval",
    risk_level: 3,
    action_id: actionId,
    confirmation_code: confirmationCode,
    expires_at: expiresAt.toISOString(),
    message: `Acción crítica requiere aprobación. Código: ${confirmationCode} (Expira en 5 min).`,
  };
}

export async function confirmOperationalAction({
  db,
  odoo,
  actionId,
  confirmationCode,
  confirmedByUserId = null,
}) {
  const pendingRes = await db.query(
    `SELECT * FROM agent.pending_actions
      WHERE id = $1 AND status = 'pending'`,
    [actionId],
  );
  const action = pendingRes.rows[0];
  if (!action) {
    throw new AppError(404, "action_not_found", "La solicitud de acción no existe o ya no está pendiente.");
  }

  if (new Date() > new Date(action.expires_at)) {
    await db.query("UPDATE agent.pending_actions SET status = 'expired' WHERE id = $1", [actionId]);
    throw new AppError(410, "action_expired", "La solicitud de confirmación ha expirado.");
  }

  if (action.confirmation_code !== String(confirmationCode).trim()) {
    throw new AppError(400, "invalid_confirmation_code", "Código de confirmación incorrecto.");
  }

  const { actionName, params } = action.preview;
  let result;
  try {
    result = await executeOperationalAction(actionName, odoo, params);
    await db.query(
      `UPDATE agent.pending_actions
          SET status = 'completed', completed_at = now(), result = $2
        WHERE id = $1`,
      [actionId, JSON.stringify(result)],
    );
    await db.query(
      `INSERT INTO agent.action_executions
         (client_id, linked_user_id, action_name, model, res_id, risk_level, status, input_params, result_data)
       VALUES ($1, $2, $3, $4, $5, 3, 'approved', $6, $7)`,
      [
        action.client_id,
        confirmedByUserId,
        actionName,
        result.model || "unknown",
        result.record_id || null,
        JSON.stringify(params),
        JSON.stringify(result),
      ],
    );
  } catch (err) {
    await db.query(
      `UPDATE agent.pending_actions
          SET status = 'failed', error_code = $2, result = $3
        WHERE id = $1`,
      [actionId, err.code || "execution_error", JSON.stringify({ message: err.message })],
    );
    throw err;
  }

  return {
    status: "completed",
    result,
  };
}
