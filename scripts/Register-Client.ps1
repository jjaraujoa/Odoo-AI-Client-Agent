[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Slug,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$OdooBaseUrl,
    [string]$OdooDatabase
)

. (Join-Path $PSScriptRoot "Common.ps1")
$root = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $root ".env")
$body = @{
    slug = $Slug
    name = $Name
    odoo_base_url = $OdooBaseUrl
    odoo_database = if ($OdooDatabase) { $OdooDatabase } else { $null }
}

$result = Invoke-AgentAdmin $environment "/v1/admin/clients" $body
$result | ConvertTo-Json -Depth 5

