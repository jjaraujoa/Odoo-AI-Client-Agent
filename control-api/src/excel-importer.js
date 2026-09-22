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

function parseNumberOrString(val) {
  if (typeof val === "number") return val;
  const s = cleanString(val);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

/**
 * Lee la plantilla Excel y extrae las secciones Cliente, Telegram, Configuración y Usuarios
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
    for (const row of rawClient) {
      if (Array.isArray(row) && row.length >= 2 && typeof row[0] === "string") {
        const key = cleanString(row[0]);
        if (["slug", "name", "odoo_base_url", "odoo_database", "timezone", "active"].includes(key)) {
          clientData[key] = cleanString(row[1]);
        }
      }
    }
  }

  // 2. Extraer datos de la hoja Telegram si existe
  const telegramData = {};
  if (workbook.Sheets["Telegram"]) {
    const rawTelegram = XLSX.utils.sheet_to_json(workbook.Sheets["Telegram"], { header: 1 });
    for (const row of rawTelegram) {
      if (Array.isArray(row) && row.length >= 2 && typeof row[0] === "string") {
        const key = cleanString(row[0]).toLowerCase();
        if (["bot_name", "bot_username"].includes(key)) {
          let val = cleanString(row[1]);
          if (key === "bot_username") {
            val = val.replace(/^@/, "");
          }
          telegramData[key] = val;
        }
      }
    }
  }

  // 3. Extraer datos de la hoja Configuración si existe
  const configurationData = {};
  if (workbook.Sheets["Configuración"] || workbook.Sheets["Configuracion"]) {
    const sheetName = workbook.Sheets["Configuración"] ? "Configuración" : "Configuracion";
    const rawConfig = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
    let configHeaderIndex = -1;

    for (let i = 0; i < rawConfig.length; i++) {
      const row = rawConfig[i];
      if (Array.isArray(row) && row.some((c) => cleanString(c).toLowerCase() === "clave")) {
        configHeaderIndex = i;
        break;
      }
    }

    if (configHeaderIndex !== -1) {
      const headers = rawConfig[configHeaderIndex].map((h) => cleanString(h).toLowerCase());
      const keyCol = headers.indexOf("clave");
      const valCol = headers.indexOf("valor");
      const habCol = headers.indexOf("habilitado");

      for (let i = configHeaderIndex + 1; i < rawConfig.length; i++) {
        const row = rawConfig[i];
        if (!Array.isArray(row) || keyCol === -1 || !row[keyCol]) continue;

        const isEnabled = habCol !== -1 ? parseBool(row[habCol]) : true;
        if (isEnabled && valCol !== -1 && row[valCol] !== undefined) {
          const key = cleanString(row[keyCol]);
          configurationData[key] = parseNumberOrString(row[valCol]);
        }
      }
    }
  }

  // 4. Extraer usuarios de la hoja Usuarios
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
    telegram: telegramData,
    configuration: configurationData,
    users,
  };
}

/**
 * Valida la arquitectura, tipos de datos e integridad del libro de trabajo
 */
export function validateClientWorkbook(filePath) {
  const errors = [];
  const warnings = [];

  let parsed;
  try {
    parsed = readClientWorkbook(filePath);
  } catch (err) {
    return {
      valid: false,
      errors: [err.message],
      warnings: [],
      summary: {},
    };
  }

  const { client, telegram, configuration, users } = parsed;

  // 1. Validar Hoja Cliente
  if (!client.slug) {
    errors.push("Hoja 'Cliente': falta el parámetro obligatorio 'slug'.");
  } else if (!/^[a-z0-9_-]+$/.test(client.slug)) {
    errors.push(`Hoja 'Cliente': el slug '${client.slug}' contiene caracteres inválidos. Solo se permiten letras minúsculas, números, guiones y guiones bajos (sin espacios ni tildes).`);
  }

  if (client.odoo_base_url) {
    try {
      const parsedUrl = new URL(client.odoo_base_url);
      if (!["https:", "http:"].includes(parsedUrl.protocol)) {
        errors.push(`Hoja 'Cliente': odoo_base_url '${client.odoo_base_url}' debe ser HTTPS.`);
      }
      if (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "") {
        warnings.push(`Hoja 'Cliente': odoo_base_url tiene una ruta ('${parsedUrl.pathname}'). Se recomienda usar solo el dominio base sin '/odoo'.`);
      }
    } catch {
      errors.push(`Hoja 'Cliente': odoo_base_url '${client.odoo_base_url}' no es una URL válida.`);
    }
  }

  // 2. Validar Hoja Telegram
  if (telegram.bot_username && !telegram.bot_username.toLowerCase().endsWith("bot")) {
    warnings.push(`Hoja 'Telegram': el bot_username '${telegram.bot_username}' usualmente debe terminar en 'bot' según los estándares de Telegram.`);
  }

  // 3. Validar Hoja Usuarios
  if (users.length === 0) {
    warnings.push("Hoja 'Usuarios': no se encontró ningún usuario configurado con row_id.");
  }

  const seenRowIds = new Set();
  const seenTelegramIds = new Set();
  const seenLogins = new Set();

  for (const user of users) {
    // Unicidad de rowId
    if (seenRowIds.has(user.rowId)) {
      errors.push(`Hoja 'Usuarios': row_id duplicado '${user.rowId}'. Cada usuario debe tener un código único.`);
    }
    seenRowIds.add(user.rowId);

    // Si está activo, validaciones estrictas
    if (user.active) {
      if (!user.odooLogin) {
        errors.push(`Usuario '${user.rowId}': está marcado como activo pero no tiene 'odoo_login'.`);
      } else {
        if (seenLogins.has(user.odooLogin)) {
          warnings.push(`Usuario '${user.rowId}': el odoo_login '${user.odooLogin}' aparece repetido.`);
        }
        seenLogins.add(user.odooLogin);
      }

      if (!user.telegramUserId) {
        errors.push(`Usuario '${user.rowId}' (${user.odooLogin}): está activo pero no tiene 'telegram_user_id'.`);
      } else if (!/^\d+$/.test(user.telegramUserId)) {
        errors.push(`Usuario '${user.rowId}' (${user.odooLogin}): telegram_user_id '${user.telegramUserId}' es inválido. Debe ser un número entero.`);
      } else {
        if (seenTelegramIds.has(user.telegramUserId)) {
          errors.push(`Usuario '${user.rowId}': telegram_user_id '${user.telegramUserId}' ya fue asignado a otro usuario.`);
        }
        seenTelegramIds.add(user.telegramUserId);
      }

      if (!user.requestApiKey && !user.odooApiKey) {
        warnings.push(`Usuario '${user.rowId}': está activo pero no tiene suministrar_api_key=TRUE ni API key previa.`);
      }
    }
  }

  const summary = {
    clientSlug: client.slug || "(no definido)",
    clientName: client.name || "(no definido)",
    odooBaseUrl: client.odoo_base_url || "(no definido)",
    odooDatabase: client.odoo_database || "(no definido)",
    botUsername: telegram.bot_username || "(no definido)",
    configParamsCount: Object.keys(configuration).length,
    totalUsers: users.length,
    activeUsers: users.filter((u) => u.active).length,
    draftUsers: users.filter((u) => !u.active).length,
    requestApiKeyUsers: users.filter((u) => u.requestApiKey).length,
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary,
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
    metadata: {
      client: parsed.client,
      telegram: parsed.telegram,
      configuration: parsed.configuration,
    },
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
        if (telegramId) {
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
        } else {
          // Usuario borrador sin telegramId asignado aún: persistir en onboarding_user_drafts
          await db.query(
            `INSERT INTO agent.onboarding_user_drafts
               (client_slug, row_id, package_id, consultant, requested_active,
                odoo_login, odoo_user_id, telegram_user_id, telegram_chat_id, telegram_username,
                credential_status, validation_message, last_reviewed_at)
             VALUES ($1, $2, gen_random_uuid(), 'consultant-cli', $3, $4, $5, NULL, NULL, $6, $7, $8, now())
             ON CONFLICT (client_slug, row_id) DO UPDATE SET
               requested_active = EXCLUDED.requested_active,
               odoo_login = EXCLUDED.odoo_login,
               odoo_user_id = EXCLUDED.odoo_user_id,
               telegram_username = EXCLUDED.telegram_username,
               credential_status = EXCLUDED.credential_status,
               validation_message = EXCLUDED.validation_message,
               last_reviewed_at = now(),
               updated_at = now()`,
            [
              client.slug || "default",
              user.rowId,
              user.active,
              user.odooLogin,
              odooUid,
              user.telegramUsername || null,
              verified ? "valid" : (apiKey ? "invalid" : "missing"),
              verified ? "Credencial verificada en Odoo" : "Borrador sin ID de Telegram asignado",
            ],
          ).catch(() => {});
        }
      } catch (err) {
        results.errors.push({
          rowId: user.rowId,
          error: `Error al persistir usuario en base de datos: ${err.message}`,
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
