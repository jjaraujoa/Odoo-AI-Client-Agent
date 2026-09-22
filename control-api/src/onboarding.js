import { createHash, randomBytes } from "node:crypto";
import { inTransaction } from "./db.js";
import {
  constantTimeKeyMatches,
  decryptNamedSecret,
  decryptSecret,
  encryptNamedSecret,
  encryptSecret,
} from "./crypto.js";
import { AppError } from "./errors.js";
import { fetchJson } from "./http.js";
import { OdooJson2Client } from "./odoo.js";
import { DEFAULT_TOOLS } from "./admin.js";
import { SEMANTIC_CATALOG_VERSION, SEMANTIC_ENTITY_KEYS } from "./semantic-catalog.js";

const LIMIT_KEYS = new Set([
  "requests_per_minute", "requests_per_day", "concurrent_requests",
  "request_timeout_seconds", "max_odoo_records", "max_display_records",
  "max_input_chars", "max_output_chars", "max_document_bytes",
  "max_document_pages", "max_context_messages", "inactivity_minutes",
  "absolute_session_hours",
]);
const TOOL_NAMES = new Set(DEFAULT_TOOLS.map(([name]) => name));
const TELEGRAM_WEBHOOK_PATH = "/webhook/odoo-ai-telegram";

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

function lastFour(value) {
  return value ? String(value).slice(-4) : null;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|si|sí|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function safeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validatePayloadShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError(400, "invalid_package_payload", "El contenido del paquete no es un objeto.");
  }
  const client = payload.client;
  if (!client || typeof client !== "object") {
    throw new AppError(400, "invalid_package_payload", "Falta la sección client.");
  }
  const slug = cleanText(client.slug)?.toLowerCase();
  if (!slug || !/^[a-z0-9][a-z0-9_-]{1,62}$/.test(slug)) {
    throw new AppError(400, "invalid_client_slug", "El slug del cliente no es válido.");
  }
  const users = Array.isArray(payload.users) ? payload.users : [];
  const rowIds = new Set();
  for (const user of users) {
    const rowId = cleanText(user.row_id);
    if (!rowId || !/^[A-Za-z0-9_-]{1,64}$/.test(rowId)) {
      throw new AppError(400, "invalid_row_id", "Todos los usuarios requieren un row_id estable.");
    }
    if (rowIds.has(rowId)) {
      throw new AppError(400, "duplicate_row_id", `row_id duplicado: ${rowId}.`);
    }
    rowIds.add(rowId);
  }
  return { ...payload, client: { ...client, slug }, users };
}

async function validateTelegram(telegram) {
  const token = cleanText(telegram?.bot_token);
  const expectedUsername = cleanText(telegram?.bot_username)?.replace(/^@/, "");
  if (!token) {
    return {
      status: "missing", valid: false, token: null, expectedUsername,
      message: "No se suministró token de Telegram.",
    };
  }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return {
      status: "invalid", valid: false, token: null, expectedUsername,
      message: "El token de Telegram no tiene el formato esperado.",
    };
  }
  try {
    const result = await fetchJson(
      `https://api.telegram.org/bot${token}/getMe`,
      { method: "GET" },
      15_000,
    );
    if (!result?.ok || !result?.result?.id || !result?.result?.username) {
      throw new Error("Telegram no devolvió la identidad del bot");
    }
    const actualUsername = String(result.result.username);
    if (expectedUsername
        && actualUsername.toLowerCase() !== expectedUsername.toLowerCase()) {
      return {
        status: "invalid", valid: false, token: null, expectedUsername,
        actualUsername,
        message: `El token pertenece a @${actualUsername}, no a @${expectedUsername}.`,
      };
    }
    return {
      status: "valid",
      valid: true,
      token,
      botId: Number(result.result.id),
      botUsername: actualUsername,
      botDisplayName: cleanText(result.result.first_name),
      fingerprint: fingerprint(token),
      lastFour: lastFour(token),
      message: "Token verificado con Telegram.",
    };
  } catch (error) {
    return {
      status: error?.code === "upstream_timeout" ? "unreachable" : "invalid",
      valid: false,
      token: null,
      expectedUsername,
      message: error?.code === "upstream_timeout"
        ? "Telegram no respondió dentro del tiempo permitido."
        : "Telegram rechazó el token o no fue posible validar el bot.",
    };
  }
}

