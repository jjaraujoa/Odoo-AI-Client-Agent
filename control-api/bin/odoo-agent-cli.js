#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseWorkflowYaml, evaluateCondition } from "../src/workflow-parser.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { decryptSecret } from "../src/crypto.js";
import { OdooJson2Client } from "../src/odoo.js";
import { readClientWorkbook, syncUsersFromWorkbook, validateClientWorkbook } from "../src/excel-importer.js";

const DEFAULT_CLIENTS_ROOT = process.env.ODOO_CLIENTS_ROOT
  ? resolve(process.env.ODOO_CLIENTS_ROOT)
  : resolve(process.cwd(), "clients");
const TEMPLATE_EXCEL_PATH = resolve(import.meta.dirname, "../../onboarding/consultant-kit/Plantilla-Users.xlsx");

function getClientDirectory(slug, args = {}, options = {}) {
  if (args["target-dir"]) {
    return resolve(options.baseDir || process.cwd(), args["target-dir"]);
  }
  if (options.baseDir) {
    return join(options.baseDir, "clients", slug);
  }
  return join(DEFAULT_CLIENTS_ROOT, slug);
}

function findClientExcelPath(clientDir, explicitFile = null, baseDir = process.cwd()) {
  if (explicitFile) return resolve(baseDir, explicitFile);
  const candidates = ["usuarios.xlsx", "Plantilla-Users.xlsx", "empleados.xlsx"];
  for (const candidate of candidates) {
    const fullPath = join(clientDir, candidate);
    if (existsSync(fullPath)) return fullPath;
  }
  return join(clientDir, "usuarios.xlsx");
}

function printHelp() {
  console.log(`
🛠️  odoo-agent-cli: Herramienta de Consultoría, Instalación y Creación de Flujos

USO:
  odoo-agent-cli <comando> [subcomando] [opciones]

COMANDOS DE CLIENTE:
  client init --slug <slug> --name <nombre> --url <url> --db <bd> [--bot-uid <id>]
      Inicializa la carpeta aislada del cliente en Clientes/<slug>/, copia la plantilla
      usuarios.xlsx (con ejemplos), genera cliente.yaml, .env.example y registra en PostgreSQL.

  client status --client <slug>
      Consulta el estado general del cliente: conexión, usuarios activos, flujos y SOPs.

  users validate [--client <slug>] [--file <ruta_xlsx>]
      Verifica y audita la arquitectura de la plantilla Excel (encabezados, unicidad de IDs,
      tipos de datos de Telegram y Odoo) antes de sincronizar.

  users sync --client <slug> [--file <ruta_xlsx>] [--api-key <default_key>] [--interactive]
      Lee usuarios.xlsx (o Plantilla-Users.xlsx), valida las API Keys contra Odoo y las registra
      cifradas con AES-256-GCM en la base de datos de control.

  mcp [--client <slug>]
      Inicia el servidor MCP por STDIO conectado a Odoo 19 para Antigravity, Claude Desktop o Codex.

COMANDOS DE FLUJOS (WORKFLOW DSL):
  schema dump --client <slug> [--output <path>]
      Extrae los modelos y campos (incluidos Studio x_studio_*) de Odoo 19 para contexto de IA.

  flow new --client <slug> --name <nombre>
      Crea una nueva plantilla de flujo declarativo en Clientes/<slug>/workflows/<nombre>.yaml.

  flow validate <archivo.yaml>
      Valida la sintaxis YAML, esquema y políticas de gobernanza de un flujo.

  flow test <archivo.yaml> --event <evento.json>
      Simula la evaluación de condiciones y ejecución de acciones sin alterar la BD real.

  flow export --client <slug> [--output <path>]
      Empaqueta los flujos y metadatos del cliente para distribución.

OPCIONES:
  --client, --slug <slug>   Identificador del cliente (minúsculas, sin espacios)
  --name <nombre>           Nombre visible de la empresa
  --url <url>               URL HTTPS de Odoo (sin /odoo)
  --db <bd>                 Nombre de la base de datos en Odoo
  --bot-uid <id>            ID numérico del usuario bot de Odoo (anti-bucles)
  --target-dir <path>       Directorio base personalizado (por defecto Clientes/<slug>)
  --help, -h                Muestra esta ayuda
`);
}

