import modXlsx from "xlsx";
import { AppError } from "./errors.js";
import { encryptSecret } from "./crypto.js";
import { OdooJson2Client } from "./odoo.js";

const XLSX = modXlsx.default || modXlsx;

function cleanString(val) {
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

function parseBool(val) {
  if (typeof val === "boolean") return val;
  const s = cleanString(val).toLowerCase();
  return /^(true|si|sí|1)$/i.test(s);
}

/**
 * Lee la plantilla Excel y extrae las secciones Cliente y Usuarios
 */
export function readClientWorkbook(filePath) {
  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (err) {
    throw new AppError(400, "invalid_excel_file", `No se pudo leer el archivo Excel: ${err.message}`);
  }

  // 1. Extraer datos de la hoja Cliente si existe
  const clientData = {};
  if (workbook.Sheets["Cliente"]) {
    const rawClient = XLSX.utils.sheet_to_json(workbook.Sheets["Cliente"], { header: 1 });
    // Busca las filas tipo [campo, valor, ...]
    for (const row of rawClient) {
      if (Array.isArray(row) && row.length >= 2 && typeof row[0] === "string") {
        const key = cleanString(row[0]);
        if (["slug", "name", "odoo_base_url", "odoo_database", "timezone", "active"].includes(key)) {
          clientData[key] = cleanString(row[1]);
        }
      }
    }
  }

  // 2. Extraer usuarios de la hoja Usuarios
  const users = [];
  if (workbook.Sheets["Usuarios"]) {
    const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets["Usuarios"], { header: 1 });
    let headerRowIndex = -1;

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      if (Array.isArray(row) && cleanString(row[0]).toLowerCase() === "row_id") {
        headerRowIndex = i;
        break;
      }
    }

    if (headerRowIndex !== -1) {
      const headers = rawRows[headerRowIndex].map((h) => cleanString(h).toLowerCase());
      for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!Array.isArray(row) || !row[0]) continue;

        const rowObj = {};
        for (let c = 0; c < headers.length; c++) {
          rowObj[headers[c]] = row[c] !== undefined ? row[c] : "";
        }

        const rowId = cleanString(rowObj.row_id);
        if (!rowId) continue;

        users.push({
          rowId,
          active: parseBool(rowObj.activo ?? rowObj.active),
          odooLogin: cleanString(rowObj.odoo_login),
          telegramUserId: cleanString(rowObj.telegram_user_id),
          telegramUsername: cleanString(rowObj.telegram_username).replace(/^@/, ""),
          requestApiKey: parseBool(rowObj.suministrar_api_key),
          odooApiKey: cleanString(rowObj.odoo_api_key || rowObj.api_key),
        });
      }
    }
  }

  return {
    client: clientData,
    users,
  };
}

/**
 * Sincroniza y valida los empleados de la plantilla Excel contra Odoo y PostgreSQL
 */
export async function syncUsersFromWorkbook({
  db,
  config,
  client,
  filePath,
  userApiKeys = {},
}) {
  const parsed = readClientWorkbook(filePath);
  const results = {
    total: parsed.users.length,
    active: 0,
    drafts: 0,
    verified: 0,
    errors: [],
    users: [],
  };

  const masterKey = config?.credentialMasterKey;

  for (const user of parsed.users) {
    const telegramId = user.telegramUserId ? Number(user.telegramUserId) : null;
    const apiKey = user.odooApiKey || userApiKeys[user.rowId] || userApiKeys[user.odooLogin] || null;

    let odooUid = null;
    let verified = false;

    // Si tiene API key y URL de Odoo, validar en tiempo real
    if (apiKey && client.odoo_base_url) {
      try {
        const odooClient = new OdooJson2Client({
          baseUrl: client.odoo_base_url,
          database: client.odoo_database,
          apiKey,
          timeoutMs: 10_000,
        });
        const context = await odooClient.call("res.users", "context_get", {});
        odooUid = Number(context?.uid);
        verified = Boolean(Number.isSafeInteger(odooUid) && odooUid > 0);
      } catch (err) {
        results.errors.push({
          rowId: user.rowId,
          error: `Error validando API Key en Odoo para ${user.odooLogin}: ${err.message}`,
        });
      }
    }

    if (user.active) {
      results.active++;
    } else {
      results.drafts++;
    }

    if (verified) {
      results.verified++;
    }

    // Persistir en base de datos si está conectada
    if (db) {
      try {
        const linkedRes = await db.query(
          `INSERT INTO agent.linked_users
             (client_id, onboarding_row_id, odoo_login, odoo_user_id,
              telegram_user_id, telegram_chat_id, telegram_username, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (client_id, telegram_user_id) DO UPDATE SET
             odoo_login = EXCLUDED.odoo_login,
             odoo_user_id = COALESCE(EXCLUDED.odoo_user_id, agent.linked_users.odoo_user_id),
             telegram_username = EXCLUDED.telegram_username,
             active = EXCLUDED.active,
             updated_at = now()
           RETURNING id`,
          [
            client.id,
            user.rowId,
            user.odooLogin,
            odooUid,
            telegramId,
            telegramId,
            user.telegramUsername || null,
            user.active,
          ],
        );

        const linkedUserId = linkedRes.rows[0]?.id;

        if (linkedUserId && apiKey && masterKey) {
          const enc = encryptSecret(apiKey, masterKey);
          await db.query(
            `INSERT INTO agent.odoo_credentials
               (linked_user_id, algorithm, ciphertext, nonce, auth_tag, key_version, api_key_fingerprint, api_key_last_four)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (linked_user_id) DO UPDATE SET
               ciphertext = EXCLUDED.ciphertext,
               nonce = EXCLUDED.nonce,
               auth_tag = EXCLUDED.auth_tag,
               api_key_fingerprint = EXCLUDED.api_key_fingerprint,
               api_key_last_four = EXCLUDED.api_key_last_four,
               updated_at = now()`,
            [
              linkedUserId,
              enc.algorithm,
              enc.ciphertext,
              enc.nonce,
              enc.authTag,
              enc.keyVersion,
              enc.fingerprint,
              enc.lastFour,
            ],
          );
        }
      } catch (dbErr) {
        results.errors.push({
          rowId: user.rowId,
          error: `Error guardando en BD: ${dbErr.message}`,
        });
      }
    }

    results.users.push({
      rowId: user.rowId,
      login: user.odooLogin,
      telegramId,
      active: user.active,
      verified,
      odooUid,
      hasApiKey: Boolean(apiKey),
    });
  }

  return results;
}
