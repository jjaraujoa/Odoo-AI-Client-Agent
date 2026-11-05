<#
.SYNOPSIS
  Conexión rápida de un solo usuario a una base de Odoo, sin carpeta de cliente.

.DESCRIPTION
  agregar : detecta la versión de Odoo, pide la API key en una ventana segura,
            la valida (uid + login), la guarda en Credenciales de Windows y crea
            un perfil SIN secretos en %APPDATA%\OdooAIAgent\conexiones\<nombre>.json.
  listar  : muestra los perfiles y si su credencial existe.
  quitar  : elimina la credencial de Windows y el perfil.

  El MCP se arranca luego con:  node control-api/bin/odoo-mcp.js --conexion <nombre>
  No requiere permisos de administrador.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\control-api\scripts\conectar-odoo.ps1 agregar `
    -Nombre pragmatic-pruebas -Url "https://mi-staging.dev.odoo.com" -Base "mi-staging" `
    -Login "usuario@empresa.com" -PermitirEscritura registrar_horas
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("agregar", "listar", "quitar")]
    [string]$Accion = "listar",
    [string]$Nombre,
    [string]$Url,
    [string]$Base,
    [string]$Login,
    [string[]]$PermitirEscritura = @(),
    [string]$ZonaHoraria = "America/Bogota"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Debe coincidir con LOCAL_WRITE_ALLOWED en control-api/src/mcp-server.js
$EscriturasPermitidas = @("registrar_horas")

$ConexionesRoot = if ($env:ODOO_CONNECTIONS_ROOT) { $env:ODOO_CONNECTIONS_ROOT } else { Join-Path $env:APPDATA "OdooAIAgent\conexiones" }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OdooAgentCredentials {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref NativeCredential credential, int flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, int type, int flags);
    [DllImport("advapi32.dll", EntryPoint = "CredFree")]
    private static extern void CredFree(IntPtr credentialPtr);

    public static void Write(string target, string userName, string secret) {
        byte[] blob = Encoding.UTF8.GetBytes(secret);
        IntPtr ptr = Marshal.AllocHGlobal(blob.Length);
        try {
            Marshal.Copy(blob, 0, ptr, blob.Length);
            NativeCredential c = new NativeCredential();
            c.Type = 1; c.TargetName = target; c.Comment = "OdooAIAgent: API key individual de Odoo";
            c.CredentialBlobSize = blob.Length; c.CredentialBlob = ptr; c.Persist = 2; c.UserName = userName;
            if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Windows no pudo guardar la credencial.");
        } finally {
            Array.Clear(blob, 0, blob.Length);
            for (int i = 0; i < blob.Length; i++) Marshal.WriteByte(ptr, i, 0);
            Marshal.FreeHGlobal(ptr);
        }
    }
    public static bool Exists(string target) {
        IntPtr p;
        if (!CredRead(target, 1, 0, out p)) return false;
        CredFree(p); return true;
    }
    public static void Delete(string target) {
        if (!CredDelete(target, 1, 0)) {
            int e = Marshal.GetLastWin32Error();
            if (e != 1168) throw new System.ComponentModel.Win32Exception(e, "Windows no pudo eliminar la credencial.");
        }
    }
}
"@

function Get-Sha256Hex([string]$text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString("x2") })) }
    finally { $sha.Dispose() }
}

function Assert-Nombre([string]$n) {
    if (-not $n -or $n -notmatch '^[a-z0-9][a-z0-9-]{1,48}$') {
        throw "-Nombre es obligatorio: minúsculas, números y guiones (ej. pragmatic-pruebas)."
    }
}

function Get-PerfilPath([string]$n) { Join-Path $ConexionesRoot "$n.json" }

function Normalize-Url([string]$value) {
    if (-not $value) { throw "-Url es obligatorio." }
    $uri = [Uri]$value.Trim()
    $isLocal = @("localhost", "127.0.0.1", "::1") -contains $uri.Host.ToLowerInvariant()
    if ($uri.Scheme -ne "https" -and -not ($isLocal -and $uri.Scheme -eq "http")) { throw "Odoo debe usar HTTPS (HTTP solo en localhost)." }
    $path = $uri.AbsolutePath.TrimEnd("/")
    if ($path.ToLowerInvariant().EndsWith("/odoo")) { $path = $path.Substring(0, $path.Length - 5).TrimEnd("/") }
    if ($path -eq "/") { $path = "" }
    return $uri.GetLeftPart([UriPartial]::Authority) + $path
}

