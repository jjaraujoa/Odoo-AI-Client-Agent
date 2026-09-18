import { inTransaction } from "./db.js";
import { encryptSecret } from "./crypto.js";
import { AppError } from "./errors.js";
import { OdooJson2Client } from "./odoo.js";
import { SEMANTIC_CATALOG_VERSION, SEMANTIC_ENTITY_KEYS } from "./semantic-catalog.js";

export const DEFAULT_TOOLS = [
  ["consultar_orden_venta", 1, false, ["name", "partner_id", "date_order", "state", "amount_total", "currency_id", "user_id", "company_id", "invoice_status", "invoice_ids"]],
  ["consultar_orden_compra", 1, false, ["name", "partner_id", "date_order", "state", "amount_total", "currency_id", "user_id", "company_id", "invoice_status", "invoice_ids"]],
  ["consultar_precio_producto", 1, false, ["name", "display_name", "default_code", "lst_price", "currency_id", "uom_id"]],
  ["consultar_inventario", 1, false, ["name", "display_name", "default_code", "qty_available", "free_qty", "virtual_available", "uom_id"]],
  ["consultar_facturas_pendientes", 1, false, ["name", "move_type", "state", "partner_id", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "currency_id", "payment_state", "company_id"]],
  ["consultar_clientes", 1, false, ["name", "vat", "email", "phone", "mobile", "city", "country_id", "company_type", "customer_rank", "active"]],
  ["crear_factura_proveedor_borrador", 2, true, ["move_type", "partner_id", "ref", "invoice_date", "invoice_date_due", "currency_id", "invoice_line_ids"]],
  ["crear_borrador_orden_venta", 1, false, ["partner_id", "order_line", "user_id", "company_id", "note", "payment_term_id"]],
  ["crear_borrador_factura_cliente", 1, false, ["partner_id", "invoice_date", "invoice_line_ids", "currency_id", "ref"]],
  ["asignar_responsable", 1, false, ["user_id"]],
  ["cambiar_etapa_registro", 2, false, ["stage_id", "state"]],
  ["confirmar_orden_venta", 3, true, ["id"]],
  ["validar_albaran_entrega", 3, true, ["id"]],
];

function requireString(body, key) {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(400, "invalid_input", `Falta ${key}.`);
  }
  return value.trim();
}

export async function createClient(db, body) {
  const slug = requireString(body, "slug").toLowerCase();
  const name = requireString(body, "name");
  const odooBaseUrl = requireString(body, "odoo_base_url").replace(/\/+$/, "");
  const database = typeof body.odoo_database === "string" && body.odoo_database.trim()
    ? body.odoo_database.trim()
    : null;
  try {
    new URL(odooBaseUrl);
  } catch {
    throw new AppError(400, "invalid_url", "odoo_base_url no es una URL válida.");
  }
  return inTransaction(db, async (client) => {
    const result = await client.query(
      `INSERT INTO agent.clients(slug, name, odoo_base_url, odoo_database, settings)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, odoo_base_url = EXCLUDED.odoo_base_url,
         odoo_database = EXCLUDED.odoo_database
       RETURNING *`,
      [slug, name, odooBaseUrl, database, JSON.stringify({ read_planner_mode: "shadow" })],
    );
    const created = result.rows[0];
    await client.query(
      `INSERT INTO agent.agent_limits(client_id) VALUES ($1)
       ON CONFLICT (client_id) WHERE linked_user_id IS NULL DO NOTHING`,
      [created.id],
    );
    for (const [tool, risk, confirm, fields] of DEFAULT_TOOLS) {
      await client.query(
        `INSERT INTO agent.tool_policies
          (client_id, tool_name, risk_level, confirmation_required, allowed_fields)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (client_id, tool_name) DO NOTHING`,
        [created.id, tool, risk, confirm, JSON.stringify(fields)],
      );
    }
    for (const entityKey of SEMANTIC_ENTITY_KEYS) {
      await client.query(
        `INSERT INTO agent.semantic_entities(client_id, entity_key, catalog_version)
         VALUES ($1,$2,$3)
         ON CONFLICT (client_id, entity_key) DO NOTHING`,
        [created.id, entityKey, SEMANTIC_CATALOG_VERSION],
      );
    }
    await client.query(
      `INSERT INTO agent.client_models(client_id, model_id, enabled)
       SELECT $1, id, false FROM agent.models
       ON CONFLICT (client_id, model_id) DO NOTHING`,
      [created.id],
    );
    return created;
  });
}

