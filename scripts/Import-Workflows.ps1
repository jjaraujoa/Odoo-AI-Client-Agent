[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workflowDir = Join-Path $projectRoot "n8n\workflows"

Push-Location $projectRoot
try {
    foreach ($file in Get-ChildItem -LiteralPath $workflowDir -Filter "*.json" | Sort-Object Name) {
        $containerPath = "/workflows/$($file.Name)"
        Write-Host "Importando $($file.Name)..."
        docker compose exec -T n8n n8n import:workflow "--input=$containerPath"
        if ($LASTEXITCODE -ne 0) { throw "Falló la importación de $($file.Name)." }
    }
}
finally {
    Pop-Location
}

Write-Host "Workflows importados. Abra n8n, asigne las credenciales y actívelos."

