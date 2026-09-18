import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { constantTimeKeyMatches, decryptSecret } from "./crypto.js";
import { AppError, safeError } from "./errors.js";
import { json, readJson } from "./http.js";
import { ModelProviders } from "./providers.js";
import { TelegramProcessor } from "./telegram.js";
import { registerStoredTelegramWebhook } from "./onboarding.js";
import { OdooJson2Client } from "./odoo.js";
import {
  configureClientModel,
  configureLimits,
  configureReadPlanner,
  createClient,
  registerLinkedUser,
  revokeLinkedUser,
  validateModels,
} from "./admin.js";
import { processOdooEvent } from "./events.js";
import { generateOperationalDigest } from "./digest.js";
import { requestOrExecuteAction, confirmOperationalAction } from "./governance.js";
import { answerSopQuery } from "./sops.js";
import { runFullBusinessAudit } from "./audit-business.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);
const providers = new ModelProviders(config);
const telegram = new TelegramProcessor({ db, config, providers });

function bearer(request) {
  return request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
}

function requireInternal(request) {
  const provided = request.headers["x-internal-key"] || bearer(request);
  if (!constantTimeKeyMatches(String(provided), config.internalKey)) {
    throw new AppError(401, "unauthorized", "Credencial interna inválida.");
  }
}

