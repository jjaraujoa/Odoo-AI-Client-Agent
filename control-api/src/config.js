function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable requerida ${name}`);
  return value;
}

function positiveInt(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un entero positivo`);
  }
  return value;
}

export function loadConfig() {
  const masterKey = Buffer.from(required("ODOO_CREDENTIAL_MASTER_KEY_B64"), "base64");
  if (masterKey.length !== 32) {
    throw new Error("ODOO_CREDENTIAL_MASTER_KEY_B64 debe decodificar exactamente 32 bytes");
  }
  return Object.freeze({
    port: positiveInt("PORT", 8080),
    databaseUrl: required("DATABASE_URL"),
    internalKey: required("CONTROL_API_INTERNAL_KEY"),
    adminKey: required("CONTROL_API_ADMIN_KEY"),
    credentialMasterKey: masterKey,
    n8nWebhookUrl: process.env.N8N_WEBHOOK_URL ?? process.env.WEBHOOK_URL ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    maxDocumentBytes: positiveInt("MAX_DOCUMENT_BYTES", 5 * 1024 * 1024),
    maxDocumentPages: positiveInt("MAX_DOCUMENT_PAGES", 10),
    clamavSocket: process.env.CLAMAV_SOCKET ?? "",
    clamavHost: process.env.CLAMAV_HOST ?? "clamav",
    clamavPort: positiveInt("CLAMAV_PORT", 3310),
    clamavRequired: process.env.CLAMAV_REQUIRED !== "false",
  });
}
