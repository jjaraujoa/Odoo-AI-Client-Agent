import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readClientWorkbook, syncUsersFromWorkbook, validateClientWorkbook } from "../src/excel-importer.js";
import { runCli } from "../bin/odoo-agent-cli.js";

const USERS_TEMPLATE_PATH = resolve(import.meta.dirname, "../../onboarding/consultant-kit/Plantilla-Users.xlsx");

test("readClientWorkbook extrae datos de cliente, telegram, configuración y usuarios desde Plantilla-Users.xlsx", () => {
  const data = readClientWorkbook(USERS_TEMPLATE_PATH);

  // 1. Validar sección Cliente
  assert.equal(data.client.slug, "piloto-odoo19");
  assert.equal(data.client.name, "Piloto interno Odoo 19");
  assert.ok(data.client.odoo_base_url.includes("odoo.com"));
  assert.equal(data.client.timezone, "America/Bogota");

  // 2. Validar sección Telegram
  assert.equal(data.telegram.bot_name, "Odoo AI Piloto");
  assert.equal(data.telegram.bot_username, "xeta_odoo_ai_test_bot");

  // 3. Validar sección Configuración
  assert.equal(data.configuration.requests_per_minute, 10);
  assert.equal(data.configuration.max_odoo_records, 50);

  // 4. Validar sección Usuarios
  assert.ok(Array.isArray(data.users));
  assert.equal(data.users.length, 1); // 1 usuario configurado, 50+ filas vacías filtradas

  const firstUser = data.users[0];
  assert.equal(firstUser.rowId, "TEST-001");
  assert.equal(firstUser.active, true);
  assert.equal(firstUser.odooLogin, "example@example.com");
  assert.equal(firstUser.telegramUserId, "665768493");
  assert.equal(firstUser.requestApiKey, true);
});

test("validateClientWorkbook verifica arquitectura e integridad de Plantilla-Users.xlsx", () => {
  const audit = validateClientWorkbook(USERS_TEMPLATE_PATH);

  assert.equal(audit.valid, true);
  assert.equal(audit.errors.length, 0);
  assert.equal(audit.summary.clientSlug, "piloto-odoo19");
  assert.equal(audit.summary.botUsername, "xeta_odoo_ai_test_bot");
  assert.equal(audit.summary.totalUsers, 1);
  assert.equal(audit.summary.activeUsers, 1);
  assert.equal(audit.summary.requestApiKeyUsers, 1);
});

test("syncUsersFromWorkbook valida credenciales y persiste cifrado en base de datos", async () => {
  const dbQueries = [];
  const mockDb = {
    async query(sql, params) {
      dbQueries.push({ sql, params });
      if (sql.includes("agent.linked_users")) {
        return { rows: [{ id: "linked-user-uuid-1" }] };
      }
      if (sql.includes("agent.odoo_credentials")) {
        return { rows: [{ id: "cred-uuid-1" }] };
      }
      return { rows: [] };
    },
  };

  const mockConfig = {
    credentialMasterKey: Buffer.alloc(32, 7), // 32 bytes de clave maestra
  };

  const client = {
    id: "client-test-uuid",
    slug: "cliente-demo",
    odoo_base_url: "https://demo.odoo.com",
    odoo_database: "demo",
  };

  const results = await syncUsersFromWorkbook({
    db: mockDb,
    config: mockConfig,
    client,
    filePath: USERS_TEMPLATE_PATH,
    userApiKeys: {
      "TEST-001": "secret_odoo_api_key_12345",
    },
  });

  assert.equal(results.total, 1);
  assert.equal(results.active, 1);
  assert.equal(results.users[0].rowId, "TEST-001");
  assert.equal(results.users[0].hasApiKey, true);

  // Verificar que se invocaron las inserciones en la base de datos
  const linkedUserInsert = dbQueries.find((q) => q.sql.includes("agent.linked_users"));
  assert.ok(linkedUserInsert);
  assert.equal(linkedUserInsert.params[0], "client-test-uuid");
  assert.equal(linkedUserInsert.params[1], "TEST-001");
  assert.equal(linkedUserInsert.params[2], "example@example.com");

  const credInsert = dbQueries.find((q) => q.sql.includes("agent.odoo_credentials"));
  assert.ok(credInsert);
  assert.equal(credInsert.params[0], "linked-user-uuid-1");
  assert.equal(credInsert.params[1], "aes-256-gcm");
  // La clave nunca se guarda en texto plano
  assert.ok(Buffer.isBuffer(credInsert.params[2])); // Ciphertext
  assert.equal(credInsert.params[7], "2345");       // Last four
});

test("odoo-agent-cli client init genera estructura aislada con plantilla de ejemplo y valida usuarios", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "odoo-client-init-"));
  try {
    const code = await runCli([
      "client", "init",
      "--slug", "empresa-alfa",
      "--name", "Empresa Alfa S.A.S",
      "--url", "https://alfa.odoo.com",
      "--db", "alfa-prod",
      "--bot-uid", "15",
      "--target-dir", tempDir,
    ]);

    assert.equal(code, 0);

    // 1. Verificar cliente.yaml
    const yamlContent = await readFile(join(tempDir, "cliente.yaml"), "utf8");
    assert.ok(yamlContent.includes('slug: "empresa-alfa"'));
    assert.ok(yamlContent.includes('name: "Empresa Alfa S.A.S"'));
    assert.ok(yamlContent.includes('odoo_base_url: "https://alfa.odoo.com"'));
    assert.ok(yamlContent.includes('bot_service_user_id: 15'));

    // 2. Verificar .env.example
    const envExampleContent = await readFile(join(tempDir, ".env.example"), "utf8");
    assert.ok(envExampleContent.includes("TELEGRAM_BOT_TOKEN="));
    assert.ok(envExampleContent.includes("ODOO_SERVICE_API_KEY="));

    // 3. Verificar usuarios.xlsx copiado
    await assert.doesNotReject(() => access(join(tempDir, "usuarios.xlsx")));
    const excelCheck = readClientWorkbook(join(tempDir, "usuarios.xlsx"));
    assert.equal(excelCheck.users.length, 1);
    assert.equal(excelCheck.users[0].rowId, "TEST-001");

    // 4. Verificar subcarpetas workflows y sops
    await assert.doesNotReject(() => access(join(tempDir, "workflows")));
    await assert.doesNotReject(() => access(join(tempDir, "sops")));

    // 5. Verificar users validate sobre el directorio generado
    const codeValidate = await runCli([
      "users", "validate",
      "--slug", "empresa-alfa",
      "--target-dir", tempDir,
    ]);
    assert.equal(codeValidate, 0);

    // 6. Verificar users sync sobre el directorio generado
    const codeSync = await runCli([
      "users", "sync",
      "--slug", "empresa-alfa",
      "--target-dir", tempDir,
    ]);
    assert.equal(codeSync, 0);

    // 7. Verificar client status
    const codeStatus = await runCli([
      "client", "status",
      "--slug", "empresa-alfa",
      "--target-dir", tempDir,
    ]);
    assert.equal(codeStatus, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