async function readExistingUserState(db, config, clientSlug, rowId) {
  const draft = await db.query(
    `SELECT credential_ciphertext AS ciphertext, credential_nonce AS nonce,
            credential_auth_tag AS auth_tag, credential_key_version AS key_version,
            credential_status, last_reviewed_at
       FROM agent.onboarding_user_drafts
      WHERE client_slug = $1 AND row_id = $2`,
    [clientSlug, rowId],
  );
  if (draft.rows[0]) {
    const row = draft.rows[0];
    return {
      apiKey: row.credential_status === "valid" && row.ciphertext
        ? decryptSecret(row, config.credentialMasterKey)
        : null,
      lastReviewedAt: row.last_reviewed_at,
      source: "draft",
    };
  }
  const active = await db.query(
    `SELECT c.ciphertext, c.nonce, c.auth_tag, c.key_version, u.updated_at AS last_reviewed_at
       FROM agent.linked_users u
       JOIN agent.clients cl ON cl.id = u.client_id
       JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
      WHERE cl.slug = $1 AND u.onboarding_row_id = $2`,
    [clientSlug, rowId],
  );
  if (active.rows[0]) {
    return {
      apiKey: decryptSecret(active.rows[0], config.credentialMasterKey),
      lastReviewedAt: active.rows[0].last_reviewed_at,
      source: "active",
    };
  }
  return { apiKey: null, lastReviewedAt: null, source: "none" };
}

async function validateOdooUser({ client, user, apiKey }) {
  const requestedLogin = cleanText(user.odoo_login);
  if (!apiKey) {
    return {
      status: "missing", valid: false, apiKey: null,
      login: requestedLogin, uid: null,
      message: "No se suministró ni existe una API key válida para esta fila.",
    };
  }
  const baseUrl = cleanText(client.odoo_base_url)?.replace(/\/+$/, "");
  if (!baseUrl) {
    return {
      status: "invalid", valid: false, apiKey: null,
      login: requestedLogin, uid: null,
      message: "Falta la URL de Odoo; no se validó la API key.",
    };
  }
  try {
    const odoo = new OdooJson2Client({
      baseUrl,
      database: cleanText(client.odoo_database),
      apiKey,
      timeoutMs: 15_000,
    });
    const context = await odoo.call("res.users", "context_get", {});
    const uid = Number(context?.uid);
    if (!Number.isSafeInteger(uid)) throw new Error("Odoo no devolvió uid");
    const rows = await odoo.call("res.users", "read", {
      ids: [uid],
      fields: ["login", "name"],
      load: null,
    });
    const actualLogin = cleanText(rows?.[0]?.login);
    if (!actualLogin) throw new Error("Odoo no devolvió login");
    if (requestedLogin && actualLogin.toLowerCase() !== requestedLogin.toLowerCase()) {
      return {
        status: "invalid", valid: false, apiKey: null,
        login: requestedLogin, actualLogin, uid,
        message: `La API key pertenece a ${actualLogin}, no a ${requestedLogin}.`,
      };
    }
    return {
      status: "valid", valid: true, apiKey,
      login: actualLogin, name: cleanText(rows?.[0]?.name), uid,
      fingerprint: fingerprint(apiKey), lastFour: lastFour(apiKey),
      message: "API key verificada mediante Odoo JSON-2.",
    };
  } catch (error) {
    return {
      status: error?.code === "upstream_timeout" ? "unreachable" : "invalid",
      valid: false, apiKey: null, login: requestedLogin, uid: null,
      message: error?.code === "upstream_timeout"
        ? "Odoo no respondió dentro del tiempo permitido; la API key no se almacenará."
        : "Odoo rechazó la API key o la conexión JSON-2; la API key no se almacenará.",
    };
  }
}

function normalizeConfiguration(configuration) {
  const source = configuration && typeof configuration === "object" ? configuration : {};
  const limits = {};
  for (const [key, raw] of Object.entries(source.limits ?? {})) {
    if (!LIMIT_KEYS.has(key)) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) limits[key] = value;
  }
  const tools = [...new Set((source.tools ?? []).map(cleanText).filter((x) => TOOL_NAMES.has(x)))];
  const models = [...new Set((source.models ?? []).map(cleanText).filter(Boolean))];
  return { limits, tools, models };
}

