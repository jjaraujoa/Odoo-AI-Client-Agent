[CmdletBinding()]
param(
    [string]$Distro = "odoo19e",
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,62}$')][string]$ClientSlug = "piloto-odoo19"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")
Invoke-WslProjectScript -Distro $Distro -ScriptName "smoke-read-executor.sh" -Arguments @($ClientSlug)
