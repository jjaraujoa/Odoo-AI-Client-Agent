[CmdletBinding()]
param(
    [string]$DisplayName,
    [switch]$Activate
)

. (Join-Path $PSScriptRoot "Common.ps1")
$root = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $root ".env")
$body = @{
    activate = [bool]$Activate
}
if ($DisplayName) { $body.display_name = $DisplayName }

$result = Invoke-AgentAdmin $environment "/v1/admin/models/validate" $body
$result | ConvertTo-Json -Depth 8

