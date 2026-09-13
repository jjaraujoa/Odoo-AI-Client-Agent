import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { encryptNamedSecret } from "../src/crypto.js";
import { registerStoredTelegramWebhook } from "../src/onboarding.js";

test("reintenta el webhook con secretos almacenados sin devolverlos", async () => {
  const previousFetch = global.fetch;
  const masterKey = randomBytes(32);
  const tokenPlain = "123456:abcdefghijklmnopqrstuvwxyz";
  const webhookSecretPlain = "webhook-secret-test";
  const token = encryptNamedSecret(tokenPlain, masterKey, "telegram-bot-token");
  const webhook = encryptNamedSecret(
    webhookSecretPlain,
    masterKey,
    "telegram-webhook-secret",
  );
  const queries = [];
  const db = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      if (sql.includes("FROM agent.clients c")) {
        return { rows: [{
          client_id: 19,
          token_ciphertext: token.ciphertext,
          token_nonce: token.nonce,
          token_auth_tag: token.authTag,
          token_key_version: token.keyVersion,
          webhook_secret_ciphertext: webhook.ciphertext,
          webhook_secret_nonce: webhook.nonce,
          webhook_secret_auth_tag: webhook.authTag,
          webhook_secret_key_version: webhook.keyVersion,
        }] };
      }
      return { rows: [] };
    },
  };
  let telegramRequest;
  global.fetch = async (url, options) => {
    telegramRequest = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
  try {
    const result = await registerStoredTelegramWebhook(db, {
      credentialMasterKey: masterKey,
      n8nWebhookUrl: "https://temporary.trycloudflare.com/",
    }, "Demo19");
    assert.equal(result.registered, true);
    assert.equal(result.client_slug, "demo19");
    assert.equal(
      result.webhook_url,
      "https://temporary.trycloudflare.com/webhook/odoo-ai-telegram",
    );
    assert.ok(telegramRequest.url.includes(tokenPlain));
    assert.equal(telegramRequest.body.secret_token, webhookSecretPlain);
    assert.equal(telegramRequest.body.url, result.webhook_url);
    assert.equal(JSON.stringify(result).includes(tokenPlain), false);
    assert.equal(JSON.stringify(result).includes(webhookSecretPlain), false);
    assert.ok(queries.some(({ sql }) => sql.includes("SET webhook_url = $2")));
    assert.ok(queries.some(({ sql }) => sql.includes("SET webhook_verified_at = now()")));
  } finally {
    global.fetch = previousFetch;
  }
});