export async function registerLinkedUser(db, config, body) {
  const clientSlug = requireString(body, "client_slug");
  const odooLogin = requireString(body, "odoo_login");
  const apiKey = requireString(body, "odoo_api_key");
  const telegramUserId = Number(body.telegram_user_id);
  const telegramChatId = body.telegram_chat_id === null || body.telegram_chat_id === undefined
    ? null
    : Number(body.telegram_chat_id);
  if (!Number.isSafeInteger(telegramUserId)) {
    throw new AppError(400, "invalid_telegram_id", "telegram_user_id debe ser un entero.");
  }
  const clientResult = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [clientSlug]);
  const client = clientResult.rows[0];
  if (!client) throw new AppError(404, "client_not_found", "Cliente no encontrado.");

  const odoo = new OdooJson2Client({
    baseUrl: client.odoo_base_url,
    database: client.odoo_database,
    apiKey,
    timeoutMs: 15_000,
  });
  let odooUserId;
  try {
    const context = await odoo.call("res.users", "context_get", {});
    odooUserId = Number(context?.uid);
    if (!Number.isSafeInteger(odooUserId)) {
      throw new Error("Odoo no devolvió uid en context_get");
    }
    const ownUser = await odoo.call("res.users", "read", {
      ids: [odooUserId],
      fields: ["login", "name"],
      load: null,
    });
    const actualLogin = ownUser?.[0]?.login;
    if (actualLogin && actualLogin.toLowerCase() !== odooLogin.toLowerCase()) {
      throw new AppError(
        400,
        "odoo_login_mismatch",
        `La API key pertenece a ${actualLogin}, no a ${odooLogin}.`,
      );
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "odoo_login_mismatch") throw error;
    throw new AppError(400, "invalid_odoo_credentials", "Odoo rechazó la API key o la conexión JSON-2.", {
      reason: error.message,
    });
  }
  const encrypted = encryptSecret(apiKey, config.credentialMasterKey);
  return inTransaction(db, async (tx) => {
    const userResult = await tx.query(
      `INSERT INTO agent.linked_users
        (client_id, telegram_user_id, telegram_chat_id, telegram_username,
         odoo_login, odoo_user_id, active, linked_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7)
       ON CONFLICT (client_id, telegram_user_id) DO UPDATE SET
         telegram_chat_id = EXCLUDED.telegram_chat_id,
         telegram_username = EXCLUDED.telegram_username,
         odoo_login = EXCLUDED.odoo_login,
         odoo_user_id = EXCLUDED.odoo_user_id,
         active = true, revoked_at = NULL, linked_by = EXCLUDED.linked_by
       RETURNING *`,
      [
        client.id, telegramUserId, telegramChatId,
        body.telegram_username || null, odooLogin, odooUserId, body.linked_by || "consultor",
      ],
    );
    const user = userResult.rows[0];
    await tx.query(
      `INSERT INTO agent.odoo_credentials
        (linked_user_id, ciphertext, nonce, auth_tag, key_version, api_key_fingerprint, last_four)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (linked_user_id) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
         auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version,
         api_key_fingerprint = EXCLUDED.api_key_fingerprint,
         last_four = EXCLUDED.last_four, rotated_at = now()`,
      [
        user.id, encrypted.ciphertext, encrypted.nonce, encrypted.authTag,
        encrypted.keyVersion, encrypted.fingerprint, encrypted.lastFour,
      ],
    );
    return {
      id: user.id,
      client_slug: clientSlug,
      telegram_user_id: user.telegram_user_id,
      odoo_login: user.odoo_login,
      api_key_last_four: encrypted.lastFour,
      credential_verified: true,
    };
  });
}

export async function validateModels(db, providers, body) {
  const params = [];
  let where = "";
  if (body.display_name) {
    params.push(String(body.display_name));
    where = "WHERE display_name = $1";
  }
  const result = await db.query(
    `SELECT * FROM agent.models ${where} ORDER BY provider, display_name`,
    params,
  );
  if (!result.rows.length) throw new AppError(404, "model_not_found", "No se encontró el modelo.");
  const outcomes = [];
  for (const model of result.rows) {
    const validation = await providers.validateModel(model.provider, model.api_model_id);
    const status = validation.valid ? "valid" : "invalid";
    await db.query(
      `UPDATE agent.models
          SET validation_status = $2, validation_message = $3,
              validated_at = now(), active = CASE WHEN $4 THEN $5 ELSE active END
        WHERE id = $1`,
      [model.id, status, validation.message, Boolean(body.activate), validation.valid],
    );
    outcomes.push({
      display_name: model.display_name,
      provider: model.provider,
      api_model_id: model.api_model_id,
      ...validation,
      activated: Boolean(body.activate && validation.valid),
    });
  }
  return outcomes;
}

