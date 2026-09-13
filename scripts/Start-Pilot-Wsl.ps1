[CmdletBinding()]
param([string]$Distro = "odoo19e")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")
Start-WslKeepAlive -Distro $Distro
try {
    Invoke-WslProjectScript -Distro $Distro -ScriptName "start.sh"
}
catch {
    Stop-WslKeepAlive -Distro $Distro
    throw
}

$deadline = (Get-Date).AddSeconds(90)
$n8nResponse = $null
$controlResponse = $null
do {
    try {
        $n8nResponse = Invoke-WebRequest `
            -Uri "http://127.0.0.1:5678" `
            -UseBasicParsing `
            -TimeoutSec 5
        $controlResponse = Invoke-RestMethod `
            -Uri "http://127.0.0.1:8080/health" `
            -TimeoutSec 5
        if ($n8nResponse.StatusCode -eq 200 -and $controlResponse.status -eq "ok") {
            break
        }
    }
    catch {
        Start-Sleep -Seconds 3
    }
} while ((Get-Date) -lt $deadline)

if (
    -not $n8nResponse `
    -or $n8nResponse.StatusCode -ne 200 `
    -or -not $controlResponse `
    -or $controlResponse.status -ne "ok"
) {
    throw "Los servicios iniciaron, pero no respondieron en localhost dentro de 90 segundos."
}

Write-Host ""
Write-Host "n8n: http://localhost:5678"
Write-Host "Salud de control-api: http://localhost:8080/health"
