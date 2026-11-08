import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Auditoría de escrituras en modo carpeta local: una línea JSON por evento en
// <carpeta-cliente>/auditoria/acciones.jsonl. Nunca incluye secretos.

const SECRET_KEY_PATTERN = /(api[_-]?key|password|secret|token(?!_id)|authorization)/i;

function stripSecrets(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    out[key] = stripSecrets(val, depth + 1);
  }
  return out;
}

export function createJsonlAuditor(clientDir, { now = () => new Date() } = {}) {
  const dir = join(clientDir, "auditoria");
  const file = join(dir, "acciones.jsonl");
  let ready = null;
  return {
    file,
    async record(event) {
      ready ??= mkdir(dir, { recursive: true });
      await ready;
      const entry = { ts: now().toISOString(), ...stripSecrets(event) };
      await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    },
  };
}
