import {
  constants,
  createDecipheriv,
  createHash,
  privateDecrypt,
} from "node:crypto";
import { AppError } from "./errors.js";

const FORMAT = "odooai";
const VERSION = 1;

function exactBase64(value, field, expectedBytes = undefined) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new AppError(400, "invalid_package", `${field} no es base64 válido.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new AppError(400, "invalid_package", `${field} tiene una longitud inválida.`);
  }
  return decoded;
}

export function packageSha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

export function decryptOnboardingPackage(raw, privateKeyPem) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch {
    throw new AppError(400, "invalid_package", "El archivo .odooai no contiene JSON válido.");
  }
  if (envelope.format !== FORMAT || envelope.version !== VERSION) {
    throw new AppError(400, "unsupported_package", "Formato o versión .odooai no soportado.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(envelope.package_id ?? "")) {
    throw new AppError(400, "invalid_package", "package_id no es válido.");
  }
  if (envelope.content_encryption !== "AES-256-GCM"
      || envelope.key_encryption !== "RSA-3072-OAEP-SHA256") {
    throw new AppError(400, "unsupported_package", "Algoritmos del paquete no soportados.");
  }
  const wrappedKey = exactBase64(envelope.wrapped_key_b64, "wrapped_key_b64", 384);
  const nonce = exactBase64(envelope.nonce_b64, "nonce_b64", 12);
  const tag = exactBase64(envelope.tag_b64, "tag_b64", 16);
  const ciphertext = exactBase64(envelope.ciphertext_b64, "ciphertext_b64");
  let contentKey;
  let plaintext;
  try {
    contentKey = privateDecrypt({
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, wrappedKey);
    if (contentKey.length !== 32) throw new Error("Clave de contenido inválida");
    const decipher = createDecipheriv("aes-256-gcm", contentKey, nonce);
    decipher.setAAD(Buffer.from(`odooai:v1:${envelope.package_id}`, "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new AppError(
      400,
      "package_authentication_failed",
      "El paquete fue alterado o no pertenece a esta instalación.",
    );
  } finally {
    contentKey?.fill(0);
  }
  const payloadHash = createHash("sha256").update(plaintext).digest("hex");
  if (payloadHash !== envelope.payload_sha256) {
    plaintext.fill(0);
    throw new AppError(400, "package_hash_mismatch", "La huella interna del paquete no coincide.");
  }
  let payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new AppError(400, "invalid_package_payload", "El contenido descifrado no es JSON válido.");
  } finally {
    plaintext.fill(0);
  }
  if (payload.package_id !== envelope.package_id || payload.schema_version !== VERSION) {
    throw new AppError(400, "invalid_package_payload", "El contrato interno del paquete no coincide.");
  }
  return { envelope, payload };
}

export const ONBOARDING_PACKAGE_VERSION = VERSION;
