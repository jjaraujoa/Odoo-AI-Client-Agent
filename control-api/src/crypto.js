import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function encryptNamedSecret(plaintext, masterKey, purpose, keyVersion = 1) {
  if (!plaintext || typeof plaintext !== "string") throw new Error("Secreto vacío");
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error("La clave maestra debe tener 32 bytes");
  }
  if (!/^[a-z0-9-]{3,64}$/.test(purpose)) throw new Error("Propósito de cifrado inválido");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(Buffer.from(`${purpose}:v${keyVersion}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    keyVersion,
    fingerprint: createHash("sha256").update(plaintext).digest("hex"),
    lastFour: plaintext.slice(-4),
  };
}

export function decryptNamedSecret(record, masterKey, purpose) {
  const decipher = createDecipheriv("aes-256-gcm", masterKey, record.nonce);
  decipher.setAAD(Buffer.from(`${purpose}:v${record.key_version}`, "utf8"));
  decipher.setAuthTag(record.auth_tag);
  return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
}

export function encryptSecret(plaintext, masterKey, keyVersion = 1) {
  return encryptNamedSecret(plaintext, masterKey, "odoo-api-key", keyVersion);
}

export function decryptSecret(record, masterKey) {
  return decryptNamedSecret(record, masterKey, "odoo-api-key");
}

export function constantTimeKeyMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function redactSecret(value) {
  const str = String(value || "");
  if (!str) return "";
  if (str.length < 8) return "••••";
  return `${str.slice(0, 2)}…${str.slice(-4)}`;
}
