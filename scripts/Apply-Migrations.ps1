[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")
$projectRoot = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $projectRoot ".env")

Push-Location $projectRoot
try {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectRoot "db\migrations") -Filter "*.sql" | Sort-Object Name) {
        $version = $file.BaseName
        $registry = docker compose exec -T postgres psql `
            -U $environment["POSTGRES_USER"] `
            -d $environment["POSTGRES_DB"] `
            -tAc "SELECT to_regclass('agent.schema_migrations')"
        if ($LASTEXITCODE -ne 0) { throw "No se pudo consultar el registro de migraciones." }
        if (($registry | Out-String).Trim()) {
            $applied = docker compose exec -T postgres psql `
                -U $environment["POSTGRES_USER"] `
                -d $environment["POSTGRES_DB"] `
                -tAc "SELECT 1 FROM agent.schema_migrations WHERE version = '$version'"
            if ($LASTEXITCODE -ne 0) { throw "No se pudo consultar la migración $version." }
            if (($applied | Out-String).Trim() -eq "1") {
                Write-Host "Omitiendo $($file.Name): ya aplicada."
                continue
            }
        }
        Write-Host "Aplicando $($file.Name)..."
        $containerPath = "/docker-entrypoint-initdb.d/$($file.Name)"
        docker compose exec -T postgres psql `
            -v ON_ERROR_STOP=1 `
            -U $environment["POSTGRES_USER"] `
            -d $environment["POSTGRES_DB"] `
            -f $containerPath
        if ($LASTEXITCODE -ne 0) { throw "Falló la migración $($file.Name)." }
    }
}
finally {
    Pop-Location
}

Write-Host "Migraciones aplicadas."
