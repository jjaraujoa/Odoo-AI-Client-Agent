[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ClientSlug,
    [Parameter(Mandatory)][string]$DisplayName,
    [int]$AutoPriority = 100
)

. (Join-Path $PSScriptRoot "Common.ps1")
$root = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $root ".env")
$body = @{
    client_slug = $ClientSlug
    display_name = $DisplayName
    enabled = $true
    auto_priority = $AutoPriority
}

$result = Invoke-AgentAdmin $environment "/v1/admin/client-models" $body
$result | ConvertTo-Json -Depth 5