export async function validateOnboardingPayload(db, config, rawPayload) {
  const payload = validatePayloadShape(rawPayload);
  const client = {
    slug: payload.client.slug,
    name: cleanText(payload.client.name),
    odoo_base_url: cleanText(payload.client.odoo_base_url)?.replace(/\/+$/, ""),
    odoo_database: cleanText(payload.client.odoo_database),
    timezone: cleanText(payload.client.timezone) ?? "America/Bogota",
    active: booleanValue(payload.client.active),
  };
  const errors = [];
  const warnings = [];
  if (client.odoo_base_url) {
    try {
      const parsed = new URL(client.odoo_base_url);
      if (!["https:", "http:"].includes(parsed.protocol)) throw new Error();
    } catch {
      errors.push("La URL de Odoo no es válida.");
    }
  }
  if (client.active && (!client.name || !client.odoo_base_url)) {
    errors.push("El cliente activo requiere nombre y URL de Odoo.");
  }

  const telegram = await validateTelegram(payload.telegram);
  const seenTelegram = new Set();
  const users = [];
  for (const source of payload.users) {
    const rowId = cleanText(source.row_id);
    const active = booleanValue(source.active);
    const telegramUserIdText = cleanText(String(source.telegram_user_id ?? ""));
    const telegramUserId = safeInteger(source.telegram_user_id);
    const legacyChatIdText = cleanText(String(source.telegram_chat_id ?? ""));
    const legacyTelegramChatId = safeInteger(source.telegram_chat_id);
    const telegramChatId = telegramUserId;
    const telegramUsername = cleanText(source.telegram_username)?.replace(/^@/, "");
    const suppliedApiKey = cleanText(source.odoo_api_key);
    let apiKey = suppliedApiKey;
    let credentialSource = suppliedApiKey ? "package" : "none";
    let lastReviewedAt = null;
    if (!apiKey) {
      const existing = await readExistingUserState(db, config, client.slug, rowId);
      apiKey = existing.apiKey;
      lastReviewedAt = existing.lastReviewedAt;
      if (apiKey) credentialSource = "stored";
    }
    const staleWarning = !active
      && lastReviewedAt
      && (Date.now() - new Date(lastReviewedAt).getTime()) > 30 * 24 * 60 * 60 * 1000;
    const odoo = await validateOdooUser({ client, user: source, apiKey });
    if (telegramUserId !== null) {
      if (seenTelegram.has(telegramUserId)) {
        errors.push(`Telegram User ID duplicado dentro del paquete: ${telegramUserId}.`);
      }
      seenTelegram.add(telegramUserId);
    }
    const rowErrors = [];
    if (active && !client.active) rowErrors.push("No puede activarse si el cliente está en borrador.");
    if (active && !telegram.valid) rowErrors.push("El bot de Telegram no está validado.");
    if (telegramUserIdText && (telegramUserId === null || telegramUserId <= 0)) {
      rowErrors.push("El Telegram User ID debe ser un número entero positivo.");
    } else if (active && telegramUserId === null) {
      rowErrors.push("Falta Telegram User ID positivo y válido.");
    }
    if (legacyChatIdText
        && (legacyTelegramChatId === null || legacyTelegramChatId !== telegramUserId)) {
      rowErrors.push(
        "El Chat ID legado no coincide con el Telegram User ID; solo se admiten chats privados.",
      );
    }
    if (active && !odoo.valid) rowErrors.push("Falta una API key de Odoo válida.");
    if (active && !odoo.login) rowErrors.push("No se pudo determinar el login de Odoo.");
    if (rowErrors.length) errors.push(`Usuario ${rowId}: ${rowErrors.join(" ")}`);
    users.push({
      rowId,
      active,
      odooLogin: odoo.login ?? cleanText(source.odoo_login),
      odooUserId: odoo.uid,
      odooName: odoo.name ?? null,
      telegramUserId,
      telegramChatId,
      telegramUsername,
      credentialSource,
      credential: odoo,
      usableApiKey: odoo.valid ? odoo.apiKey : null,
      lastReviewedAt,
      staleWarning: Boolean(staleWarning),
      validForActivation: active && rowErrors.length === 0,
    });
  }

  for (const user of users.filter((item) => item.telegramUserId !== null)) {
    const collision = await db.query(
      `SELECT c.slug, u.telegram_user_id, u.onboarding_row_id
         FROM agent.linked_users u
         JOIN agent.clients c ON c.id = u.client_id
        WHERE u.active AND u.telegram_user_id = $1
          AND NOT (c.slug = $2 AND u.onboarding_row_id = $3)
        LIMIT 1`,
      [user.telegramUserId, client.slug, user.rowId],
    );
    if (collision.rows[0]) {
      errors.push(
        `Telegram User ID ${user.telegramUserId} ya está registrado y activo en otra empresa.`,
      );
    }
  }

  if (client.active && !telegram.valid) {
    errors.push("El cliente activo requiere un token de Telegram válido.");
  }
  const configuration = normalizeConfiguration(payload.configuration);
  const knownModels = configuration.models.length
    ? await db.query(
      `SELECT display_name, validation_status, active
         FROM agent.models WHERE display_name = ANY($1::text[])`,
      [configuration.models],
    )
    : { rows: [] };
  const modelMap = new Map(knownModels.rows.map((row) => [row.display_name, row]));
  for (const model of configuration.models) {
    const record = modelMap.get(model);
    if (!record) warnings.push(`Modelo desconocido: ${model}; no se habilitará.`);
    else if (!record.active || record.validation_status !== "valid") {
      warnings.push(`Modelo pendiente de validación: ${model}; no se habilitará.`);
    }
  }
  const activeUsers = users.filter((user) => user.active).length;
  const draftUsers = users.length - activeUsers;
  return {
    valid: errors.length === 0,
    packageId: payload.package_id,
    schemaVersion: payload.schema_version,
    consultant: cleanText(payload.consultant) ?? "consultor-no-indicado",
    client,
    telegram,
    users,
    configuration,
    errors,
    warnings,
    counts: { users: users.length, activeUsers, draftUsers },
  };
}