function requireAdmin(request) {
  const provided = request.headers["x-admin-key"] || bearer(request);
  if (!constantTimeKeyMatches(String(provided), config.adminKey)) {
    throw new AppError(401, "unauthorized", "Credencial administrativa inválida.");
  }
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  try {
    const url = new URL(request.url, "http://control-api.local");
    if (request.method === "GET" && url.pathname === "/health") {
      const result = await db.query(
        "SELECT count(*)::int AS migrations FROM agent.schema_migrations",
      );
      return json(response, 200, {
        status: "ok",
        migrations: result.rows[0].migrations,
        model_credentials: {
          openai: providers.hasCredentials("openai"),
          anthropic: providers.hasCredentials("anthropic"),
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/telegram/process") {
      requireInternal(request);
      const body = await readJson(request, 2_000_000);
      return json(response, 200, await telegram.process(body));
    }

    if (request.method === "POST" && url.pathname === "/v1/events/odoo") {
      requireInternal(request);
      const body = await readJson(request, 2_000_000);
      return json(response, 200, await processOdooEvent({ db, config, body }));
    }

    if (request.method === "POST" && url.pathname === "/v1/digest/generate") {
      requireInternal(request);
      const body = await readJson(request, 500_000);
      return json(response, 200, await generateOperationalDigest({
        db,
        config,
        clientSlug: body.client_slug,
        role: body.role || "general",
      }));
    }

    if (request.method === "POST" && url.pathname === "/v1/maintenance/cleanup") {
      requireInternal(request);
      const result = await db.query("SELECT * FROM agent.cleanup_expired_data()");
      await db.query("DELETE FROM agent.active_requests WHERE lease_expires_at <= now()");
      return json(response, 200, { cleaned: result.rows[0] });
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/clients") {
      requireAdmin(request);
      return json(response, 201, await createClient(db, await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/users") {
      requireAdmin(request);
      return json(response, 201, await registerLinkedUser(db, config, await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/users/revoke") {
      requireAdmin(request);
      return json(response, 200, await revokeLinkedUser(db, await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/models/validate") {
      requireAdmin(request);
      return json(response, 200, {
        models: await validateModels(db, providers, await readJson(request)),
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/client-models") {
      requireAdmin(request);
      return json(response, 200, await configureClientModel(db, await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/limits") {
      requireAdmin(request);
      return json(response, 200, await configureLimits(db, await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/read-planner") {
      requireAdmin(request);
      return json(response, 200, await configureReadPlanner(db, await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/telegram/webhook") {
      requireAdmin(request);
      const body = await readJson(request);
      return json(
        response,
        200,
        await registerStoredTelegramWebhook(db, config, body.client_slug),
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/actions/execute") {
      requireAdmin(request);
      const body = await readJson(request);
      const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [body.client_slug]);
      const client = clientRes.rows[0];
      if (!client) throw new AppError(404, "client_not_found", "Cliente no encontrado.");
      const userRes = await db.query(
        `SELECT u.*, c.ciphertext, c.nonce, c.auth_tag, c.key_version
           FROM agent.linked_users u
           JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
          WHERE u.client_id = $1 AND u.active
          ORDER BY u.created_at ASC LIMIT 1`,
        [client.id],
      );
      if (!userRes.rows[0]) throw new AppError(403, "no_credentials", "No hay credenciales activas.");
      const apiKey = decryptSecret(userRes.rows[0], config.credentialMasterKey);
      const odoo = new OdooJson2Client({ baseUrl: client.odoo_base_url, database: client.odoo_database, apiKey });
      return json(response, 200, await requestOrExecuteAction({
        db, config, client, actionName: body.action_name, params: body.params || {}, odoo,
      }));
    }

    if (request.method === "POST" && url.pathname === "/v1/admin/actions/confirm") {
      requireAdmin(request);
      const body = await readJson(request);
      const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [body.client_slug]);
      const client = clientRes.rows[0];
      if (!client) throw new AppError(404, "client_not_found", "Cliente no encontrado.");
      const userRes = await db.query(
        `SELECT u.*, c.ciphertext, c.nonce, c.auth_tag, c.key_version
           FROM agent.linked_users u
           JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
          WHERE u.client_id = $1 AND u.active
          ORDER BY u.created_at ASC LIMIT 1`,
        [client.id],
      );
      if (!userRes.rows[0]) throw new AppError(403, "no_credentials", "No hay credenciales activas.");
      const apiKey = decryptSecret(userRes.rows[0], config.credentialMasterKey);
      const odoo = new OdooJson2Client({ baseUrl: client.odoo_base_url, database: client.odoo_database, apiKey });
      return json(response, 200, await confirmOperationalAction({
        db, odoo, actionId: body.action_id, confirmationCode: body.confirmation_code,
      }));
    }

    if (request.method === "POST" && url.pathname === "/v1/sops/search") {
      requireInternal(request);
      const body = await readJson(request);
      const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [body.client_slug]);
      const client = clientRes.rows[0];
      if (!client) throw new AppError(404, "client_not_found", "Cliente no encontrado.");
      return json(response, 200, await answerSopQuery({
        db,
        clientId: client.id,
        query: body.query || "",
        category: body.category,
      }));
    }

    if (request.method === "POST" && url.pathname === "/v1/audit/business/run") {
      requireAdmin(request);
      const body = await readJson(request);
      const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [body.client_slug]);
      const client = clientRes.rows[0];
      if (!client) throw new AppError(404, "client_not_found", "Cliente no encontrado.");
      const userRes = await db.query(
        `SELECT u.*, c.ciphertext, c.nonce, c.auth_tag, c.key_version
           FROM agent.linked_users u
           JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
          WHERE u.client_id = $1 AND u.active
          ORDER BY u.created_at ASC LIMIT 1`,
        [client.id],
      );
      if (!userRes.rows[0]) throw new AppError(403, "no_credentials", "No hay credenciales activas.");
      const apiKey = decryptSecret(userRes.rows[0], config.credentialMasterKey);
      const odoo = new OdooJson2Client({ baseUrl: client.odoo_base_url, database: client.odoo_database, apiKey });
      return json(response, 200, await runFullBusinessAudit({
        db,
        odoo,
        clientId: client.id,
        reportType: body.report_type || "full",
      }));
    }

    throw new AppError(404, "not_found", "Ruta no encontrada.");
  } catch (error) {
    const safe = safeError(error);
    if (safe.status >= 500) {
      process.stderr.write(`[${requestId}] ${error.stack || error.message}\n`);
    }
    return json(response, safe.status, safe.body);
  }
});

server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`control-api escuchando en :${config.port}\n`);
});

async function shutdown(signal) {
  process.stdout.write(`Apagando por ${signal}\n`);
  server.close();
  await db.end();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
