[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ClientSlug,
    [int]$RequestsPerMinute = 10,
    [int]$RequestsPerDay = 100,
    [int]$ConcurrentRequests = 3,
    [int]$MaxOdooRecords = 50,
    [int]$MaxDisplayRecords = 10,
    [int]$MaxDocumentBytes = 5242880,
    [int]$MaxDocumentPages = 10,
    [int]$MaxContextMessages = 20,
    [int]$InactivityMinutes = 30,
    [int]$AbsoluteSessionHours = 24
)

. (Join-Path $PSScriptRoot "Common.ps1")
$root = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $root ".env")
$body = @{
    client_slug = $ClientSlug
    limits = @{
        requests_per_minute = $RequestsPerMinute
        requests_per_day = $RequestsPerDay
        concurrent_requests = $ConcurrentRequests
        max_odoo_records = $MaxOdooRecords
        max_display_records = $MaxDisplayRecords
        max_document_bytes = $MaxDocumentBytes
        max_document_pages = $MaxDocumentPages
        max_context_messages = $MaxContextMessages
        inactivity_minutes = $InactivityMinutes
        absolute_session_hours = $AbsoluteSessionHours
    }
}

$result = Invoke-AgentAdmin $environment "/v1/admin/limits" $body
$result | ConvertTo-Json -Depth 5
