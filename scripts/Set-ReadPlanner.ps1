[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ClientSlug,
    [ValidateSet("legacy", "shadow", "active")][string]$Mode = "shadow",
    [string[]]$Entities = @(
        "ordenes_venta",
        "ordenes_compra",
        "facturas_cliente",
        "productos",
        "inventario",
        "clientes"
    )
)

. (Join-Path $PSScriptRoot "Common.ps1")
$root = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $root ".env")
$body = @{
    client_slug = $ClientSlug
    mode = $Mode
    entities = @($Entities)
}

$result = Invoke-AgentAdmin $environment "/v1/admin/read-planner" $body
$result | ConvertTo-Json -Depth 5
