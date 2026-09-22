import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflowYaml, evaluateCondition } from "../src/workflow-parser.js";
import { loadWorkflowsForClient, processEventThroughWorkflows } from "../src/workflow-engine.js";
import { runCli } from "../bin/odoo-agent-cli.js";

test("parseWorkflowYaml parsea correctamente un flujo declarativo válido", () => {
  const yamlStr = `
name: "orden_urgente_a_factura"
description: "Asigna comercial y solicita confirmación"
trigger:
  source: "odoo.base_automation"
  model: "sale.order"
  event: "on_write"
  field: "state"
  condition: "record.state == 'sale' and record.priority == '1'"
actions:
  - step: 1
    action: "odoo.assign_responsible"
    policy: "autonomous"
    params:
      userId: 5
  - step: 2
    action: "odoo.confirm_sale_order"
    policy: "critical"
notifications:
  chatter:
    target: "sale.order"
    template: "Flujo ejecutado para orden {record.name}"
`;

  const parsed = parseWorkflowYaml(yamlStr);
  assert.equal(parsed.name, "orden_urgente_a_factura");
  assert.equal(parsed.trigger.model, "sale.order");
  assert.equal(parsed.trigger.event, "on_write");
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.actions[0].policy, "autonomous");
  assert.equal(parsed.actions[1].policy, "critical");
  assert.ok(parsed.notifications.chatter);
});

test("parseWorkflowYaml rechaza entradas vacías, malformadas o incompletas", () => {
  assert.throws(() => parseWorkflowYaml(""), { code: "invalid_workflow_yaml" });
  assert.throws(() => parseWorkflowYaml("   "), { code: "invalid_workflow_yaml" });
  assert.throws(() => parseWorkflowYaml("not_a_yaml: [unclosed"), { code: "workflow_syntax_error" });
  assert.throws(() => parseWorkflowYaml("description: 'sin nombre'"), { code: "missing_workflow_name" });
  assert.throws(() => parseWorkflowYaml("name: 'test'\nacciones: []"), { code: "missing_workflow_trigger" });
  assert.throws(() => parseWorkflowYaml("name: 'test'\ntrigger: { event: 'on_write' }"), { code: "invalid_trigger_model" });
  assert.throws(() => parseWorkflowYaml("name: 'test'\ntrigger: { model: 'sale.order' }\nactions: []"), { code: "missing_workflow_actions" });
});

test("evaluateCondition evalúa expresiones relacionales y lógicas deterministamente (Zero-Tokens)", () => {
  const context = {
    record: {
      name: "SO-2025-001",
      state: "sale",
      amount_total: 12500000,
      priority: "1",
      is_urgent: true,
      tags: ["vip", "mayorista"],
    },
  };

  // Comparaciones básicas
  assert.equal(evaluateCondition("record.state == 'sale'", context), true);
  assert.equal(evaluateCondition("record.state == 'draft'", context), false);
  assert.equal(evaluateCondition("record.state != 'cancel'", context), true);
  assert.equal(evaluateCondition("record.amount_total > 10000000", context), true);
  assert.equal(evaluateCondition("record.amount_total <= 5000000", context), false);

  // Operador 'in'
  assert.equal(evaluateCondition("'vip' in record.tags", context), true);
  assert.equal(evaluateCondition("'retail' in record.tags", context), false);

  // Operadores lógicos 'and', 'or', 'not'
  assert.equal(
    evaluateCondition("record.state == 'sale' and record.priority == '1'", context),
    true,
  );
  assert.equal(
    evaluateCondition("record.state == 'draft' or record.amount_total > 5000000", context),
    true,
  );
  assert.equal(
    evaluateCondition("not record.state == 'cancel'", context),
    true,
  );
  assert.equal(
    evaluateCondition("record.state == 'sale' and not record.is_urgent == false", context),
    true,
  );

  // Condición vacía evalúa a true
  assert.equal(evaluateCondition("", context), true);
  assert.equal(evaluateCondition(null, context), true);
});

