#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseWorkflowYaml, evaluateCondition } from "../src/workflow-parser.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { decryptSecret } from "../src/crypto.js";
import { OdooJson2Client } from "../src/odoo.js";

function printHelp() {
  console.log(`
🛠️  odoo-agent-cli: Herramienta de Consultoría y Creación de Flujos de Negocio

USO:
  odoo-agent-cli <comando> [opciones]

COMANDOS:
  schema dump --client <slug> [--output <path>]
      Extrae los modelos y campos (incluidos Studio x_studio_*) de Odoo 19 para contexto de IA.

  flow new --client <slug> --name <nombre>
      Crea una nueva plantilla de flujo declarativo en clients/<slug>/workflows/<nombre>.yaml.

  flow validate <archivo.yaml>
      Valida la sintaxis YAML, esquema y políticas de gobernanza de un flujo.

  flow test <archivo.yaml> --event <evento.json>
      Simula la evaluación de condiciones y ejecución de acciones sin alterar la BD real.

  flow export --client <slug> [--output <path>]
      Empaqueta los flujos y metadatos del cliente para distribución.

OPCIONES:
  --client <slug>     Identificador del cliente en la base de datos
  --name <nombre>     Nombre identificador del flujo
  --event <path>      Archivo JSON con payload de evento para pruebas
  --output <path>     Ruta de salida personalizada
  --help, -h          Muestra esta ayuda
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

export async function runCli(argv = process.argv.slice(2), { baseDir = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const command = args._[0];
  const subcommand = args._[1];

  if (!command || args.help || args.h) {
    printHelp();
    return 0;
  }

  // 1. Comando schema dump
  if (command === "schema" && subcommand === "dump") {
    const slug = args.client;
    if (!slug) {
      console.error("❌ Error: Se requiere el parámetro --client <slug>");
      return 1;
    }

    console.log(`📡 Conectando a Odoo para extraer esquema del cliente '${slug}'...`);
    const config = loadConfig();
    const db = createDb(config.databaseUrl);
    try {
      const clientRes = await db.query("SELECT * FROM agent.clients WHERE slug = $1 AND active", [slug]);
      const client = clientRes.rows[0];
      if (!client) {
        console.error(`❌ Cliente '${slug}' no encontrado o inactivo.`);
        return 1;
      }

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

      const apiKey = decryptSecret(userRes.rows[0], config.credentialMasterKey);
      const odoo = new OdooJson2Client({
        baseUrl: client.odoo_base_url,
        database: client.odoo_database,
        apiKey,
      });

      const fields = await odoo.searchRead(
        "ir.model.fields",
        [["model", "in", ["sale.order", "purchase.order", "account.move", "stock.picking", "res.partner", "product.product"]]],
        ["model", "name", "field_description", "ttype", "required", "readonly"],
        { limit: 500 },
      );

      const studioFields = fields.filter((f) => f.name.startsWith("x_studio_") || f.name.startsWith("x_"));
      const outputDir = join(baseDir, "clients", slug);
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
    } finally {
      await db.end();
    }
  }

  // 2. Comando flow new
  if (command === "flow" && subcommand === "new") {
    const slug = args.client;
    const name = args.name;
    if (!slug || !name) {
      console.error("❌ Error: Se requieren --client <slug> y --name <nombre>");
      return 1;
    }

    const flowDir = join(baseDir, "clients", slug, "workflows");
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

  // 3. Comando flow validate
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

  // 4. Comando flow test (Simulación de eventos)
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

  // 5. Comando flow export
  if (command === "flow" && subcommand === "export") {
    const slug = args.client;
    if (!slug) {
      console.error("❌ Error: Se requiere --client <slug>");
      return 1;
    }

    const flowDir = join(baseDir, "clients", slug, "workflows");
    const outputPath = args.output ? resolve(baseDir, args.output) : join(baseDir, "clients", slug, `${slug}-flows-bundle.json`);
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
