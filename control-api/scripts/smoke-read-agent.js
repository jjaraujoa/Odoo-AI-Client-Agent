import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { resolveIdentity } from "../src/identity.js";
import { getLimits } from "../src/limits.js";
import { OdooJson2Client } from "../src/odoo.js";
import { ModelProviders } from "../src/providers.js";
import { handleSemanticRead } from "../src/read-agent.js";
import { executeReadPlan } from "../src/read-executor.js";
import { compileReadPlan } from "../src/read-plan.js";
import { loadSemanticCatalog } from "../src/semantic-catalog.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  let identity;
  try {
    const clientSlug = option("--client", "piloto-odoo19");
    const question = option("--query", "Dime todas las facturas de cliente publicadas");
    const modelName = option("--model");
    const target = await db.query(
      `SELECT c.id AS client_id, u.telegram_user_id
         FROM agent.clients c
         JOIN agent.linked_users u ON u.client_id = c.id AND u.active
        WHERE c.slug = $1 AND c.active
        ORDER BY u.created_at
        LIMIT 1`,
      [clientSlug],
    );
    if (!target.rows[0]) throw new Error(`No existe un cliente y usuario activos para ${clientSlug}.`);
    const telegramUserId = Number(target.rows[0].telegram_user_id);
    identity = await resolveIdentity(
      db,
      telegramUserId,
      telegramUserId,
      config.credentialMasterKey,
      target.rows[0].client_id,
    );
    const limits = await getLimits(db, identity);
    const session = { model_mode: "auto", selected_model_id: null };
    if (modelName) {
      const model = await db.query(
        `SELECT m.id
           FROM agent.models m
           JOIN agent.client_models cm ON cm.model_id = m.id
          WHERE cm.client_id = $1 AND cm.enabled AND m.active AND m.display_name = $2
          LIMIT 1`,
        [identity.client_id, modelName],
      );
      if (!model.rows[0]) throw new Error(`El modelo ${modelName} no está habilitado para ${clientSlug}.`);
      session.model_mode = "manual";
      session.selected_model_id = model.rows[0].id;
    }
    const odoo = new OdooJson2Client({
      baseUrl: identity.odoo_base_url,
      database: identity.odoo_database,
      apiKey: identity.odooApiKey,
      timeoutMs: Number(limits.request_timeout_seconds) * 1000,
    });
    if (process.argv.includes("--local-executor-only")) {
      const catalog = await loadSemanticCatalog(db, identity.client_id);
      const compiled = await compileReadPlan({
        db,
        identity,
        limits,
        catalog,
        plan: {
          version: "1",
          objective: "Comprobar localmente el ejecutor de facturas publicadas sin exponer registros.",
          mode: "read",
          confidence: 1,
          steps: [{
            id: "facturas",
            entity: "facturas_cliente",
            operation: "list",
            fields: ["numero"],
            filters: [{
              field: "estado",
              operator: "equals",
              value: "publicada",
              values: [],
              source_step: null,
              source_field: null,
            }],
            filter_logic: "all",
            sort: [{ field: "fecha", direction: "desc" }],
            limit: 1,
            aggregate: { function: "none", field: null },
            group_by: [],
          }],
          assumptions: [],
          needs_clarification: false,
          clarification: null,
          response: { format: "concise", focus: "diagnóstico local" },
        },
      });
      const execution = await executeReadPlan({ db, odoo, identity, limits, compiled });
      const firstStep = execution.steps[0];
      process.stdout.write(`${JSON.stringify({
        kind: "local_executor_smoke",
        compiled: true,
        odoo_call_ok: ["ok", "not_found", "truncated"].includes(firstStep.status),
        status: firstStep.status,
        records_redacted: true,
        plan_hash_prefix: compiled.hash.slice(0, 12),
      }, null, 2)}\n`);
      return;
    }
    const result = await handleSemanticRead({
      db,
      providers: new ModelProviders(config),
      identity,
      session,
      limits,
      odoo,
      text: question,
      memory: [],
    });
    process.stdout.write(`${JSON.stringify({
      kind: result.kind,
      answer: result.text,
      entities: result.entityKeys || [],
      plan_hash_prefix: result.planHash?.slice(0, 12) || null,
      repaired: Boolean(result.repaired),
      retry_used: Boolean(result.retryUsed),
      grounded_response: Boolean(result.synthesized),
    }, null, 2)}\n`);
  } finally {
    if (identity) identity.odooApiKey = undefined;
    await db.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Falló la lectura semántica de diagnóstico: ${error.code || error.message}\n`);
  process.exitCode = 1;
});