export function publicOnboardingPreview(validation, packageHash) {
  return {
    package_id: validation.packageId,
    package_sha256: packageHash,
    schema_version: validation.schemaVersion,
    consultant: validation.consultant,
    can_apply: validation.valid,
    client: validation.client,
    telegram: {
      status: validation.telegram.status,
      bot_id: validation.telegram.botId ?? null,
      bot_username: validation.telegram.botUsername
        ?? validation.telegram.expectedUsername ?? null,
      token_last_four: validation.telegram.lastFour ?? null,
      token_fingerprint: validation.telegram.fingerprint ?? null,
      message: validation.telegram.message,
    },
    users: validation.users.map((user) => ({
      row_id: user.rowId,
      active: user.active,
      odoo_login: user.odooLogin,
      odoo_user_id: user.odooUserId,
      telegram_user_id: user.telegramUserId,
      telegram_chat_id: user.telegramChatId,
      telegram_username: user.telegramUsername,
      credential_source: user.credentialSource,
      credential_status: user.credential.status,
      api_key_last_four: user.credential.lastFour ?? null,
      api_key_fingerprint: user.credential.fingerprint ?? null,
      validation_message: user.credential.message,
      last_reviewed_at: user.lastReviewedAt ?? null,
      stale_warning: user.staleWarning,
    })),
    configuration: validation.configuration,
    counts: validation.counts,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

async function ensureClientDefaults(tx, clientId) {
  await tx.query(
    `INSERT INTO agent.agent_limits(client_id) VALUES ($1)
     ON CONFLICT (client_id) WHERE linked_user_id IS NULL DO NOTHING`,
    [clientId],
  );
  for (const [tool, risk, confirm, fields] of DEFAULT_TOOLS) {
    await tx.query(
      `INSERT INTO agent.tool_policies
        (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (client_id, tool_name) DO NOTHING`,
      [clientId, tool, risk, confirm, JSON.stringify(fields)],
    );
  }
  for (const entityKey of SEMANTIC_ENTITY_KEYS) {
    await tx.query(
      `INSERT INTO agent.semantic_entities(client_id, entity_key, catalog_version)
       VALUES ($1,$2,$3)
       ON CONFLICT (client_id, entity_key) DO NOTHING`,
      [clientId, entityKey, SEMANTIC_CATALOG_VERSION],
    );
  }
  await tx.query(
    `INSERT INTO agent.client_models(client_id, model_id, enabled)
     SELECT $1, id, false FROM agent.models
     ON CONFLICT (client_id, model_id) DO NOTHING`,
    [clientId],
  );
}

async function configureImportedClient(tx, clientId, configuration) {
  const limitEntries = Object.entries(configuration.limits);
  if (limitEntries.length) {
    const assignments = limitEntries.map(([key], index) => `${key} = $${index + 2}`).join(", ");
    await tx.query(
      `UPDATE agent.agent_limits SET ${assignments}
        WHERE client_id = $1 AND linked_user_id IS NULL`,
      [clientId, ...limitEntries.map(([, value]) => value)],
    );
  }
  if (configuration.tools.length) {
    await tx.query(
      `UPDATE agent.tool_policies SET enabled = (tool_name = ANY($2::text[]))
        WHERE client_id = $1`,
      [clientId, configuration.tools],
    );
  }
  if (configuration.models.length) {
    await tx.query(
      `UPDATE agent.client_models cm
          SET enabled = (m.display_name = ANY($2::text[])
                         AND m.active AND m.validation_status = 'valid')
         FROM agent.models m
        WHERE cm.client_id = $1 AND cm.model_id = m.id`,
      [clientId, configuration.models],
    );
  }
}

async function storeChannel(tx, config, clientId, telegram, webhookUrl) {
  const token = encryptNamedSecret(telegram.token, config.credentialMasterKey, "telegram-bot-token");
  const webhookSecretPlain = randomBytes(24).toString("base64url");
  const webhook = encryptNamedSecret(
    webhookSecretPlain,
    config.credentialMasterKey,
    "telegram-webhook-secret",
  );
  await tx.query(
    `INSERT INTO agent.channel_credentials
      (client_id, bot_id, bot_username, bot_display_name,
       token_ciphertext, token_nonce, token_auth_tag, token_key_version,
       token_fingerprint, token_last_four,
       webhook_secret_ciphertext, webhook_secret_nonce, webhook_secret_auth_tag,
       webhook_secret_key_version, webhook_secret_fingerprint,
       webhook_url, credential_verified_at, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),true)
     ON CONFLICT (client_id) DO UPDATE SET
       bot_id = EXCLUDED.bot_id, bot_username = EXCLUDED.bot_username,
       bot_display_name = EXCLUDED.bot_display_name,
       token_ciphertext = EXCLUDED.token_ciphertext, token_nonce = EXCLUDED.token_nonce,
       token_auth_tag = EXCLUDED.token_auth_tag, token_key_version = EXCLUDED.token_key_version,
       token_fingerprint = EXCLUDED.token_fingerprint, token_last_four = EXCLUDED.token_last_four,
       webhook_secret_ciphertext = EXCLUDED.webhook_secret_ciphertext,
       webhook_secret_nonce = EXCLUDED.webhook_secret_nonce,
       webhook_secret_auth_tag = EXCLUDED.webhook_secret_auth_tag,
       webhook_secret_key_version = EXCLUDED.webhook_secret_key_version,
       webhook_secret_fingerprint = EXCLUDED.webhook_secret_fingerprint,
       webhook_url = EXCLUDED.webhook_url, webhook_verified_at = NULL,
       credential_verified_at = now(), active = true`,
    [
      clientId, telegram.botId, telegram.botUsername, telegram.botDisplayName,
      token.ciphertext, token.nonce, token.authTag, token.keyVersion,
      token.fingerprint, token.lastFour,
      webhook.ciphertext, webhook.nonce, webhook.authTag, webhook.keyVersion,
      webhook.fingerprint, webhookUrl,
    ],
  );
  return webhookSecretPlain;
}

async function upsertActiveUser(tx, config, clientId, validation, consultant) {
  const userResult = await tx.query(
    `INSERT INTO agent.linked_users
      (client_id, onboarding_row_id, telegram_user_id, telegram_chat_id,
       telegram_username, odoo_login, odoo_user_id, active, linked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)
     ON CONFLICT (client_id, onboarding_row_id) WHERE onboarding_row_id IS NOT NULL
     DO UPDATE SET
       telegram_user_id = EXCLUDED.telegram_user_id,
       telegram_chat_id = EXCLUDED.telegram_chat_id,
       telegram_username = EXCLUDED.telegram_username,
       odoo_login = EXCLUDED.odoo_login,
       odoo_user_id = EXCLUDED.odoo_user_id,
       active = true, revoked_at = NULL, linked_by = EXCLUDED.linked_by
     RETURNING id`,
    [
      clientId, validation.rowId, validation.telegramUserId,
      validation.telegramChatId, validation.telegramUsername,
      validation.odooLogin, validation.odooUserId, consultant,
    ],
  );
  const linkedUserId = userResult.rows[0].id;
  let apiKey = validation.usableApiKey;
  if (!apiKey) throw new AppError(409, "credential_disappeared", "No se encontró la credencial validada.");
  const encrypted = encryptSecret(apiKey, config.credentialMasterKey);
  await tx.query(
    `INSERT INTO agent.odoo_credentials
      (linked_user_id, ciphertext, nonce, auth_tag, key_version,
       api_key_fingerprint, last_four)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (linked_user_id) DO UPDATE SET
       ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
       auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version,
       api_key_fingerprint = EXCLUDED.api_key_fingerprint,
       last_four = EXCLUDED.last_four, rotated_at = now()`,
    [
      linkedUserId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag,
      encrypted.keyVersion, encrypted.fingerprint, encrypted.lastFour,
    ],
  );
  apiKey = null;
  await tx.query(
    "DELETE FROM agent.onboarding_user_drafts WHERE client_slug = $1 AND row_id = $2",
    [validation.clientSlug, validation.rowId],
  );
  return linkedUserId;
}

async function upsertDraftUser(tx, config, clientSlug, user, packageId, consultant) {
  let encrypted = null;
  if (user.usableApiKey && user.credential.valid) {
    encrypted = encryptSecret(user.usableApiKey, config.credentialMasterKey);
  }
  await tx.query(
    `INSERT INTO agent.onboarding_user_drafts
      (client_slug, row_id, package_id, consultant, requested_active,
       odoo_login, odoo_user_id, telegram_user_id, telegram_chat_id, telegram_username,
       credential_algorithm, credential_ciphertext, credential_nonce, credential_auth_tag,
       credential_key_version, api_key_fingerprint, api_key_last_four,
       credential_status, validation_message, verified_at, last_reviewed_at)
     VALUES
      ($1,$2,$3,$4,false,$5,$6,$7,$8,$9,
       $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
     ON CONFLICT (client_slug, row_id) DO UPDATE SET
       package_id = EXCLUDED.package_id, consultant = EXCLUDED.consultant,
       requested_active = false,
       odoo_login = COALESCE(EXCLUDED.odoo_login, agent.onboarding_user_drafts.odoo_login),
       odoo_user_id = COALESCE(EXCLUDED.odoo_user_id, agent.onboarding_user_drafts.odoo_user_id),
       telegram_user_id = COALESCE(EXCLUDED.telegram_user_id, agent.onboarding_user_drafts.telegram_user_id),
       telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, agent.onboarding_user_drafts.telegram_chat_id),
       telegram_username = COALESCE(EXCLUDED.telegram_username, agent.onboarding_user_drafts.telegram_username),
       credential_algorithm = COALESCE(EXCLUDED.credential_algorithm, agent.onboarding_user_drafts.credential_algorithm),
       credential_ciphertext = COALESCE(EXCLUDED.credential_ciphertext, agent.onboarding_user_drafts.credential_ciphertext),
       credential_nonce = COALESCE(EXCLUDED.credential_nonce, agent.onboarding_user_drafts.credential_nonce),
       credential_auth_tag = COALESCE(EXCLUDED.credential_auth_tag, agent.onboarding_user_drafts.credential_auth_tag),
       credential_key_version = COALESCE(EXCLUDED.credential_key_version, agent.onboarding_user_drafts.credential_key_version),
       api_key_fingerprint = COALESCE(EXCLUDED.api_key_fingerprint, agent.onboarding_user_drafts.api_key_fingerprint),
       api_key_last_four = COALESCE(EXCLUDED.api_key_last_four, agent.onboarding_user_drafts.api_key_last_four),
       credential_status = CASE
         WHEN EXCLUDED.credential_status = 'valid' THEN 'valid'
         WHEN agent.onboarding_user_drafts.credential_status = 'valid' THEN 'valid'
         ELSE EXCLUDED.credential_status END,
       validation_message = CASE
         WHEN EXCLUDED.credential_status = 'valid' THEN EXCLUDED.validation_message
         WHEN agent.onboarding_user_drafts.credential_status = 'valid'
           THEN agent.onboarding_user_drafts.validation_message
         ELSE EXCLUDED.validation_message END,
       verified_at = COALESCE(EXCLUDED.verified_at, agent.onboarding_user_drafts.verified_at),
       last_reviewed_at = now()`,
    [
      clientSlug, user.rowId, packageId, consultant,
      user.odooLogin, user.odooUserId, user.telegramUserId,
      user.telegramChatId, user.telegramUsername,
      encrypted?.algorithm ?? null, encrypted?.ciphertext ?? null,
      encrypted?.nonce ?? null, encrypted?.authTag ?? null,
      encrypted?.keyVersion ?? null, encrypted?.fingerprint ?? null,
      encrypted?.lastFour ?? null, user.credential.status,
      user.credential.message, user.credential.valid ? new Date() : null,
    ],
  );
}

async function registerWebhook(db, config, clientId, token, secret, webhookUrl) {
  if (!webhookUrl || /REEMPLAZAR|example\.com/i.test(webhookUrl)) {
    return { registered: false, message: "N8N_WEBHOOK_URL no está configurada; webhook pendiente." };
  }
  try {
    const result = await fetchJson(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secret,
          allowed_updates: ["message", "edited_message", "callback_query"],
          drop_pending_updates: false,
        }),
      },
      15_000,
    );
    if (!result?.ok) throw new Error("Telegram no confirmó el webhook");
    await db.query(
      "UPDATE agent.channel_credentials SET webhook_verified_at = now() WHERE client_id = $1",
      [clientId],
    );
    return { registered: true, message: "Webhook registrado sin copiar el token a n8n." };
  } catch {
    return { registered: false, message: "Token almacenado; Telegram no permitió registrar el webhook." };
  }
}

