[CmdletBinding()]
param(
    [string]$Distro = "odoo19e"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Host "No existe .env; se generará con secretos locales aleatorios."
    & (Join-Path $PSScriptRoot "Initialize-Pilot.ps1")
    if (-not (Test-Path -LiteralPath $envPath)) {
        throw "No se pudo generar .env."
    }
}

Invoke-WslProjectScript -Distro $Distro -ScriptName "install.sh"
