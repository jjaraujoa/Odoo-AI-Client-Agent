import { AppError } from "./errors.js";
import { decryptSecret } from "./crypto.js";

export async function resolveIdentity(
  db,
  telegramUserId,
  telegramChatId,
  masterKey,
  clientId = null,
) {
  const result = await db.query(
    `SELECT
        u.*, c.slug AS client_slug, c.name AS client_name, c.odoo_base_url,
        c.odoo_database, c.timezone, c.response_style, c.prohibited_fields,
        c.settings AS client_settings,
        cr.ciphertext, cr.nonce, cr.auth_tag, cr.key_version
       FROM agent.linked_users u
       JOIN agent.clients c ON c.id = u.client_id AND c.active
       JOIN agent.odoo_credentials cr ON cr.linked_user_id = u.id
      WHERE u.telegram_user_id = $1 AND u.active
        AND ($2::uuid IS NULL OR u.client_id = $2)
      ORDER BY u.created_at
      LIMIT 2`,
    [telegramUserId, clientId],
  );
  if (!result.rows.length) {
    throw new AppError(403, "user_not_linked", "Tu cuenta de Telegram no está vinculada a un usuario activo de Odoo.");
  }
  if (result.rows.length > 1) {
    throw new AppError(409, "ambiguous_tenant", "La cuenta está vinculada a más de un cliente; falta seleccionar el cliente.");
  }
  const identity = result.rows[0];
  if (identity.telegram_chat_id && Number(identity.telegram_chat_id) !== Number(telegramChatId)) {
    throw new AppError(403, "chat_not_allowed", "Esta vinculación no está autorizada para este chat.");
  }
  identity.odooApiKey = decryptSecret(identity, masterKey);
  await db.query(
    "UPDATE agent.odoo_credentials SET last_used_at = now() WHERE linked_user_id = $1",
    [identity.id],
  );
  return identity;
}