export async function configureClientModel(db, body) {
  const clientSlug = requireString(body, "client_slug");
  const displayName = requireString(body, "display_name");
  const enabled = body.enabled !== false;
  const result = await db.query(
    `UPDATE agent.client_models cm
        SET enabled = $3, auto_priority = COALESCE($4, auto_priority)
       FROM agent.clients c, agent.models m
      WHERE cm.client_id = c.id AND cm.model_id = m.id
        AND c.slug = $1 AND m.display_name = $2
        AND (NOT $3 OR (m.active AND m.validation_status = 'valid'))
      RETURNING c.slug, m.display_name, m.provider, m.api_model_id,
                cm.enabled, cm.auto_priority`,
    [clientSlug, displayName, enabled, body.auto_priority ?? null],
  );
  if (!result.rows[0]) {
    throw new AppError(400, "model_not_validated", "El modelo no existe o no está validado y activo.");
  }
  return result.rows[0];
}

export async function revokeLinkedUser(db, body) {
  const result = await db.query(
    `UPDATE agent.linked_users u
        SET active = false, revoked_at = now()
       FROM agent.clients c
      WHERE u.client_id = c.id AND c.slug = $1 AND u.telegram_user_id = $2
      RETURNING u.id`,
    [requireString(body, "client_slug"), Number(body.telegram_user_id)],
  );
  if (!result.rows[0]) throw new AppError(404, "user_not_found", "Usuario vinculado no encontrado.");
  return { revoked: true, id: result.rows[0].id };
}

export async function configureLimits(db, body) {
  const clientSlug = requireString(body, "client_slug");
  const limits = body.limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new AppError(400, "invalid_limits", "limits debe ser un objeto.");
  }
  const allowed = [
    "requests_per_minute", "requests_per_day", "concurrent_requests",
    "request_timeout_seconds", "max_odoo_records", "max_display_records",
    "max_input_chars", "max_output_chars", "max_document_bytes",
    "max_document_pages", "max_context_messages", "inactivity_minutes",
    "absolute_session_hours",
  ];
  const entries = Object.entries(limits).filter(([key]) => allowed.includes(key));
  if (!entries.length || entries.length !== Object.keys(limits).length) {
    throw new AppError(400, "invalid_limits", "Uno o más límites no están permitidos.");
  }
  for (const [key, value] of entries) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AppError(400, "invalid_limits", `${key} debe ser un entero positivo.`);
    }
  }
  const assignments = entries.map(([key], index) => `${key} = $${index + 2}`).join(", ");
  const params = [clientSlug, ...entries.map(([, value]) => value)];
  const result = await db.query(
    `UPDATE agent.agent_limits l
        SET ${assignments}
       FROM agent.clients c
      WHERE l.client_id = c.id AND c.slug = $1 AND l.linked_user_id IS NULL
      RETURNING l.*`,
    params,
  );
  if (!result.rows[0]) throw new AppError(404, "client_not_found", "Cliente no encontrado.");
  return result.rows[0];
}

export async function configureReadPlanner(db, body) {
  const clientSlug = requireString(body, "client_slug");
  const mode = requireString(body, "mode").toLowerCase();
  if (!["legacy", "shadow", "active"].includes(mode)) {
    throw new AppError(400, "invalid_read_planner_mode", "mode debe ser legacy, shadow o active.");
  }
  const requestedEntities = body.entities === undefined
    ? null
    : [...new Set((Array.isArray(body.entities) ? body.entities : []).map((value) => String(value).trim()).filter(Boolean))];
  if (requestedEntities && requestedEntities.some((key) => !SEMANTIC_ENTITY_KEYS.includes(key))) {
    throw new AppError(400, "invalid_semantic_entity", "Una o más entidades semánticas no están permitidas.");
  }
  return inTransaction(db, async (tx) => {
    const client = await tx.query(
      `UPDATE agent.clients
          SET settings = jsonb_set(settings, '{read_planner_mode}', to_jsonb($2::text), true)
        WHERE slug = $1
        RETURNING id, slug, settings->>'read_planner_mode' AS mode`,
      [clientSlug, mode],
    );
    if (!client.rows[0]) throw new AppError(404, "client_not_found", "Cliente no encontrado.");
    if (requestedEntities) {
      await tx.query(
        `UPDATE agent.semantic_entities
            SET enabled = (entity_key = ANY($2::text[]))
          WHERE client_id = $1`,
        [client.rows[0].id, requestedEntities],
      );
    }
    const entities = await tx.query(
      `SELECT entity_key FROM agent.semantic_entities
        WHERE client_id = $1 AND enabled ORDER BY entity_key`,
      [client.rows[0].id],
    );
    return { client_slug: client.rows[0].slug, mode: client.rows[0].mode, entities: entities.rows.map((row) => row.entity_key) };
  });
}
