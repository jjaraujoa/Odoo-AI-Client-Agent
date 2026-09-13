[CmdletBinding()]
param([string]$Distro = "odoo19e")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")
try {
    Invoke-WslProjectScript -Distro $Distro -ScriptName "stop.sh"
}
finally {
    Stop-WslKeepAlive -Distro $Distro
}
