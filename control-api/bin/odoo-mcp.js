#!/usr/bin/env node

import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { OdooJson2Client } from "../src/odoo.js";
import { McpServer } from "../src/mcp-server.js";
import { decryptSecret } from "../src/crypto.js";

function parseArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return fallback;
}

async function main() {
  const clientSlug = parseArg("--client", process.env.ODOO_CLIENT_SLUG);
  if (!clientSlug) {
    process.stderr.write("Error: Debe especificar el cliente con --client <slug> o ODOO_CLIENT_SLUG.\n");
    process.exit(1);
  }

  const userLogin = parseArg("--user", process.env.ODOO_USER_LOGIN);

  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  const clientRes = await db.query(
    "SELECT * FROM agent.clients WHERE slug = $1 AND active",
    [clientSlug],
  );
  const client = clientRes.rows[0];
  if (!client) {
    process.stderr.write(`Error: Cliente '${clientSlug}' no encontrado o inactivo.\n`);
    await db.end();
    process.exit(1);
  }

  // Buscar credencial individual de usuario o credencial de servicio
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

  // Si no se especificó usuario o no se encontró, tomar el primer usuario activo del cliente
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
    process.stderr.write(`Error: No se encontraron credenciales de Odoo activas para el cliente '${clientSlug}'.\n`);
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

  process.stderr.write(`Servidor MCP de Odoo iniciado para cliente: ${client.slug} (${linkedUser?.odoo_login || "servicio"})\n`);
  mcpServer.startStdio(process.stdin, process.stdout);
}

main().catch((err) => {
  process.stderr.write(`Error fatal en servidor MCP: ${err.message}\n`);
  process.exit(1);
});
