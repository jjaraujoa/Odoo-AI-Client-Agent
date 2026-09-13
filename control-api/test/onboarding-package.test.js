import test from "node:test";
import assert from "node:assert/strict";
import {
  constants,
  createCipheriv,
  createHash,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  decryptOnboardingPackage,
  packageSha256,
} from "../src/onboarding-package.js";
import {
  decryptNamedSecret,
  encryptNamedSecret,
} from "../src/crypto.js";

function createFixture(publicKey, payloadOverrides = {}) {
  const packageId = randomUUID();
  const payload = {
    schema_version: 1,
    package_id: packageId,
    created_at: new Date().toISOString(),
    consultant: "prueba",
    client: { slug: "demo19", active: false },
    telegram: {},
    users: [],
    configuration: {},
    ...payloadOverrides,
  };
  const plaintext = Buffer.from(JSON.stringify(payload));
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`odooai:v1:${packageId}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    format: "odooai",
    version: 1,
    package_id: packageId,
    created_at: new Date().toISOString(),
    key_id: "test",
    key_encryption: "RSA-3072-OAEP-SHA256",
    content_encryption: "AES-256-GCM",
    wrapped_key_b64: publicEncrypt({
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    }, key).toString("base64"),
    nonce_b64: nonce.toString("base64"),
    tag_b64: cipher.getAuthTag().toString("base64"),
    ciphertext_b64: ciphertext.toString("base64"),
    payload_sha256: createHash("sha256").update(plaintext).digest("hex"),
  };
  key.fill(0);
  plaintext.fill(0);
  return Buffer.from(JSON.stringify(envelope));
}

test("un paquete .odooai correcto se autentica y descifra", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const raw = createFixture(publicKey);
  const opened = decryptOnboardingPackage(raw, privateKey);
  assert.equal(opened.payload.client.slug, "demo19");
  assert.match(packageSha256(raw), /^[a-f0-9]{64}$/);
});

test("una clave privada equivocada rechaza el paquete", () => {
  const first = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const second = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const raw = createFixture(first.publicKey);
  assert.throws(
    () => decryptOnboardingPackage(raw, second.privateKey),
    (error) => error.code === "package_authentication_failed",
  );
});

test("un paquete alterado falla la autenticación GCM", () => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const envelope = JSON.parse(createFixture(pair.publicKey).toString("utf8"));
  const ciphertext = Buffer.from(envelope.ciphertext_b64, "base64");
  ciphertext[0] ^= 1;
  envelope.ciphertext_b64 = ciphertext.toString("base64");
  assert.throws(
    () => decryptOnboardingPackage(Buffer.from(JSON.stringify(envelope)), pair.privateKey),
    (error) => error.code === "package_authentication_failed",
  );
});

test("los secretos de canal usan AAD separado", () => {
  const master = randomBytes(32);
  const encrypted = encryptNamedSecret("123:token-prueba-muy-largo", master, "telegram-bot-token");
  const record = {
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag,
    key_version: encrypted.keyVersion,
  };
  assert.equal(
    decryptNamedSecret(record, master, "telegram-bot-token"),
    "123:token-prueba-muy-largo",
  );
  assert.throws(() => decryptNamedSecret(record, master, "odoo-api-key"));
});

