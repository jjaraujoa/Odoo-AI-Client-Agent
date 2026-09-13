[CmdletBinding()]
param(
    [string]$Distro = "odoo19e",
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,62}$')][string]$ClientSlug = "piloto-odoo19",
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Model = "gpt-5.6-terra",
    [ValidateRange(1, 80)][int]$Limit = 80,
    [ValidatePattern('^[A-Za-z0-9,]*$')][string]$CaseIds = "",
    [switch]$Enforce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")

$arguments = @($ClientSlug, $Model, [string]$Limit, $CaseIds, [string][bool]$Enforce)
Invoke-WslProjectScript -Distro $Distro -ScriptName "evaluate-read-planner.sh" -Arguments $arguments
