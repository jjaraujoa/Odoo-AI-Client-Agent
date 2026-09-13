import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../src/crypto.js";

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