export async function applyOnboardingPackage(db, config, validation, packageHash) {
  if (!validation.valid) {
    throw new AppError(409, "package_validation_failed", "El paquete tiene errores y no puede aplicarse.", {
      errors: validation.errors,
    });
  }
  const existing = await db.query(
    "SELECT * FROM agent.import_batches WHERE package_id = $1",
    [validation.packageId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].package_sha256 !== packageHash) {
      throw new AppError(409, "package_id_collision", "El package_id ya existe con otra huella.");
    }
    return {
      idempotent: true,
      package_id: validation.packageId,
      client_slug: validation.client.slug,
      applied_at: existing.rows[0].applied_at,
      webhook: { registered: Boolean(existing.rows[0].summary?.webhook_registered) },
    };
  }

  const webhookUrl = config.n8nWebhookUrl
    ? `${config.n8nWebhookUrl.replace(/\/+$/, "")}${TELEGRAM_WEBHOOK_PATH}`
    : null;
  let channelRuntime = null;
  const applied = await inTransaction(db, async (tx) => {
    const batchResult = await tx.query(
      `INSERT INTO agent.import_batches
        (package_id, package_version, package_sha256, consultant, client_slug,
         status, user_count, active_user_count, draft_user_count, summary, applied_at)
       VALUES ($1,$2,$3,$4,$5,'applied',$6,$7,$8,$9,now())
       RETURNING id, applied_at`,
      [
        validation.packageId, validation.schemaVersion, packageHash,
        validation.consultant, validation.client.slug,
        validation.counts.users, validation.counts.activeUsers,
        validation.counts.draftUsers,
        JSON.stringify({ warnings: validation.warnings, webhook_registered: false }),
      ],
    );
    const batch = batchResult.rows[0];
    let clientId = null;
    if (validation.client.active) {
      const clientResult = await tx.query(
        `INSERT INTO agent.clients
          (slug, name, odoo_base_url, odoo_database, timezone, active, settings)
         VALUES ($1,$2,$3,$4,$5,true,$6)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name, odoo_base_url = EXCLUDED.odoo_base_url,
           odoo_database = EXCLUDED.odoo_database, timezone = EXCLUDED.timezone,
           active = true
         RETURNING id`,
        [
          validation.client.slug, validation.client.name,
          validation.client.odoo_base_url, validation.client.odoo_database,
          validation.client.timezone,
          JSON.stringify({ read_planner_mode: "shadow" }),
        ],
      );
      clientId = clientResult.rows[0].id;
      await ensureClientDefaults(tx, clientId);
      await configureImportedClient(tx, clientId, validation.configuration);
      const secret = await storeChannel(tx, config, clientId, validation.telegram, webhookUrl);
      channelRuntime = {
        clientId,
        token: validation.telegram.token,
        secret,
        webhookUrl,
      };
      await tx.query(
        "DELETE FROM agent.onboarding_client_drafts WHERE client_slug = $1",
        [validation.client.slug],
      );
    } else {
      await tx.query(
        `INSERT INTO agent.onboarding_client_drafts
          (client_slug, package_id, consultant, requested_active, name,
           odoo_base_url, odoo_database, timezone, validation_status,
           validation_message, last_reviewed_at)
         VALUES ($1,$2,$3,false,$4,$5,$6,$7,'pending',
                 'Cliente guardado como borrador.',now())
         ON CONFLICT (client_slug) DO UPDATE SET
           package_id = EXCLUDED.package_id, consultant = EXCLUDED.consultant,
           requested_active = false, name = COALESCE(EXCLUDED.name, agent.onboarding_client_drafts.name),
           odoo_base_url = COALESCE(EXCLUDED.odoo_base_url, agent.onboarding_client_drafts.odoo_base_url),
           odoo_database = COALESCE(EXCLUDED.odoo_database, agent.onboarding_client_drafts.odoo_database),
           timezone = EXCLUDED.timezone, validation_status = EXCLUDED.validation_status,
           validation_message = EXCLUDED.validation_message, last_reviewed_at = now()`,
        [
          validation.client.slug, validation.packageId, validation.consultant,
          validation.client.name, validation.client.odoo_base_url,
          validation.client.odoo_database, validation.client.timezone,
        ],
      );
    }
    for (const user of validation.users) {
      user.clientSlug = validation.client.slug;
      if (user.active) {
        await upsertActiveUser(tx, config, clientId, user, validation.consultant);
      } else {
        await upsertDraftUser(
          tx, config, validation.client.slug, user,
          validation.packageId, validation.consultant,
        );
      }
      await tx.query(
        `INSERT INTO agent.import_rows
          (import_batch_id, row_id, entity_type, outcome, changes)
         VALUES ($1,$2,'user',$3,$4)`,
        [
          batch.id, user.rowId, user.active ? "updated" : "draft",
          JSON.stringify({
            active: user.active,
            odoo_login: user.odooLogin,
            telegram_user_id: user.telegramUserId,
            credential_status: user.credential.status,
          }),
        ],
      );
    }
    return {
      idempotent: false,
      batchId: batch.id,
      appliedAt: batch.applied_at,
      clientId,
    };
  });

  let webhook = { registered: false, message: "Cliente en borrador; webhook no registrado." };
  if (channelRuntime) {
    webhook = await registerWebhook(
      db, config, channelRuntime.clientId, channelRuntime.token,
      channelRuntime.secret, channelRuntime.webhookUrl,
    );
    channelRuntime.token = null;
    channelRuntime.secret = null;
    await db.query(
      `UPDATE agent.import_batches
          SET summary = summary || $2::jsonb
        WHERE id = $1`,
      [applied.batchId, JSON.stringify({
        webhook_registered: webhook.registered,
        webhook_message: webhook.message,
      })],
    );
  }
  return {
    idempotent: false,
    package_id: validation.packageId,
    client_slug: validation.client.slug,
    applied_at: applied.appliedAt,
    counts: validation.counts,
    webhook,
  };
}

