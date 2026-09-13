import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

test("todos los workflows de n8n son JSON importable básico", async () => {
  const directory = join(root, "n8n", "workflows");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const workflow = JSON.parse(await readFile(join(directory, file), "utf8"));
    assert.equal(typeof workflow.name, "string");
    assert.ok(Array.isArray(workflow.nodes) && workflow.nodes.length > 0);
    assert.equal(typeof workflow.connections, "object");
    assert.equal(workflow.active, false);
  }
});

test("los IDs de modelos proporcionados quedan pendientes y desactivados", async () => {
  const sql = await readFile(join(root, "db", "migrations", "002_seed_models.sql"), "utf8");
  for (const model of [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.4-nano-2026-03-17",
  ]) {
    assert.match(sql, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(sql, /false,\s*'pending'/);
  assert.match(sql, /must_validate_before_activation/);
});

test("no hay secretos reales en los artefactos versionables", async () => {
  const env = await readFile(join(root, ".env.example"), "utf8");
  assert.match(env, /OPENAI_API_KEY=\s*$/m);
  assert.match(env, /ANTHROPIC_API_KEY=\s*$/m);
  assert.doesNotMatch(env, /^TELEGRAM_BOT_TOKEN=/m);
  assert.doesNotMatch(env, /\bsk-[A-Za-z0-9_-]{20,}/);
});
