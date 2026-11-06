import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionsRoot,
  decodeCredentialBlob,
  loadConnectionProfile,
  readWindowsCredential,
} from "../src/connection-profiles.js";

const PROFILE = {
  schema_version: 1,
  nombre: "acme-pruebas",
  odoo_base_url: "https://staging.example.com",
  odoo_database: "staging-db",
  login: "usuario@example.com",
  uid: 7,
  server_version: "18.0+e",
  api_transport: "legacy_rpc",
  credential_target: "OdooAIAgent/acme-pruebas/0123456789abcdef",
  local_write_tools: ["registrar_horas"],
  timezone: "Etc/GMT+5",
};

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "odoo-conn-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("connectionsRoot usa ODOO_CONNECTIONS_ROOT o %APPDATA%\\OdooAIAgent\\conexiones", () => {
  assert.equal(connectionsRoot({ ODOO_CONNECTIONS_ROOT: "X:/c" }), "X:/c");
  assert.equal(connectionsRoot({ APPDATA: "C:/AppData" }), join("C:/AppData", "OdooAIAgent", "conexiones"));
  assert.throws(() => connectionsRoot({}), /APPDATA/);
});

test("loadConnectionProfile carga un perfil válido (con BOM) y devuelve la carpeta de auditoría", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "acme-pruebas.json"), `\uFEFF${JSON.stringify(PROFILE)}`, "utf8");
    const { profile, dir } = await loadConnectionProfile("acme-pruebas", { root });
    assert.equal(profile.login, "usuario@example.com");
    assert.equal(dir, join(root, "acme-pruebas"));
  });
});

test("loadConnectionProfile rechaza nombres inválidos, perfiles inexistentes e incoherentes", async () => {
  await withRoot(async (root) => {
    await assert.rejects(loadConnectionProfile("../otro", { root }), /inválido/);
    await assert.rejects(loadConnectionProfile("no-existe", { root }), /No existe la conexión/);

    const cases = [
      [{ ...PROFILE, credential_target: "OdooAIAgent/otra/abc" }, /credential_target/],
      [{ ...PROFILE, odoo_database: null }, /odoo_database/],
      [{ ...PROFILE, api_transport: "xmlrpc" }, /api_transport/],
      [{ ...PROFILE, nombre: "otra" }, /nombre/],
      [{ ...PROFILE, local_write_tools: "registrar_horas" }, /local_write_tools/],
    ];
    for (const [bad, pattern] of cases) {
      await writeFile(join(root, "acme-pruebas.json"), JSON.stringify(bad), "utf8");
      await assert.rejects(loadConnectionProfile("acme-pruebas", { root }), pattern);
    }
    // JSON-2 no exige base de datos
    await writeFile(join(root, "acme-pruebas.json"), JSON.stringify({ ...PROFILE, api_transport: "json2", odoo_database: null }), "utf8");
    assert.equal((await loadConnectionProfile("acme-pruebas", { root })).profile.api_transport, "json2");
  });
});

test("decodeCredentialBlob admite UTF-8 y UTF-16LE", () => {
  assert.equal(decodeCredentialBlob(Buffer.from("clave-utf8", "utf8").toString("base64")), "clave-utf8");
  assert.equal(decodeCredentialBlob(Buffer.from("clave-utf16", "utf16le").toString("base64")), "clave-utf16");
});

test("readWindowsCredential pasa el target al runner y traduce los errores", async () => {
  let seen = null;
  const ok = async (target) => {
    seen = target;
    return { code: 0, stdout: Buffer.from("secreto", "utf8").toString("base64") };
  };
  assert.equal(await readWindowsCredential("OdooAIAgent/x/1", { runner: ok, platform: "win32" }), "secreto");
  assert.equal(seen, "OdooAIAgent/x/1");

  await assert.rejects(readWindowsCredential("t", { runner: async () => ({ code: 3, stdout: "" }), platform: "win32" }), /no existe/);
  await assert.rejects(readWindowsCredential("t", { runner: async () => ({ code: 1, stdout: "" }), platform: "win32" }), /No se pudo leer/);
  await assert.rejects(readWindowsCredential("t", { runner: ok, platform: "linux" }), /solo están disponibles en Windows/);
});