export async function registerStoredTelegramWebhook(db, config, clientSlugValue) {
  const clientSlug = cleanText(clientSlugValue)?.toLowerCase();
  if (!clientSlug || !/^[a-z0-9][a-z0-9_-]{1,62}$/.test(clientSlug)) {
    throw new AppError(400, "invalid_client_slug", "El slug del cliente no es válido.");
  }
  const baseUrl = cleanText(config.n8nWebhookUrl)?.replace(/\/+$/, "");
  if (!baseUrl || /REEMPLAZAR|example\.com/i.test(baseUrl)) {
    throw new AppError(409, "webhook_url_missing", "N8N_WEBHOOK_URL no está configurada.");
  }

  const result = await db.query(
    `SELECT c.id AS client_id,
            cc.token_ciphertext, cc.token_nonce, cc.token_auth_tag, cc.token_key_version,
            cc.webhook_secret_ciphertext, cc.webhook_secret_nonce,
            cc.webhook_secret_auth_tag, cc.webhook_secret_key_version
       FROM agent.clients c
       JOIN agent.channel_credentials cc ON cc.client_id = c.id
      WHERE c.slug = $1 AND c.active AND cc.active
      LIMIT 1`,
    [clientSlug],
  );
  const channel = result.rows[0];
  if (!channel) {
    throw new AppError(
      404,
      "telegram_channel_not_found",
      "El cliente activo no tiene un canal de Telegram disponible.",
    );
  }

  let token = null;
  let webhookSecret = null;
  const webhookUrl = `${baseUrl}${TELEGRAM_WEBHOOK_PATH}`;
  try {
    token = decryptNamedSecret({
      ciphertext: channel.token_ciphertext,
      nonce: channel.token_nonce,
      auth_tag: channel.token_auth_tag,
      key_version: channel.token_key_version,
    }, config.credentialMasterKey, "telegram-bot-token");
    webhookSecret = decryptNamedSecret({
      ciphertext: channel.webhook_secret_ciphertext,
      nonce: channel.webhook_secret_nonce,
      auth_tag: channel.webhook_secret_auth_tag,
      key_version: channel.webhook_secret_key_version,
    }, config.credentialMasterKey, "telegram-webhook-secret");
    await db.query(
      "UPDATE agent.channel_credentials SET webhook_url = $2 WHERE client_id = $1",
      [channel.client_id, webhookUrl],
    );
    const webhook = await registerWebhook(
      db,
      config,
      channel.client_id,
      token,
      webhookSecret,
      webhookUrl,
    );
    return { client_slug: clientSlug, webhook_url: webhookUrl, ...webhook };
  } finally {
    token = null;
    webhookSecret = null;
  }
}

