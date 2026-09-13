import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  publicOnboardingPreview,
  validateOnboardingPayload,
} from "../src/onboarding.js";
import { encryptSecret } from "../src/crypto.js";

function dbWithoutExistingRows() {
  return {
    async query(sql) {
      if (sql.includes("agent.models")) return { rows: [] };
      return { rows: [] };
    },
  };
}

const config = { credentialMasterKey: randomBytes(32) };

function basePayload() {
  return {
    schema_version: 1,
    package_id: randomUUID(),
    consultant: "fixture",
    client: {
      slug: "demo19",
      name: "Demo",
      odoo_base_url: "https://demo.example.com",
      odoo_database: "demo",
      timezone: "America/Bogota",
      active: false,
    },
    telegram: {},
    users: [],
    configuration: {},
  };
}

test("un usuario parcial inactivo queda como borrador aplicable", async () => {
  const payload = basePayload();
  payload.users.push({
    row_id: "U001",
    active: false,
    odoo_login: "",
    telegram_user_id: "",
    odoo_api_key: "",
  });
  const validation = await validateOnboardingPayload(
    dbWithoutExistingRows(), config, payload,
  );
  assert.equal(validation.valid, true);
  assert.equal(validation.users[0].credential.status, "missing");
  assert.equal(validation.counts.draftUsers, 1);
});

test("un usuario activo incompleto bloquea la aplicación", async () => {
  const payload = basePayload();
  payload.client.active = true;
  payload.users.push({ row_id: "U001", active: true });
  const validation = await validateOnboardingPayload(
    dbWithoutExistingRows(), config, payload,
  );
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("Usuario U001")));
});

test("una API key válida permite derivar login y UID sin exponer el secreto", async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("api.telegram.org")) {
      return new Response(JSON.stringify({
        ok: true,
        result: { id: 123456, username: "demo_bot", first_name: "Demo" },
      }), { status: 200 });
    }
    if (value.endsWith("/res.users/context_get")) {
      return new Response(JSON.stringify({ uid: 91 }), { status: 200 });
    }
    if (value.endsWith("/res.users/read")) {
      return new Response(JSON.stringify([{
        id: 91, login: "derivado@example.com", name: "Derivado",
      }]), { status: 200 });
    }
    throw new Error(`URL inesperada: ${value}`);
  };
  try {
    const payload = basePayload();
    payload.client.active = true;
    payload.telegram = {
      bot_username: "demo_bot",
      bot_token: "123456:abcdefghijklmnopqrstuvwxyz_ABCDE12345",
    };
    payload.users.push({
      row_id: "U001",
      active: true,
      telegram_user_id: "987654321",
      odoo_login: "",
      odoo_api_key: "odoo-api-key-fixture",
    });
    const validation = await validateOnboardingPayload(
      dbWithoutExistingRows(), config, payload,
    );
    assert.equal(validation.valid, true);
    assert.equal(validation.users[0].odooLogin, "derivado@example.com");
    assert.equal(validation.users[0].odooUserId, 91);
    assert.equal(validation.users[0].telegramChatId, 987654321);
    const preview = publicOnboardingPreview(validation, "a".repeat(64));
    const serialized = JSON.stringify(preview);
    assert.doesNotMatch(serialized, /odoo-api-key-fixture/);
    assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz_ABCDE12345/);
    assert.equal(preview.users[0].api_key_last_four, "ture");
    assert.equal(preview.users[0].telegram_chat_id, 987654321);
  } finally {
    global.fetch = previousFetch;
  }
});

test("un Chat ID legado diferente del User ID es rechazado", async () => {
  const payload = basePayload();
  payload.users.push({
    row_id: "U001",
    active: false,
    telegram_user_id: "987654321",
    telegram_chat_id: "-1001234567890",
  });
  const validation = await validateOnboardingPayload(
    dbWithoutExistingRows(), config, payload,
  );
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((message) => message.includes("solo se admiten chats privados")));
});

test("un borrador sin revisar durante más de 30 días muestra advertencia", async () => {
  const encrypted = encryptSecret("odoo-api-key-stored", config.credentialMasterKey);
  const db = {
    async query(sql) {
      if (sql.includes("agent.onboarding_user_drafts")) {
        return {
          rows: [{
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            auth_tag: encrypted.authTag,
            key_version: encrypted.keyVersion,
            credential_status: "valid",
            last_reviewed_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
          }],
        };
      }
      if (sql.includes("agent.models")) return { rows: [] };
      return { rows: [] };
    },
  };
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/res.users/context_get")) {
      return new Response(JSON.stringify({ uid: 17 }), { status: 200 });
    }
    if (value.endsWith("/res.users/read")) {
      return new Response(
        JSON.stringify([{ id: 17, login: "draft@example.com", name: "Draft" }]),
        { status: 200 },
      );
    }
    throw new Error(`URL inesperada: ${value}`);
  };
  try {
    const payload = basePayload();
    payload.users.push({
      row_id: "U001",
      active: false,
      odoo_login: "draft@example.com",
    });
    const validation = await validateOnboardingPayload(db, config, payload);
    const preview = publicOnboardingPreview(validation, "c".repeat(64));
    assert.equal(validation.valid, true);
    assert.equal(preview.users[0].stale_warning, true);
    assert.ok(preview.users[0].last_reviewed_at);
  } finally {
    global.fetch = previousFetch;
  }
});

test("una API key inválida de un borrador no permanece en la validación pública", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ error: { message: "rechazada" } }),
    { status: 401 },
  );
  try {
    const payload = basePayload();
    payload.users.push({
      row_id: "U001",
      active: false,
      odoo_api_key: "api-key-invalida-fixture",
    });
    const validation = await validateOnboardingPayload(
      dbWithoutExistingRows(), config, payload,
    );
    assert.equal(validation.valid, true);
    assert.equal(validation.users[0].credential.status, "invalid");
    assert.equal(validation.users[0].usableApiKey, null);
    assert.doesNotMatch(
      JSON.stringify(publicOnboardingPreview(validation, "b".repeat(64))),
      /api-key-invalida-fixture/,
    );
  } finally {
    global.fetch = previousFetch;
  }
});
