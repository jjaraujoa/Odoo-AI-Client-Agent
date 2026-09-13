[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$examplePath = Join-Path $projectRoot ".env.example"
$envPath = Join-Path $projectRoot ".env"

if (Test-Path -LiteralPath $envPath) {
    throw "Ya existe .env. No se sobrescribió para proteger sus secretos."
}

function New-RandomBase64([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buffer)
}

function New-RandomHex([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return (($buffer | ForEach-Object { $_.ToString("x2") }) -join "")
}

$content = Get-Content -LiteralPath $examplePath -Raw
$content = $content -replace "POSTGRES_PASSWORD=CAMBIAR_CON_SCRIPT", ("POSTGRES_PASSWORD=" + (New-RandomHex 24))
$content = $content -replace "N8N_ENCRYPTION_KEY=CAMBIAR_CON_SCRIPT", ("N8N_ENCRYPTION_KEY=" + (New-RandomBase64 32))
$content = $content -replace "CONTROL_API_INTERNAL_KEY=CAMBIAR_CON_SCRIPT", ("CONTROL_API_INTERNAL_KEY=" + (New-RandomBase64 32))
$content = $content -replace "CONTROL_API_ADMIN_KEY=CAMBIAR_CON_SCRIPT", ("CONTROL_API_ADMIN_KEY=" + (New-RandomBase64 32))
$content = $content -replace "ODOO_CREDENTIAL_MASTER_KEY_B64=CAMBIAR_CON_SCRIPT", ("ODOO_CREDENTIAL_MASTER_KEY_B64=" + (New-RandomBase64 32))

[IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
Write-Host "Se creó .env con secretos aleatorios."
Write-Host "Complete OPENAI_API_KEY y N8N_WEBHOOK_URL. ANTHROPIC_API_KEY puede permanecer vacía."
Write-Host "El token de Telegram se incorpora después mediante el paquete cifrado .odooai."
Write-Host "No envíe ni confirme .env en Git."
