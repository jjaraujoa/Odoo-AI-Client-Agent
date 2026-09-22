import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readClientWorkbook, syncUsersFromWorkbook } from "../src/excel-importer.js";
import { runCli } from "../bin/odoo-agent-cli.js";

const PILOT_EXCEL_PATH = resolve(import.meta.dirname, "../../onboarding/consultant-kit/Cliente-PRG-Piloto.xlsx");

test("readClientWorkbook extrae datos de cliente y lista de usuarios con ejemplos reales", () => {
  const data = readClientWorkbook(PILOT_EXCEL_PATH);

  // Validar sección Cliente
  assert.equal(data.client.slug, "piloto-odoo19");
  assert.equal(data.client.name, "Piloto interno Odoo 19");
  assert.ok(data.client.odoo_base_url.includes("odoo.com"));
  assert.equal(data.client.timezone, "America/Bogota");

  // Validar sección Usuarios
  assert.ok(Array.isArray(data.users));
  assert.ok(data.users.length >= 1);

  const firstUser = data.users[0];
  assert.equal(firstUser.rowId, "PRG-001");
  assert.equal(firstUser.active, true);
  assert.equal(firstUser.odooLogin, "jorge.araujo@pragmatic.com.co");
  assert.equal(firstUser.telegramUserId, "6657005904");
  assert.equal(firstUser.requestApiKey, true);
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
    filePath: PILOT_EXCEL_PATH,
    userApiKeys: {
      "PRG-001": "secret_odoo_api_key_12345",
    },
  });

  assert.ok(results.total >= 1);
  assert.ok(results.active >= 1);
  assert.equal(results.users[0].rowId, "PRG-001");
  assert.equal(results.users[0].hasApiKey, true);

  // Verificar que se invocaron las inserciones en la base de datos
  const linkedUserInsert = dbQueries.find((q) => q.sql.includes("agent.linked_users"));
  assert.ok(linkedUserInsert);
  assert.equal(linkedUserInsert.params[0], "client-test-uuid");
  assert.equal(linkedUserInsert.params[1], "PRG-001");
  assert.equal(linkedUserInsert.params[2], "jorge.araujo@pragmatic.com.co");

  const credInsert = dbQueries.find((q) => q.sql.includes("agent.odoo_credentials"));
  assert.ok(credInsert);
  assert.equal(credInsert.params[0], "linked-user-uuid-1");
  assert.equal(credInsert.params[1], "aes-256-gcm");
  // La clave nunca se guarda en texto plano
  assert.ok(Buffer.isBuffer(credInsert.params[2])); // Ciphertext
  assert.equal(credInsert.params[7], "2345");       // Last four
});

test("odoo-agent-cli client init genera estructura aislada con plantilla de ejemplo", async () => {
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

    // 3. Verificar empleados.xlsx copiado
    await assert.doesNotReject(() => access(join(tempDir, "empleados.xlsx")));
    const excelCheck = readClientWorkbook(join(tempDir, "empleados.xlsx"));
    assert.ok(excelCheck.users.length >= 1);
    assert.equal(excelCheck.users[0].rowId, "PRG-001");

    // 4. Verificar subcarpetas workflows y sops
    await assert.doesNotReject(() => access(join(tempDir, "workflows")));
    await assert.doesNotReject(() => access(join(tempDir, "sops")));

    // 5. Verificar users sync sobre el directorio generado
    const codeSync = await runCli([
      "users", "sync",
      "--slug", "empresa-alfa",
      "--target-dir", tempDir,
    ]);
    assert.equal(codeSync, 0);

    // 6. Verificar client status
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
