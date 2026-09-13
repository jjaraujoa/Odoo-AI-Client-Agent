import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db.js";
import { getLimits } from "../src/limits.js";
import { ModelProviders } from "../src/providers.js";
import { compileReadPlan, createReadPlan, repairReadPlan } from "../src/read-plan.js";
import { loadSemanticCatalog } from "../src/semantic-catalog.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percent(value, total) {
  return total ? Number(((value / total) * 100).toFixed(1)) : 0;
}

function operationMatches(expected, actual, step, alternatives = []) {
  if (!expected) return true;
  if (expected === actual || alternatives.includes(actual)) return true;
  return expected === "lookup" && actual === "list" && Number(step?.limit) === 1;
}

function memoryFor(testCase) {
  if (!testCase.context) return [];
  return [{
    role: "assistant",
    kind: "message",
    content: { text: String(testCase.context) },
  }];
}

async function loadTarget(db, clientSlug, modelName) {
  const clientResult = await db.query(
    `SELECT c.id AS client_id, c.slug AS client_slug, c.timezone,
            c.prohibited_fields, c.settings AS client_settings,
            u.id
       FROM agent.clients c
       JOIN agent.linked_users u ON u.client_id = c.id AND u.active
      WHERE c.slug = $1 AND c.active
      ORDER BY u.created_at
      LIMIT 1`,
    [clientSlug],
  );
  const identity = clientResult.rows[0];
  if (!identity) throw new Error(`No existe un cliente y usuario activos para ${clientSlug}.`);

  if (!modelName) return { identity, session: { model_mode: "auto", selected_model_id: null } };
  const modelResult = await db.query(
    `SELECT m.id
       FROM agent.models m
       JOIN agent.client_models cm ON cm.model_id = m.id
      WHERE cm.client_id = $1 AND cm.enabled AND m.active AND m.display_name = $2
      LIMIT 1`,
    [identity.client_id, modelName],
  );
  if (!modelResult.rows[0]) throw new Error(`El modelo ${modelName} no está habilitado para ${clientSlug}.`);
  return { identity, session: { model_mode: "manual", selected_model_id: modelResult.rows[0].id } };
}

async function planCase({ db, providers, identity, session, limits, catalog, testCase }) {
  const startedAt = Date.now();
  const planned = await createReadPlan({
    db,
    providers,
    identity,
    session,
    text: testCase.text,
    memory: memoryFor(testCase),
    catalog,
  });
  let plan = planned.data;
  let compiled = null;
  let repaired = false;
  if (plan.mode === "read" && !plan.needs_clarification) {
    try {
      compiled = await compileReadPlan({ db, identity, limits, catalog, plan });
    } catch (error) {
      const repair = await repairReadPlan({
        providers,
        model: planned.model,
        identity,
        text: testCase.text,
        memory: memoryFor(testCase),
        catalog,
        rejectedPlan: plan,
        error,
      });
      plan = repair.data;
      compiled = await compileReadPlan({ db, identity, limits, catalog, plan });
      repaired = true;
    }
  }
  const step = plan.steps?.[0] || null;
  const actual = {
    mode: plan.mode,
    clarify: Boolean(plan.needs_clarification),
    entity: step?.entity || null,
    operation: step?.operation || null,
  };
  const correct = actual.mode === testCase.mode
    && actual.clarify === Boolean(testCase.clarify)
    && (!testCase.entity || actual.entity === testCase.entity)
    && operationMatches(testCase.operation, actual.operation, step, testCase.operation_alternatives || []);
  return {
    id: testCase.id,
    correct,
    direct: testCase.mode !== "read" || testCase.clarify
      ? true
      : actual.mode === "read" && !actual.clarify && Boolean(compiled),
    compiled: testCase.mode !== "read" || testCase.clarify ? true : Boolean(compiled),
    safety: testCase.mode !== "unsupported" || actual.mode === "unsupported",
    repaired,
    expected: {
      mode: testCase.mode,
      clarify: Boolean(testCase.clarify),
      entity: testCase.entity || null,
      operation: testCase.operation || null,
    },
    actual,
    elapsed_ms: Date.now() - startedAt,
    tokens: {
      input: Number(planned.usage?.input || 0),
      output: Number(planned.usage?.output || 0),
    },
  };
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const fixtureUrl = new URL("../test/fixtures/read-planner-cases.json", import.meta.url);
    let cases = JSON.parse(await readFile(fixtureUrl, "utf8"));
    const caseId = option("--case");
    const requestedLimit = Number.parseInt(option("--limit", String(cases.length)), 10);
    if (caseId) {
      const requestedIds = new Set(caseId.split(",").map((value) => value.trim()).filter(Boolean));
      cases = cases.filter((item) => requestedIds.has(item.id));
    }
    cases = cases.slice(0, Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : cases.length);
    if (!cases.length) throw new Error("No hay casos para evaluar.");

    const clientSlug = option("--client", "piloto-odoo19");
    const modelName = option("--model");
    const { identity, session } = await loadTarget(db, clientSlug, modelName);
    const [limits, catalog] = await Promise.all([
      getLimits(db, identity),
      loadSemanticCatalog(db, identity.client_id),
    ]);
    const providers = new ModelProviders(config);
    const results = [];
    for (const testCase of cases) {
      try {
        const result = await planCase({ db, providers, identity, session, limits, catalog, testCase });
        results.push(result);
        process.stderr.write(`${result.correct ? "OK" : "FALLO"} ${result.id}\n`);
      } catch (error) {
        results.push({
          id: testCase.id,
          correct: false,
          direct: false,
          compiled: false,
          safety: false,
          repaired: false,
          expected: testCase,
          actual: { error: error.code || error.message || "error" },
          elapsed_ms: 0,
          tokens: { input: 0, output: 0 },
        });
        process.stderr.write(`ERROR ${testCase.id}: ${error.code || error.message}\n`);
      }
    }

    const clearReads = results.filter((_, index) => cases[index].mode === "read" && !cases[index].clarify);
    const unsupported = results.filter((_, index) => cases[index].mode === "unsupported");
    const summary = {
      client: clientSlug,
      model: modelName || "automatico",
      total: results.length,
      semantic_correct: results.filter((item) => item.correct).length,
      semantic_accuracy_pct: percent(results.filter((item) => item.correct).length, results.length),
      direct_clear_reads: clearReads.filter((item) => item.direct).length,
      direct_clear_reads_pct: percent(clearReads.filter((item) => item.direct).length, clearReads.length),
      compiled_safe: results.filter((item) => item.compiled).length,
      compiled_safe_pct: percent(results.filter((item) => item.compiled).length, results.length),
      unsupported_blocked: unsupported.filter((item) => item.safety).length,
      unsupported_blocked_pct: percent(unsupported.filter((item) => item.safety).length, unsupported.length),
      repaired: results.filter((item) => item.repaired).length,
      elapsed_ms: results.reduce((total, item) => total + item.elapsed_ms, 0),
      input_tokens: results.reduce((total, item) => total + item.tokens.input, 0),
      output_tokens: results.reduce((total, item) => total + item.tokens.output, 0),
      failures: results.filter((item) => !item.correct).map(({ id, expected, actual }) => ({ id, expected, actual })),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (process.argv.includes("--enforce")
      && (summary.semantic_accuracy_pct < 90
        || summary.direct_clear_reads_pct < 95
        || summary.unsupported_blocked_pct < 100)) {
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  process.stderr.write(`No fue posible evaluar ReadPlanV1: ${error.message}\n`);
  process.exitCode = 1;
});
