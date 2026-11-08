import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { AppError } from "./errors.js";

// Conexión rápida de un solo usuario (sin carpeta de cliente):
// - Perfil SIN secretos en %APPDATA%\OdooAIAgent\conexiones\<nombre>.json (lo crea scripts/conectar-odoo.ps1).
// - API key en Credenciales de Windows (target OdooAIAgent/<nombre>/<hash-login>).

const NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,48}$/;
const TRANSPORTS = new Set(["legacy_rpc", "json2"]);

export function connectionsRoot(env = process.env) {
  if (env.ODOO_CONNECTIONS_ROOT) return env.ODOO_CONNECTIONS_ROOT;
  if (!env.APPDATA) {
    throw new AppError(500, "appdata_missing", "No se encontró %APPDATA%; define ODOO_CONNECTIONS_ROOT.");
  }
  return join(env.APPDATA, "OdooAIAgent", "conexiones");
}

export function assertConnectionName(name) {
  if (typeof name !== "string" || !NAME_REGEX.test(name)) {
    throw new AppError(400, "invalid_connection_name", "Nombre de conexión inválido (minúsculas, números y guiones).");
  }
  return name;
}

export function validateConnectionProfile(profile, name) {
  const fail = (msg) => {
    throw new AppError(400, "invalid_connection_profile", `Perfil '${name}' inválido: ${msg}. Vuelve a ejecutar conectar-odoo.ps1 agregar.`);
  };
  if (!profile || typeof profile !== "object") fail("no es un objeto JSON");
  if (profile.schema_version !== 1) fail("schema_version no soportada");
  if (profile.nombre !== name) fail("el nombre no coincide con el archivo");
  if (typeof profile.odoo_base_url !== "string" || !profile.odoo_base_url) fail("falta odoo_base_url");
  if (!TRANSPORTS.has(profile.api_transport)) fail("api_transport debe ser legacy_rpc o json2");
  if (profile.api_transport === "legacy_rpc" && !profile.odoo_database) fail("falta odoo_database (requerida en Odoo 14–18)");
  if (typeof profile.login !== "string" || !profile.login) fail("falta login");
  if (typeof profile.credential_target !== "string" || !profile.credential_target.startsWith(`OdooAIAgent/${name}/`)) {
    fail("credential_target no pertenece a esta conexión");
  }
  if (profile.local_write_tools !== undefined && !Array.isArray(profile.local_write_tools)) fail("local_write_tools debe ser una lista");
  if (profile.registro_horas !== undefined && profile.registro_horas !== null &&
      (typeof profile.registro_horas !== "object" || Array.isArray(profile.registro_horas))) {
    fail("registro_horas debe ser un objeto");
  }
  return profile;
}

export async function loadConnectionProfile(name, { root = connectionsRoot() } = {}) {
  assertConnectionName(name);
  const path = join(root, `${name}.json`);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new AppError(404, "connection_not_found", `No existe la conexión '${name}' (${path}). Créala con conectar-odoo.ps1 agregar.`);
  }
  let profile;
  try {
    profile = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    throw new AppError(400, "invalid_connection_profile", `El perfil '${name}' no es JSON válido.`);
  }
  return { profile: validateConnectionProfile(profile, name), dir: join(root, name) };
}

// Lee el blob con CredReadW vía PowerShell y lo devuelve en base64 (el target va por variable de entorno).
const READ_CREDENTIAL_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OdooAgentCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct C { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize;
    public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, int type, int flags, out IntPtr p);
  [DllImport("advapi32.dll", EntryPoint = "CredFree")] private static extern void CredFree(IntPtr p);
  public static string ReadBase64(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return null; throw new System.ComponentModel.Win32Exception(e); }
    try { C c = (C)Marshal.PtrToStructure(p, typeof(C)); byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length); try { return Convert.ToBase64String(b); } finally { Array.Clear(b, 0, b.Length); } }
    finally { CredFree(p); }
  }
}
'@
$v = [OdooAgentCredRead]::ReadBase64($env:ODOO_AGENT_CRED_TARGET)
if ($null -eq $v) { exit 3 }
[Console]::Out.Write($v)
`;

function defaultRunner(target) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", READ_CREDENTIAL_PS],
      { env: { ...process.env, ODOO_AGENT_CRED_TARGET: target }, timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || "") }),
    );
  });
}

export function decodeCredentialBlob(base64) {
  const blob = Buffer.from(String(base64).trim(), "base64");
  try {
    const text = blob.length >= 2 && blob[1] === 0 ? blob.toString("utf16le") : blob.toString("utf8");
    return text.replace(/\0/g, "").trim();
  } finally {
    blob.fill(0);
  }
}

export async function readWindowsCredential(target, { runner = defaultRunner, platform = process.platform } = {}) {
  if (platform !== "win32") {
    throw new AppError(501, "windows_only", "Las Credenciales de Windows solo están disponibles en Windows.");
  }
  const { code, stdout } = await runner(target);
  if (code === 3) {
    throw new AppError(404, "credential_not_found", "La credencial no existe en Credenciales de Windows. Ejecuta conectar-odoo.ps1 agregar.");
  }
  if (code !== 0 || !stdout.trim()) {
    throw new AppError(500, "credential_read_failed", "No se pudo leer la credencial de Windows.");
  }
  const secret = decodeCredentialBlob(stdout);
  if (!secret) throw new AppError(500, "credential_empty", "La credencial de Windows está vacía.");
  return secret;
}