function parseArgs(args) {
  const parsed = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const baseDir = options.baseDir || process.cwd();
  const args = parseArgs(argv);
  const command = args._[0];
  const subcommand = args._[1];

  if (!command || args.help || args.h) {
    printHelp();
    return 0;
  }

  // ==========================================
  // COMANDO: client init
  // ==========================================
  if (command === "client" && subcommand === "init") {
    const slug = args.slug || args.client;
    const name = args.name || slug;
    const url = args.url;
    const dbName = args.db;
    const botUid = args["bot-uid"] ? Number(args["bot-uid"]) : 0;

    if (!slug) {
      console.error("❌ Error: Se requiere el parámetro --slug <slug>");
      return 1;
    }

    const clientDir = getClientDirectory(slug, args, options);
    console.log(`🚀 Inicializando cliente '${slug}' en: ${clientDir}...`);

    // 1. Crear directorios aislados
    await mkdir(clientDir, { recursive: true });
    await mkdir(join(clientDir, "workflows"), { recursive: true });
    await mkdir(join(clientDir, "sops"), { recursive: true });

    // 2. Copiar plantilla usuarios.xlsx con ejemplos reales
    const targetExcel = join(clientDir, "usuarios.xlsx");
    try {
      await copyFile(TEMPLATE_EXCEL_PATH, targetExcel);
      console.log(`   ✅ Plantilla 'usuarios.xlsx' copiada con registros de ejemplo.`);
    } catch (err) {
      console.warn(`   ⚠️ Advertencia copiando plantilla excel: ${err.message}`);
    }

    // 3. Generar cliente.yaml (metadatos públicos)
    const clienteYaml = `# Configuración Pública del Cliente Odoo 19
slug: "${slug}"
name: "${name}"
odoo_base_url: "${url || "https://mi-empresa.odoo.com"}"
odoo_database: "${dbName || slug}"
timezone: "America/Bogota"
bot_service_user_id: ${botUid}
active: true
`;
    await writeFile(join(clientDir, "cliente.yaml"), clienteYaml, "utf8");
    console.log(`   ✅ Archivo 'cliente.yaml' generado.`);

    // 4. Generar .env.example para secretos del cliente
    const envExample = `# Variables y Secretos del Cliente: ${slug}
# Complete estos valores de manera segura y renombre este archivo a .env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALERT_CHAT_ID=
ODOO_SERVICE_API_KEY=
# Nota: Las API keys individuales de los empleados se gestionan mediante empleados.xlsx
`;
    await writeFile(join(clientDir, ".env.example"), envExample, "utf8");
    console.log(`   ✅ Plantilla '.env.example' generada para variables secretas.`);

    // 5. Registrar en base de datos PostgreSQL si está disponible
    try {
      const config = loadConfig();
      const db = createDb(config.databaseUrl);
      try {
        await db.query(
          `INSERT INTO agent.clients
             (slug, name, odoo_base_url, odoo_database, timezone, active, settings)
           VALUES ($1, $2, $3, $4, $5, true, $6)
           ON CONFLICT (slug) DO UPDATE SET
             name = EXCLUDED.name,
             odoo_base_url = EXCLUDED.odoo_base_url,
             odoo_database = EXCLUDED.odoo_database,
             timezone = EXCLUDED.timezone,
             settings = EXCLUDED.settings,
             active = true`,
          [
            slug,
            name,
            url || "https://pendiente.odoo.com",
            dbName || slug,
            "America/Bogota",
            JSON.stringify({ read_planner_mode: "active", bot_service_user_id: botUid }),
          ],
        );
        console.log(`   ✅ Cliente registrado exitosamente en la base de datos PostgreSQL.`);
      } finally {
        await db.end();
      }
    } catch {
      console.log(`   ℹ️ Registro en BD omitido (PostgreSQL no configurado localmente en este paso).`);
    }

    console.log(`\n🎉 Cliente '${slug}' listo. Siguientes pasos:`);
    console.log(`   1. Llena 'usuarios.xlsx' en ${clientDir}/ con los usuarios de la empresa.`);
    console.log(`   2. Valida la plantilla: odoo-agent-cli users validate --client ${slug}`);
    console.log(`   3. Sincroniza: odoo-agent-cli users sync --client ${slug}`);
    console.log(`   4. Configura tus secretos en ${clientDir}/.env (a partir de .env.example)`);
    return 0;
  }

  // ==========================================
  // COMANDO: users validate
  // ==========================================
  if (command === "users" && subcommand === "validate") {
    const slug = args.client || args.slug;
    const clientDir = slug ? getClientDirectory(slug, args, options) : process.cwd();
    const excelPath = findClientExcelPath(clientDir, args.file, baseDir);

    console.log(`🔍 Validando arquitectura de la plantilla Excel desde:\n   ${excelPath}\n`);

    if (!existsSync(excelPath)) {
      console.error(`❌ Error: No se encontró el archivo Excel en: ${excelPath}`);
      return 1;
    }

    const audit = validateClientWorkbook(excelPath);

    console.log(`📋 Resumen de la Plantilla:`);
    console.log(`   • Cliente: ${audit.summary.clientName || "(No definido)"} (${audit.summary.clientSlug || "sin slug"})`);
    console.log(`   • URL Odoo: ${audit.summary.odooBaseUrl || "(No definida)"}`);
    console.log(`   • Base de Datos: ${audit.summary.odooDatabase || "(No definida)"}`);
    console.log(`   • Bot Telegram: @${audit.summary.botUsername || "(No configurado)"}`);
    console.log(`   • Parámetros Configuración: ${audit.summary.configParamsCount}`);
    console.log(`   • Total Usuarios: ${audit.summary.totalUsers} (Activos: ${audit.summary.activeUsers}, Borradores: ${audit.summary.draftUsers})`);
    console.log(`   • Usuarios que solicitan API Key: ${audit.summary.requestApiKeyUsers}`);

    if (audit.warnings.length > 0) {
      console.log(`\n⚠️  Advertencias (${audit.warnings.length}):`);
      for (const w of audit.warnings) {
        console.log(`   • ${w}`);
      }
    }

    if (audit.errors.length > 0) {
      console.log(`\n❌ Errores Críticos (${audit.errors.length}):`);
      for (const e of audit.errors) {
        console.log(`   • ${e}`);
      }
      console.log(`\n❌ La plantilla contiene errores estructurales que deben corregirse antes de sincronizar.`);
      return 1;
    }

    console.log(`\n✅ ¡Plantilla válida! La arquitectura y tipos de datos cumplen los estándares.`);
    return 0;
  }

  // ==========================================
  // COMANDO: users sync
  // ==========================================
  if (command === "users" && subcommand === "sync") {
    const slug = args.client || args.slug;
    if (!slug) {
      console.error("❌ Error: Se requiere el parámetro --client <slug>");
      return 1;
    }

    const clientDir = getClientDirectory(slug, args, options);
    const excelPath = findClientExcelPath(clientDir, args.file, baseDir);

    console.log(`📥 Sincronizando usuarios para el cliente '${slug}' desde:\n   ${excelPath}...`);

    if (!existsSync(excelPath)) {
      console.error(`❌ Error: No se encontró el archivo Excel en: ${excelPath}`);
      return 1;
    }

    // Validación previa obligatoria de la arquitectura del Excel
    const audit = validateClientWorkbook(excelPath);
    if (!audit.valid) {
      console.error(`\n❌ La plantilla Excel contiene errores estructurales:`);
      for (const err of audit.errors) {
        console.error(`   • ${err}`);
      }
      console.error(`\nCorrige los errores antes de sincronizar o ejecuta 'users validate'.`);
      return 1;
    }

    let config = null;
    let db = null;
    try {
      config = loadConfig();
      db = createDb(config.databaseUrl);
    } catch {
      // Continuar en modo inspección si no hay BD
    }

    try {
      let client = { id: slug, slug, odoo_base_url: "", odoo_database: "" };
      if (db) {
        const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [slug]);
        if (clientRes.rows[0]) {
          client = clientRes.rows[0];
        }
      }

      // Si no tenemos URL en BD, intentar leer cliente.yaml
      try {
        const yamlRaw = await readFile(join(clientDir, "cliente.yaml"), "utf8");
        const matchUrl = yamlRaw.match(/odoo_base_url:\s*"([^"]+)"/);
        const matchDb = yamlRaw.match(/odoo_database:\s*"([^"]+)"/);
        if (matchUrl) client.odoo_base_url = matchUrl[1];
        if (matchDb) client.odoo_database = matchDb[1];
      } catch {}

      const userApiKeys = {};
      if (args["api-key"]) {
        userApiKeys["default"] = args["api-key"];
      }

      // Si se ejecuta con flag --interactive y estamos en terminal interactiva TTY
      if (args.interactive && process.stdin.isTTY) {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const parsedPreview = readClientWorkbook(excelPath);
          for (const u of parsedPreview.users) {
            if (u.active && u.requestApiKey && !userApiKeys[u.rowId] && !u.odooApiKey) {
              const enteredKey = await rl.question(`🔑 Ingresa la API Key de Odoo para ${u.odooLogin} [${u.rowId}] (Enter para omitir): `);
              if (enteredKey.trim()) {
                userApiKeys[u.rowId] = enteredKey.trim();
              }
            }
          }
        } finally {
          rl.close();
        }
      }

      const syncRes = await syncUsersFromWorkbook({
        db,
        config,
        client,
        filePath: excelPath,
        userApiKeys,
      });

      console.log(`\n📊 Resumen de Sincronización:`);
      console.log(`   • Total usuarios en Excel: ${syncRes.total}`);
      console.log(`   • Usuarios activos: ${syncRes.active}`);
      console.log(`   • Usuarios en borrador: ${syncRes.drafts}`);
      console.log(`   • Credenciales Odoo verificadas en tiempo real: ${syncRes.verified}`);

      if (syncRes.users.length > 0) {
        console.log(`\n👥 Detalle de Usuarios:`);
        for (const u of syncRes.users) {
          const statusIcon = u.active ? (u.verified ? "✅" : "⚠️") : "⏸️";
          console.log(`   ${statusIcon} [${u.rowId}] ${u.login} | Telegram: ${u.telegramId || "(Sin ID)"} | Odoo UID: ${u.odooUid || "(No validado)"}`);
        }
      }

      if (syncRes.errors.length > 0) {
        console.log(`\n⚠️ Advertencias / Errores:`);
        for (const e of syncRes.errors) {
          console.log(`   • [${e.rowId}] ${e.error}`);
        }
      }

      return 0;
    } finally {
      if (db) await db.end();
    }
  }

  // ==========================================
  // COMANDO: client status
  // ==========================================
  if (command === "client" && subcommand === "status") {
    const slug = args.client || args.slug;
    if (!slug) {
      console.error("❌ Error: Se requiere --client <slug>");
      return 1;
    }

    const clientDir = getClientDirectory(slug, args, options);
    console.log(`🔍 Consultando estado del cliente '${slug}'...`);
    console.log(`   • Carpeta local: ${clientDir}`);

    try {
      const config = loadConfig();
      const db = createDb(config.databaseUrl);
      try {
        const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1", [slug]);
        const client = clientRes.rows[0];
        if (!client) {
          console.log(`   • Estado en BD: No registrado en agent.clients`);
        } else {
          console.log(`   • Estado en BD: Activo (Nombre: ${client.name})`);
          console.log(`   • Odoo URL: ${client.odoo_base_url} (BD: ${client.odoo_database})`);

          const usersRes = await db.query("SELECT count(*)::int AS count FROM agent.linked_users WHERE client_id = $1", [client.id]);
          console.log(`   • Empleados vinculados en BD: ${usersRes.rows[0].count}`);

          const sopsRes = await db.query("SELECT count(*)::int AS count FROM agent.client_sops WHERE client_id = $1", [client.id]);
          console.log(`   • Procedimientos SOPs registrados: ${sopsRes.rows[0].count}`);
        }
      } finally {
        await db.end();
      }
    } catch {
      console.log(`   • Estado en BD: Sin conexión a PostgreSQL`);
    }

    return 0;
  }

  // ==========================================
  // COMANDO: mcp
  // ==========================================
  if (command === "mcp") {
    const { spawn } = await import("node:child_process");
    const mcpScript = resolve(import.meta.dirname, "odoo-mcp.js");
    const subProcess = spawn(process.execPath, [mcpScript, ...argv.slice(1)], {
      stdio: "inherit",
    });
    return new Promise((res) => {
      subProcess.on("exit", (code) => res(code || 0));
    });
  }

  // ==========================================
  // COMANDO: schema dump
  // ==========================================
  if (command === "schema" && subcommand === "dump") {
    const slug = args.client || args.slug;
    if (!slug) {
      console.error("❌ Error: Se requiere el parámetro --client <slug>");
      return 1;
    }

    console.log(`📡 Conectando a Odoo para extraer esquema del cliente '${slug}'...`);
    let baseUrl = null;
    let database = null;
    let apiKey = null;

    // 1. Intentar cargar desde la carpeta local del cliente
    const clientDir = getClientDirectory(slug, args, options);
    const yamlPath = join(clientDir, "cliente.yaml");
    const envPath = join(clientDir, ".env");

    if (existsSync(yamlPath)) {
      const clientYaml = parseYaml(await readFile(yamlPath, "utf8"));
      baseUrl = clientYaml.odoo_base_url;
      database = clientYaml.odoo_database;

      if (existsSync(envPath)) {
        const envRaw = await readFile(envPath, "utf8");
        for (const line of envRaw.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("ODOO_SERVICE_API_KEY=")) {
            apiKey = trimmed.slice("ODOO_SERVICE_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
          }
        }
      }
    }

    // 2. Si no se resolvió localmente, intentar mediante base de datos centralizada
    if (!apiKey) {
      const config = loadConfig();
      const db = createDb(config.databaseUrl);
      try {
        const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [slug]);
        const client = clientRes.rows[0];
        if (!client) {
          console.error(`❌ Cliente '${slug}' no encontrado en BD ni con API key en carpeta local.`);
          return 1;
        }
        baseUrl = client.odoo_base_url;
        database = client.odoo_database;

        const userRes = await db.query(
          `SELECT u.*, c.ciphertext, c.nonce, c.auth_tag, c.key_version
             FROM agent.linked_users u
             JOIN agent.odoo_credentials c ON c.linked_user_id = u.id
            WHERE u.client_id = $1 AND u.active
            ORDER BY u.created_at ASC LIMIT 1`,
          [client.id],
        );
        if (!userRes.rows[0]) {
          console.error(`❌ No hay credenciales activas para el cliente '${slug}'.`);
          return 1;
        }
        apiKey = decryptSecret(userRes.rows[0], config.credentialMasterKey);
      } finally {
        await db.end().catch(() => {});
      }
    }

    const odoo = new OdooJson2Client({
      baseUrl,
      database,
      apiKey,
    });

    const fields = await odoo.searchRead(
      "ir.model.fields",
      [["model", "in", ["sale.order", "purchase.order", "account.move", "stock.picking", "res.partner", "product.product", "crm.lead"]]],
      ["model", "name", "field_description", "ttype", "required", "readonly"],
      { limit: 500 },
    );

    const studioFields = fields.filter((f) => f.name.startsWith("x_studio_") || f.name.startsWith("x_"));
    const outputDir = getClientDirectory(slug, args, options);
    await mkdir(outputDir, { recursive: true });
    const outputPath = args.output ? resolve(baseDir, args.output) : join(outputDir, "schema.json");

    const dumpPayload = {
      client_slug: slug,
      extracted_at: new Date().toISOString(),
      models_analyzed: [...new Set(fields.map((f) => f.model))],
      total_fields: fields.length,
      studio_fields_count: studioFields.length,
      studio_fields: studioFields,
      fields,
    };

    await writeFile(outputPath, JSON.stringify(dumpPayload, null, 2), "utf8");
    console.log(`✅ Esquema exportado con éxito a: ${outputPath}`);
    console.log(`   - Modelos analizados: ${dumpPayload.models_analyzed.join(", ")}`);
    console.log(`   - Total campos: ${fields.length} (Campos personalizados Studio: ${studioFields.length})`);
    return 0;
  }

  // ==========================================
  // COMANDO: flow new
  // ==========================================
  if (command === "flow" && subcommand === "new") {
    const slug = args.client || args.slug;
    const name = args.name;
    if (!slug || !name) {
      console.error("❌ Error: Se requieren --client <slug> y --name <nombre>");
      return 1;
    }

    const clientDir = getClientDirectory(slug, args, options);
    const flowDir = join(clientDir, "workflows");
    await mkdir(flowDir, { recursive: true });
    const targetPath = join(flowDir, `${name}.yaml`);

    const template = `# Especificación de Flujo Declarativo (Workflow DSL)
# Cliente: ${slug}
name: "${name}"
description: "Flujo automatizado de negocio para ${slug}"
trigger:
  source: "odoo.base_automation"
  model: "sale.order"
  event: "on_write"
  field: "state"
  condition: "record.state == 'sale' and record.amount_total >= 5000000"

actions:
  - step: 1
    action: "odoo.create_draft_invoice"
    policy: "autonomous"
  - step: 2
    action: "odoo.assign_responsible"
    policy: "autonomous"
    params:
      userId: 2

notifications:
  chatter:
    target: "sale.order"
    template: "Flujo '${name}' ejecutado exitosamente por el Agente de Negocio."
  telegram:
    recipient: "supervisor"
`;

    await writeFile(targetPath, template, "utf8");
    console.log(`✅ Plantilla de flujo creada exitosamente en:\n   ${targetPath}`);
    return 0;
  }

  // ==========================================
  // COMANDO: flow validate
  // ==========================================
  if (command === "flow" && subcommand === "validate") {
    const filePath = args._[2];
    if (!filePath) {
      console.error("❌ Error: Especifica el archivo YAML a validar: odoo-agent-cli flow validate <archivo.yaml>");
      return 1;
    }

    try {
      const fullPath = resolve(baseDir, filePath);
      const raw = await readFile(fullPath, "utf8");
      const parsed = parseWorkflowYaml(raw);

      console.log(`✅ Flujo válido: '${parsed.name}'`);
      console.log(`   - Descripción: ${parsed.description || "Sin descripción"}`);
      console.log(`   - Trigger: ${parsed.trigger.model} (${parsed.trigger.event || "cualquiera"})`);
      console.log(`   - Condición: ${parsed.trigger.condition || "(Sin condición previa)"}`);
      console.log(`   - Acciones definidas (${parsed.actions.length}):`);
      for (const act of parsed.actions) {
        console.log(`     • Paso ${act.step || "-"}: ${act.action} [Política: ${act.policy || "autonomous"}]`);
      }
      return 0;
    } catch (err) {
      console.error(`❌ Flujo inválido: ${err.message}`);
      return 1;
    }
  }

  // ==========================================
  // COMANDO: flow test
  // ==========================================
  if (command === "flow" && subcommand === "test") {
    const filePath = args._[2];
    const eventPath = args.event;
    if (!filePath) {
      console.error("❌ Error: Especifica el archivo YAML a probar.");
      return 1;
    }

    try {
      const flowRaw = await readFile(resolve(baseDir, filePath), "utf8");
      const workflow = parseWorkflowYaml(flowRaw);

      let eventData = {
        record: { state: "sale", amount_total: 6000000, partner_id: [1, "Cliente VIP"] },
        event: { model: workflow.trigger.model, event: "on_write", res_id: 1001 },
      };

      if (eventPath) {
        const eventRaw = await readFile(resolve(baseDir, eventPath), "utf8");
        eventData = JSON.parse(eventRaw);
      }

      console.log(`🧪 Simulando ejecución de flujo '${workflow.name}'...`);
      console.log(`   - Modelo objetivo: ${workflow.trigger.model}`);
      console.log(`   - Condición: ${workflow.trigger.condition || "true"}`);

      const matches = evaluateCondition(workflow.trigger.condition, {
        record: eventData.record || {},
        event: eventData.event || eventData,
      });

      console.log(`   - Evaluación de condición: ${matches ? "✅ CUMPLE (Se dispararía)" : "❌ NO CUMPLE (Se ignoraría)"}`);

      if (matches) {
        console.log("\n📋 Pasos que se ejecutarían:");
        for (const step of workflow.actions) {
          console.log(`   [Paso ${step.step}] Acción: ${step.action} (Política: ${step.policy || "autonomous"})`);
        }
      }
      return 0;
    } catch (err) {
      console.error(`❌ Error en simulación: ${err.message}`);
      return 1;
    }
  }

  // ==========================================
  // COMANDO: flow export
  // ==========================================
  if (command === "flow" && subcommand === "export") {
    const slug = args.client || args.slug;
    if (!slug) {
      console.error("❌ Error: Se requiere --client <slug>");
      return 1;
    }

    const clientDir = getClientDirectory(slug, args, options);
    const flowDir = join(clientDir, "workflows");
    const outputPath = args.output ? resolve(baseDir, args.output) : join(clientDir, `${slug}-flows-bundle.json`);
    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(flowDir);
      const bundle = {
        client_slug: slug,
        exported_at: new Date().toISOString(),
        workflows: [],
      };

      for (const file of files) {
        if (file.endsWith(".yaml") || file.endsWith(".yml")) {
          const content = await readFile(join(flowDir, file), "utf8");
          bundle.workflows.push({
            filename: file,
            definition: parseWorkflowYaml(content),
            raw_yaml: content,
          });
        }
      }

      await writeFile(outputPath, JSON.stringify(bundle, null, 2), "utf8");
      console.log(`✅ Paquete de flujos exportado exitosamente a:\n   ${outputPath} (${bundle.workflows.length} flujos incluidos)`);
      return 0;
    } catch (err) {
      console.error(`❌ Error al exportar flujos: ${err.message}`);
      return 1;
    }
  }

  console.error(`❌ Comando desconocido: ${command} ${subcommand || ""}`);
  printHelp();
  return 1;
}

// Ejecutar si se llama directamente como CLI
if (process.argv[1]?.endsWith("odoo-agent-cli.js") || process.argv[1]?.endsWith("odoo-agent-cli")) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
