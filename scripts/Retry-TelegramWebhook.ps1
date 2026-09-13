[CmdletBinding()]
param([Parameter(Mandatory)][string]$ClientSlug)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

$root = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $root ".env")
$result = Invoke-AgentAdmin `
    -Environment $environment `
    -Path "/v1/admin/telegram/webhook" `
    -Body @{ client_slug = $ClientSlug }

Write-Host ""
if ($result.registered) {
    Write-Host "Webhook de Telegram registrado correctamente." -ForegroundColor Green
} else {
    Write-Host "Telegram no permitió registrar el webhook." -ForegroundColor Red
}
Write-Host "Cliente: $($result.client_slug)"
Write-Host "URL:     $($result.webhook_url)"
Write-Host "Estado:  $($result.message)"