test("processEventThroughWorkflows ejecuta flujos autónomos y retiene acciones críticas", async () => {
  const workflowYaml = `
name: "flujo_aprobacion_pedido"
trigger:
  model: "sale.order"
  event: "on_write"
  condition: "record.state == 'sale' and record.amount_total >= 5000000"
actions:
  - step: 1
    action: "odoo.assign_responsible"
    policy: "autonomous"
    params:
      userId: 5
  - step: 2
    action: "odoo.confirm_sale_order"
    policy: "critical"
notifications:
  chatter:
    template: "Orden procesada exitosamente"
`;

  const client = { id: "client-wf-1", slug: "cliente-prueba", name: "Cliente Prueba" };

  const executedActions = [];
  const mockDb = {
    async query(sql, params) {
      if (sql.includes("agent.tool_policies")) {
        const tool = params?.[1];
        if (tool === "asignar_responsable") {
          return { rows: [{ tool_name: tool, risk_level: 1, confirmation_required: false, enabled: true }] };
        }
        if (tool === "confirmar_orden_venta") {
          return { rows: [{ tool_name: tool, risk_level: 3, confirmation_required: true, enabled: true }] };
        }
        return { rows: [{ tool_name: tool, risk_level: 1, confirmation_required: false, enabled: true }] };
      }
      if (sql.includes("agent.pending_actions")) {
        return { rows: [{ id: "pending-action-uuid-1", confirmation_code: "123456" }] };
      }
      if (sql.includes("agent.action_executions")) {
        return { rows: [{ id: "action-exec-1" }] };
      }
      if (sql.includes("agent.workflow_definitions")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const mockOdoo = {
    async searchRead(model) {
      return [{ id: 801, name: "SO-801", state: "sale", amount_total: 7500000, partner_id: [10, "Empresa ABC"] }];
    },
    async write(model, ids, values) {
      executedActions.push({ type: "write", model, ids, values });
      return true;
    },
    async create(model, values) {
      executedActions.push({ type: "create", model, values });
      return [{ id: 999 }];
    },
    async call(model, method, args) {
      executedActions.push({ type: "call", model, method, args });
      return true;
    },
    async postChatterMessage(model, resId, body) {
      executedActions.push({ type: "chatter", model, resId, body });
      return 1;
    },
  };

  // Usar directorio temporal con el flujo guardado
  const tempDir = await mkdtemp(join(tmpdir(), "odoo-wf-test-"));
  try {
    const flowsDir = join(tempDir, "clients", client.slug, "workflows");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(join(flowsDir, "test-flow.yaml"), workflowYaml, "utf8");

    const event = {
      model: "sale.order",
      res_id: 801,
      event: "on_write",
    };

    const res = await processEventThroughWorkflows({
      db: mockDb,
      config: { credentialMasterKey: Buffer.alloc(32) },
      odoo: mockOdoo,
      client,
      event,
      baseDir: tempDir,
    });

    assert.equal(res.triggered, 1);
    assert.equal(res.executions[0].workflow_name, "flujo_aprobacion_pedido");
    // El paso 1 autónomo se ejecuta, pero el paso 2 crítico requiere confirmación humana (Nivel 3)
    assert.equal(res.executions[0].status, "pending_approval");
    assert.ok(res.executions[0].pending_action_id);
    assert.equal(res.executions[0].steps.length, 3);
    assert.equal(res.executions[0].steps[0].status, "executed");
    assert.equal(res.executions[0].steps[1].status, "awaiting_approval");
    assert.equal(res.executions[0].steps[2].notification, "chatter");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("odoo-agent-cli ejecuta comandos flow new, validate, test y export", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "odoo-cli-test-"));
  try {
    // 1. flow new
    const codeNew = await runCli(["flow", "new", "--client", "demo-cli", "--name", "urgente"], { baseDir: tempDir });
    assert.equal(codeNew, 0);

    const generatedPath = join(tempDir, "clients", "demo-cli", "workflows", "urgente.yaml");
    const content = await readFile(generatedPath, "utf8");
    assert.ok(content.includes("name: \"urgente\""));

    // 2. flow validate
    const codeValidate = await runCli(["flow", "validate", generatedPath], { baseDir: tempDir });
    assert.equal(codeValidate, 0);

    // 3. flow test (simulación)
    const codeTest = await runCli(["flow", "test", generatedPath], { baseDir: tempDir });
    assert.equal(codeTest, 0);

    // 4. flow export
    const codeExport = await runCli(["flow", "export", "--client", "demo-cli"], { baseDir: tempDir });
    assert.equal(codeExport, 0);

    const bundlePath = join(tempDir, "clients", "demo-cli", "demo-cli-flows-bundle.json");
    const bundleContent = JSON.parse(await readFile(bundlePath, "utf8"));
    assert.equal(bundleContent.client_slug, "demo-cli");
    assert.equal(bundleContent.workflows.length, 1);

    // Casos de error controlados en CLI
    const codeMissingArgs = await runCli(["flow", "new"], { baseDir: tempDir });
    assert.equal(codeMissingArgs, 1);

    const codeNonExistent = await runCli(["flow", "validate", "no-existe.yaml"], { baseDir: tempDir });
    assert.equal(codeNonExistent, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
