import { readFile } from "node:fs/promises";
import { createDb } from "./db.js";
import { loadConfig } from "./config.js";
import { safeError } from "./errors.js";
import {
  decryptOnboardingPackage,
  packageSha256,
} from "./onboarding-package.js";
import {
  applyOnboardingPackage,
  publicOnboardingPreview,
  validateOnboardingPayload,
} from "./onboarding.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const action = process.argv[2];
const packagePath = argument("--package");
const privateKeyPath = argument("--private-key");
const expectedHash = argument("--expected-hash");
if (!["preview", "apply"].includes(action) || !packagePath || !privateKeyPath) {
  process.stderr.write(
    "Uso: node onboarding-cli.js <preview|apply> --package <archivo> --private-key <pem> [--expected-hash <sha256>]\n",
  );
  process.exit(2);
}

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const [raw, privateKey] = await Promise.all([
    readFile(packagePath),
    readFile(privateKeyPath, "utf8"),
  ]);
  if (raw.length > 10 * 1024 * 1024) throw new Error("El paquete supera 10 MiB.");
  const hash = packageSha256(raw);
  if (action === "apply" && expectedHash !== hash) {
    throw new Error("La huella del paquete cambió después de la vista previa.");
  }
  const { payload } = decryptOnboardingPackage(raw, privateKey);
  const validation = await validateOnboardingPayload(db, config, payload);
  const preview = publicOnboardingPreview(validation, hash);
  if (action === "preview") {
    process.stdout.write(`${JSON.stringify(preview)}\n`);
  } else {
    const result = await applyOnboardingPackage(db, config, validation, hash);
    process.stdout.write(`${JSON.stringify({ ...result, preview })}\n`);
  }
} catch (error) {
  const safe = safeError(error);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: safe.body.error,
    message: safe.body.message,
    details: safe.body.details,
  })}\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}