export async function resolveTelegramChannel(db, config, webhookSecret) {
  const secretFingerprint = fingerprint(webhookSecret ?? "");
  const result = await db.query(
    `SELECT cc.*, c.slug AS client_slug
       FROM agent.channel_credentials cc
       JOIN agent.clients c ON c.id = cc.client_id AND c.active
      WHERE cc.webhook_secret_fingerprint = $1 AND cc.active`,
    [secretFingerprint],
  );
  const channel = result.rows[0];
  if (!channel) throw new AppError(401, "invalid_telegram_webhook", "Webhook de Telegram no autorizado.");
  const storedSecret = decryptNamedSecret({
    ciphertext: channel.webhook_secret_ciphertext,
    nonce: channel.webhook_secret_nonce,
    auth_tag: channel.webhook_secret_auth_tag,
    key_version: channel.webhook_secret_key_version,
  }, config.credentialMasterKey, "telegram-webhook-secret");
  if (!constantTimeKeyMatches(storedSecret, webhookSecret)) {
    throw new AppError(401, "invalid_telegram_webhook", "Webhook de Telegram no autorizado.");
  }
  channel.botToken = decryptNamedSecret({
    ciphertext: channel.token_ciphertext,
    nonce: channel.token_nonce,
    auth_tag: channel.token_auth_tag,
    key_version: channel.token_key_version,
  }, config.credentialMasterKey, "telegram-bot-token");
  return channel;
}