function Invoke-OdooJson([string]$uri, $body, [hashtable]$headers = @{}) {
    $json = $body | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    try {
        return Invoke-RestMethod -Method Post -Uri $uri -Body $bytes -ContentType "application/json; charset=utf-8" -Headers $headers -TimeoutSec 20 -UserAgent "OdooAIAgent-Conectar/1.0"
    } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        throw "Odoo respondió con error$(if ($status) { " HTTP $status" }) en $([Uri]$uri | ForEach-Object { $_.AbsolutePath })."
    } finally { $json = $null; [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Invoke-LegacyRpc([string]$baseUrl, [string]$service, [string]$method, [object[]]$rpcArgs) {
    $resp = Invoke-OdooJson "$baseUrl/jsonrpc" @{ jsonrpc = "2.0"; method = "call"; id = [guid]::NewGuid().ToString(); params = @{ service = $service; method = $method; args = $rpcArgs } }
    if ($resp.PSObject.Properties.Name -contains "error" -and $resp.error) {
        $msg = if ($resp.error.data -and $resp.error.data.message) { [string]$resp.error.data.message } else { [string]$resp.error.message }
        throw "Odoo RPC: $(($msg -split "`n")[0])"
    }
    return $resp.result
}

function Show-SecretPrompt([string]$title, [string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $label = New-Object System.Windows.Forms.Label
    $input = New-Object System.Windows.Forms.TextBox
    $ok = New-Object System.Windows.Forms.Button
    $cancel = New-Object System.Windows.Forms.Button
    try {
        $form.Text = $title; $form.Width = 540; $form.Height = 190
        $form.StartPosition = "CenterScreen"; $form.FormBorderStyle = "FixedDialog"
        $form.MaximizeBox = $false; $form.MinimizeBox = $false; $form.TopMost = $true
        $label.Left = 16; $label.Top = 14; $label.Width = 490; $label.Height = 40; $label.Text = $message
        $input.Left = 16; $input.Top = 60; $input.Width = 490; $input.UseSystemPasswordChar = $true
        $ok.Text = "Guardar y validar"; $ok.Left = 266; $ok.Top = 98; $ok.Width = 120; $ok.DialogResult = "OK"
        $cancel.Text = "Cancelar"; $cancel.Left = 392; $cancel.Top = 98; $cancel.Width = 114; $cancel.DialogResult = "Cancel"
        $form.Controls.AddRange(@($label, $input, $ok, $cancel))
        $form.AcceptButton = $ok; $form.CancelButton = $cancel
        $form.Add_Shown({ $form.Activate(); $input.Focus() })
        if ($form.ShowDialog() -ne "OK" -or [string]::IsNullOrWhiteSpace($input.Text)) { return $null }
        return $input.Text.Trim()
    } finally {
        $input.Text = ""
        $form.Dispose()
    }
}

function Add-Conexion {
    Assert-Nombre $Nombre
    if (-not $Login) { throw "-Login es obligatorio." }
    $baseUrl = Normalize-Url $Url
    $invalid = @($PermitirEscritura | Where-Object { $EscriturasPermitidas -notcontains $_ })
    if ($invalid.Count) { throw "Escrituras no permitidas: $($invalid -join ', '). Solo: $($EscriturasPermitidas -join ', ')." }

    # 1. Detectar versión y transporte
    $info = Invoke-OdooJson "$baseUrl/web/webclient/version_info" @{ jsonrpc = "2.0"; method = "call"; params = @{}; id = 1 }
    $serverVersion = [string]$info.result.server_version
    $series = if ($serverVersion -match '^(1[4-9]|20)(\.|$)') { "$($Matches[1]).0" } else { "" }
    $transport = if (@("19.0", "20.0") -contains $series) { "json2" } elseif ($series) { "legacy_rpc" } else { throw "Versión de Odoo no soportada: '$serverVersion' (14 a 20)." }
    if ($transport -eq "legacy_rpc" -and -not $Base) { throw "Odoo $series usa RPC heredado: indica -Base con el nombre técnico de la base." }

    # 2. API key en ventana segura (nunca por consola ni argumentos)
    $secret = Show-SecretPrompt "Odoo AI Agent — $Nombre" "API key de Odoo para $Login en $baseUrl. No se mostrará ni se guardará en archivos."
    if (-not $secret) { throw "Cancelado: no se guardó ninguna credencial." }

    try {
        # 3. Validar identidad
        if ($transport -eq "legacy_rpc") {
            $uid = Invoke-LegacyRpc $baseUrl "common" "authenticate" @($Base, $Login, $secret, @{})
            if (-not $uid -or [int64]$uid -le 0) { throw "Odoo rechazó el login, la API key o el nombre de la base." }
            $users = Invoke-LegacyRpc $baseUrl "object" "execute_kw" @($Base, [int64]$uid, $secret, "res.users", "read", @(, @([int64]$uid)), @{ fields = @("login", "name") })
        } else {
            $headers = @{ Authorization = "bearer $secret" }
            if ($Base) { $headers["X-Odoo-Database"] = $Base }
            $ctx = Invoke-OdooJson "$baseUrl/json/2/res.users/context_get" @{} $headers
            $uid = [int64]$ctx.uid
            if ($uid -le 0) { throw "Odoo no devolvió el uid del usuario." }
            $users = Invoke-OdooJson "$baseUrl/json/2/res.users/read" @{ ids = @($uid); fields = @("login", "name") } $headers
        }
        $user = @($users)[0]
        if (-not $user) { throw "Odoo no devolvió el usuario autenticado." }
        if (([string]$user.login).ToLowerInvariant() -ne $Login.Trim().ToLowerInvariant()) { throw "La API key pertenece a otro login de Odoo." }

        # 4. Guardar credencial y perfil (sin secretos)
        $target = "OdooAIAgent/$Nombre/" + (Get-Sha256Hex $Login.ToLowerInvariant()).Substring(0, 16)
        [OdooAgentCredentials]::Write($target, $Login, $secret)
        $fingerprint = (Get-Sha256Hex $secret).Substring(0, 16)
    } finally {
        $secret = $null
    }

    $perfil = [ordered]@{
        schema_version   = 1
        nombre           = $Nombre
        odoo_base_url    = $baseUrl
        odoo_database    = if ($Base) { $Base.Trim() } else { $null }
        login            = $user.login
        uid              = [int64]$uid
        user_name        = [string]$user.name
        server_version   = $serverVersion
        server_series    = $series
        api_transport    = $transport
        credential_target = $target
        credential_fingerprint = $fingerprint
        local_write_tools = @($PermitirEscritura)
        timezone         = $ZonaHoraria
        verified_at      = (Get-Date).ToUniversalTime().ToString("o")
    }
    New-Item -ItemType Directory -Force -Path $ConexionesRoot | Out-Null
    $path = Get-PerfilPath $Nombre
    [IO.File]::WriteAllText($path, ($perfil | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))

    [ordered]@{
        verificado    = $true
        nombre        = $Nombre
        usuario       = "$($perfil.user_name) <$($perfil.login)> (uid $($perfil.uid))"
        odoo          = "$serverVersion ($transport)"
        escrituras    = if ($PermitirEscritura.Count) { $PermitirEscritura -join ", " } else { "ninguna (solo lectura)" }
        perfil        = $path
        mcp           = "node control-api/bin/odoo-mcp.js --conexion $Nombre"
    } | ConvertTo-Json
}

function Get-Conexiones {
    if (-not (Test-Path $ConexionesRoot)) { Write-Output "[]"; return }
    $rows = Get-ChildItem -Path $ConexionesRoot -Filter *.json | ForEach-Object {
        $p = Get-Content -Raw -Encoding UTF8 $_.FullName | ConvertFrom-Json
        [ordered]@{
            nombre = $p.nombre; url = $p.odoo_base_url; base = $p.odoo_database; login = $p.login
            odoo = $p.server_version; escrituras = @($p.local_write_tools) -join ", "
            credencial = [OdooAgentCredentials]::Exists([string]$p.credential_target)
        }
    }
    ConvertTo-Json -InputObject @($rows) -Depth 3
}

function Remove-Conexion {
    Assert-Nombre $Nombre
    $path = Get-PerfilPath $Nombre
    if (-not (Test-Path $path)) { throw "No existe la conexión '$Nombre'." }
    $p = Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json
    [OdooAgentCredentials]::Delete([string]$p.credential_target)
    Remove-Item -LiteralPath $path -Force
    "Conexión '$Nombre' eliminada (credencial de Windows revocada)."
}

try {
    switch ($Accion) {
        "agregar" { Add-Conexion }
        "listar"  { Get-Conexiones }
        "quitar"  { Remove-Conexion }
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
