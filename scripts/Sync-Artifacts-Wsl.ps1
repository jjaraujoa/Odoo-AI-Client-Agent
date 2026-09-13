[CmdletBinding()]
param([string]$Distro = "odoo19e")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")
Invoke-WslProjectScript -Distro $Distro -ScriptName "sync-runtime-artifacts.sh"
