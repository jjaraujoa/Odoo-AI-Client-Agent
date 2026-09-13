import { AppError } from "./errors.js";
import { executeReadPlan, summarizeReadExecutionForMemory } from "./read-executor.js";
import {
  compileReadPlan,
  createReadPlan,
  publicCompiledPlan,
  repairReadPlan,
} from "./read-plan.js";
import { synthesizeReadResponse } from "./read-response.js";
import { loadSemanticCatalog } from "./semantic-catalog.js";

function repairable(error) {
  return error instanceof AppError
    && (error.code === "invalid_read_plan"
      || error.code === "semantic_entity_disabled"
      || String(error.code).startsWith("read_plan_"));
}

async function planAndCompile({ db, providers, identity, session, limits, text, memory }) {
  const catalog = await loadSemanticCatalog(db, identity.client_id);
  const planned = await createReadPlan({ db, providers, identity, session, text, memory, catalog });
  if (planned.data.mode === "help" || planned.data.mode === "unsupported" || planned.data.needs_clarification) {
    return { catalog, planned, compiled: null, repairUsage: null, repaired: false };
  }
  try {
    const compiled = await compileReadPlan({ db, identity, limits, catalog, plan: planned.data });
    return { catalog, planned, compiled, repairUsage: null, repaired: false };
  } catch (error) {
    if (!repairable(error)) throw error;
    const repaired = await repairReadPlan({
      providers,
      model: planned.model,
      identity,
      text,
      memory,
      catalog,
      rejectedPlan: planned.data,
      error,
    });
    const compiled = await compileReadPlan({ db, identity, limits, catalog, plan: repaired.data });
    return {
      catalog,
      planned: { ...planned, data: repaired.data },
      compiled,
      repairUsage: repaired.usage,
      repaired: true,
    };
  }
}

export async function handleSemanticRead({ db, providers, identity, session, limits, odoo, text, memory }) {
  const state = await planAndCompile({ db, providers, identity, session, limits, text, memory });
  const plan = state.planned.data;
  if (plan.needs_clarification) {
    return {
      kind: "clarification",
      text: plan.clarification || "Necesito una precisión para distinguir la información que deseas consultar.",
      model: state.planned.model,
      usage: state.planned.usage,
      planHash: null,
      repaired: state.repaired,
    };
  }
  if (plan.mode === "help") {
    return { kind: "help", model: state.planned.model, usage: state.planned.usage, planHash: null };
  }
  if (plan.mode === "unsupported") {
    throw new AppError(
      400,
      "unsupported_request",
      "Esa solicitud no corresponde a una lectura autorizada. Las escrituras permanecen en un flujo separado con confirmación explícita.",
    );
  }
  const execution = await executeReadPlan({ db, odoo, identity, limits, compiled: state.compiled });
  const response = await synthesizeReadResponse({
    providers,
    model: state.planned.model,
    question: text,
    compiled: state.compiled,
    execution,
    plannerUsage: state.planned.usage,
    repairUsage: state.repairUsage,
  });
  const records = execution.steps.flatMap((step) => step.records || []);
  return {
    kind: "read",
    text: response.text,
    model: state.planned.model,
    usage: response.usage,
    planHash: state.compiled.hash,
    compiledPlan: publicCompiledPlan(state.compiled),
    memorySummary: summarizeReadExecutionForMemory(state.compiled, execution),
    execution,
    recordIds: records.map((record) => record.id),
    entityKeys: [...new Set(execution.steps.map((step) => step.entity))],
    repaired: state.repaired,
    retryUsed: execution.retry_used,
    synthesized: response.synthesized,
  };
}

export async function planSemanticReadShadow({ db, providers, identity, session, limits, text, memory }) {
  try {
    const state = await planAndCompile({ db, providers, identity, session, limits, text, memory });
    return {
      status: state.compiled ? "compiled" : state.planned.data.needs_clarification ? "clarification" : state.planned.data.mode,
      planHash: state.compiled?.hash || null,
      entities: state.compiled?.steps.map((step) => step.entity.key) || [],
      repaired: state.repaired,
      usage: state.planned.usage,
    };
  } catch (error) {
    return { status: "error", errorCode: error.code || "internal_error", planHash: null, entities: [], repaired: false };
  }
}
