[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ClientSlug,
    [Parameter(Mandatory)][long]$TelegramUserId,
    [long]$TelegramChatId,
    [string]$TelegramUsername,
    [Parameter(Mandatory)][string]$OdooLogin
)

. (Join-Path $PSScriptRoot "Common.ps1")
$root = Get-ProjectRoot
$environment = Read-DotEnv (Join-Path $root ".env")
$secureApiKey = Read-Host "API key individual de Odoo (no se mostrará)" -AsSecureString
$apiKey = Convert-SecureStringToPlainText $secureApiKey
try {
    $body = @{
        client_slug = $ClientSlug
        telegram_user_id = $TelegramUserId
        telegram_chat_id = if ($TelegramChatId) { $TelegramChatId } else { $null }
        telegram_username = if ($TelegramUsername) { $TelegramUsername } else { $null }
        odoo_login = $OdooLogin
        odoo_api_key = $apiKey
        linked_by = $env:USERNAME
    }
    $result = Invoke-AgentAdmin $environment "/v1/admin/users" $body
    $result | ConvertTo-Json -Depth 5
}
finally {
    $apiKey = $null
    $secureApiKey.Dispose()
}

