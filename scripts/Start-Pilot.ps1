[CmdletBinding()]
param(
    [switch]$WithTunnel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker no está instalado o no está disponible en PATH."
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".env"))) {
    throw "Falta .env. Ejecute scripts/Initialize-Pilot.ps1."
}

Push-Location $projectRoot
try {
    docker compose config --quiet
    if ($LASTEXITCODE -ne 0) { throw "docker compose config detectó una configuración inválida." }
    if ($WithTunnel) {
        docker compose --profile tunnel up -d --build
    }
    else {
        docker compose up -d --build
    }
    if ($LASTEXITCODE -ne 0) { throw "No se pudo iniciar el piloto." }
    docker compose ps
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "n8n: http://localhost:5678"
Write-Host "Salud de control-api: http://localhost:8080/health"

