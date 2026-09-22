#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { OdooJson2Client } from "../src/odoo.js";
import { McpServer } from "../src/mcp-server.js";
import { decryptSecret } from "../src/crypto.js";

const DEFAULT_CLIENTS_ROOT = process.env.ODOO_CLIENTS_ROOT
  ? resolve(process.env.ODOO_CLIENTS_ROOT)
  : resolve(process.cwd(), "clients");

function parseArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return fallback;
}

async function loadEnvFile(envPath) {
  const env = {};
  if (!existsSync(envPath)) return env;
  try {
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    }
  } catch (err) {
    process.stderr.write(`[odoo-mcp] Advertencia al leer .env: ${err.message}\n`);
  }
  return env;
}

async function main() {
  let clientSlug = parseArg("--client", process.env.ODOO_CLIENT_SLUG);
  const targetDirArg = parseArg("--dir", null);
  const userLogin = parseArg("--user", process.env.ODOO_USER_LOGIN);

  // 1. Determinar el directorio del cliente
  let clientDir = null;
  if (targetDirArg && existsSync(targetDirArg)) {
    clientDir = resolve(targetDirArg);
  } else if (existsSync(join(process.cwd(), "cliente.yaml"))) {
    clientDir = process.cwd();
  } else if (clientSlug && existsSync(join(DEFAULT_CLIENTS_ROOT, clientSlug))) {
    clientDir = join(DEFAULT_CLIENTS_ROOT, clientSlug);
  }

  // 2. Si se localizó una carpeta de cliente con cliente.yaml
  if (clientDir && existsSync(join(clientDir, "cliente.yaml"))) {
    try {
      const yamlRaw = await readFile(join(clientDir, "cliente.yaml"), "utf8");
      const clientConfig = parseYaml(yamlRaw);
      const envSecrets = await loadEnvFile(join(clientDir, ".env"));

      clientSlug = clientConfig.slug || clientSlug;
      const baseUrl = clientConfig.odoo_base_url;
      const database = clientConfig.odoo_database;
      const apiKey = envSecrets.ODOO_SERVICE_API_KEY || process.env.ODOO_SERVICE_API_KEY;

      if (!apiKey) {
        process.stderr.write(
          `❌ [odoo-mcp] Falta ODOO_SERVICE_API_KEY en '${join(clientDir, ".env")}'.\n` +
          `   Configura la clave generada en Odoo para conectarte.\n`
        );
        process.exit(1);
      }

      const odoo = new OdooJson2Client({
        baseUrl,
        database,
        apiKey,
      });

      // Conexión opcional a base de datos de control
      let db = null;
      let config = null;
      const dbUrl = envSecrets.DATABASE_URL || process.env.DATABASE_URL;
      if (dbUrl) {
        try {
          config = loadConfig();
          db = createDb(dbUrl);
          await db.query("SELECT 1");
        } catch {
          db = null;
        }
      }

      const mcpServer = new McpServer({
        odoo,
        client: clientConfig,
        db,
        config: config || {},
        linkedUser: { odoo_login: envSecrets.ODOO_LOGIN || userLogin || "agent@ai.com" },
      });

      process.stderr.write(`✅ [odoo-mcp] Servidor MCP conectado a Odoo 19: ${baseUrl} (${database}) | Cliente: ${clientSlug}\n`);
      mcpServer.startStdio(process.stdin, process.stdout);
      return;
    } catch (err) {
      process.stderr.write(`❌ [odoo-mcp] Error al iniciar desde carpeta local: ${err.message}\n`);
      process.exit(1);
    }
  }

  // 3. Modo alternativo: Base de datos centralizada PostgreSQL
  if (!clientSlug) {
    process.stderr.write("❌ [odoo-mcp] Debe especificar el cliente con --client <slug> o ejecutar dentro de la carpeta del cliente.\n");
    process.exit(1);
  }

  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  try {
    const clientRes = await db.query(
      "SELECT * FROM agent.clients WHERE slug = $1 AND active",
      [clientSlug],
    );
    const client = clientRes.rows[0];
    if (!client) {
      process.stderr.write(`❌ [odoo-mcp] Cliente '${clientSlug}' no encontrado o inactivo en BD.\n`);
      await db.end();
      process.exit(1);
    }

    let apiKey = null;
    let linkedUser = null;

    if (userLogin) {
      const userRes = await db.query(
        `SELECT u.*, c.ciphertext, c.nonce, c.auth_tag, c.key_version
           FROM agent.linked_users u
           JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
          WHERE u.client_id = $1 AND u.odoo_login = $2 AND u.active`,
        [client.id, userLogin],
      );
      if (userRes.rows[0]) {
        linkedUser = userRes.rows[0];
        apiKey = decryptSecret(linkedUser, config.credentialMasterKey);
      }
    }

    if (!apiKey) {
      const fallbackRes = await db.query(
        `SELECT u.*, c.ciphertext, c.nonce, c.auth_tag, c.key_version
           FROM agent.linked_users u
           JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
          WHERE u.client_id = $1 AND u.active
          ORDER BY u.created_at ASC
          LIMIT 1`,
        [client.id],
      );
      if (fallbackRes.rows[0]) {
        linkedUser = fallbackRes.rows[0];
        apiKey = decryptSecret(linkedUser, config.credentialMasterKey);
      }
    }

    if (!apiKey) {
      process.stderr.write(`❌ [odoo-mcp] No se encontraron credenciales activas para '${clientSlug}'.\n`);
      await db.end();
      process.exit(1);
    }

    const odoo = new OdooJson2Client({
      baseUrl: client.odoo_base_url,
      database: client.odoo_database,
      apiKey,
    });

    const mcpServer = new McpServer({
      odoo,
      client,
      db,
      config,
      linkedUser,
    });

    process.stderr.write(`✅ [odoo-mcp] Servidor MCP conectado (BD) para: ${client.slug} (${linkedUser?.odoo_login})\n`);
    mcpServer.startStdio(process.stdin, process.stdout);
  } catch (err) {
    process.stderr.write(`❌ [odoo-mcp] Error fatal en base de datos: ${err.message}\n`);
    await db.end().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`❌ [odoo-mcp] Error fatal: ${err.message}\n`);
  process.exit(1);
});
