import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  constantTimeKeyMatches,
  decryptSecret,
  encryptSecret,
  redactSecret,
} from "../src/crypto.js";

test("AES-256-GCM cifra y descifra una API key", () => {
  const master = randomBytes(32);
  const encrypted = encryptSecret("odoo-api-key-super-secreta", master);
  const decrypted = decryptSecret({
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag,
    key_version: encrypted.keyVersion,
  }, master);
  assert.equal(decrypted, "odoo-api-key-super-secreta");
  assert.equal(encrypted.nonce.length, 12);
  assert.equal(encrypted.authTag.length, 16);
  assert.equal(encrypted.lastFour, "reta");
});

test("AES-256-GCM rechaza ciphertext alterado", () => {
  const master = randomBytes(32);
  const encrypted = encryptSecret("secreto", master);
  encrypted.ciphertext[0] ^= 1;
  assert.throws(() => decryptSecret({
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag,
    key_version: encrypted.keyVersion,
  }, master));
});

test("redactSecret oculta secretos cortos y enmascara secretos largos", () => {
  assert.equal(redactSecret(""), "");
  assert.equal(redactSecret(null), "");
  assert.equal(redactSecret("123456"), "••••");
  assert.equal(redactSecret("1234567"), "••••");
  assert.equal(redactSecret("12345678"), "12…5678");
  assert.equal(redactSecret("super-secreto-odoo-19"), "su…o-19");
});

test("constantTimeKeyMatches valida coincidencias seguras en tiempo constante", () => {
  assert.equal(constantTimeKeyMatches("token-secreto-123", "token-secreto-123"), true);
  assert.equal(constantTimeKeyMatches("token-secreto-123", "token-secreto-456"), false);
  assert.equal(constantTimeKeyMatches("", "algo"), false);
  assert.equal(constantTimeKeyMatches(null, "algo"), false);
});

