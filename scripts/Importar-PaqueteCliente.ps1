[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archivo,
    [string]$Distro = "odoo19e"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageWindowsPath = (Resolve-Path -LiteralPath $Archivo).Path
if ([IO.Path]::GetExtension($packageWindowsPath) -ne ".odooai") {
    throw "El archivo debe tener extensión .odooai."
}
$projectWsl = Get-WslProjectPath -Distro $Distro -WindowsPath $projectRoot
$packageWsl = Get-WslProjectPath -Distro $Distro -WindowsPath $packageWindowsPath
$scriptWsl = "$projectWsl/scripts/wsl/import-onboarding-package.sh"

function Invoke-OnboardingCli {
    param([string]$Action, [string]$ExpectedHash = "")
    $output = & wsl -d $Distro -u root -- bash $scriptWsl `
        $projectWsl $Action $packageWsl $ExpectedHash
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String).Trim()
    if (-not $text) { throw "El importador no devolvió un resultado." }
    $result = $text | ConvertFrom-Json
    $okProperty = $result.PSObject.Properties["ok"]
    if ($exitCode -ne 0 -or ($okProperty -and $okProperty.Value -eq $false)) {
        throw "$($result.message)"
    }
    return $result
}

$preview = Invoke-OnboardingCli -Action "preview"
Write-Host ""
Write-Host "VISTA PREVIA DEL PAQUETE" -ForegroundColor Cyan
Write-Host "Cliente: $($preview.client.name) [$($preview.client.slug)]"
Write-Host "Odoo:   $($preview.client.odoo_base_url) / $($preview.client.odoo_database)"
Write-Host "Bot:    @$($preview.telegram.bot_username) - $($preview.telegram.status)"
Write-Host "Autor:  $($preview.consultant)"
Write-Host "Huella: $($preview.package_sha256)"
Write-Host ""
foreach ($user in $preview.users) {
    $state = if ($user.active) { "ACTIVO" } else { "BORRADOR" }
    $telegram = if ($null -ne $user.telegram_user_id) { $user.telegram_user_id } else { "pendiente" }
    $odoo = if ($user.odoo_login) { $user.odoo_login } else { "pendiente" }
    Write-Host ("- {0}: {1} | Odoo={2} | Telegram={3} | API={4} …{5}" -f `
        $user.row_id, $state, $odoo, $telegram, `
        $user.credential_status, $user.api_key_last_four)
}
if (@($preview.warnings).Count -gt 0) {
    Write-Host ""
    Write-Host "Advertencias:" -ForegroundColor Yellow
    $preview.warnings | ForEach-Object { Write-Host "- $_" }
}
if (-not $preview.can_apply) {
    Write-Host ""
    Write-Host "Errores:" -ForegroundColor Red
    $preview.errors | ForEach-Object { Write-Host "- $_" }
    throw "El paquete no pasó la validación. No se realizó ningún cambio."
}

Write-Host ""
$confirmation = Read-Host "Escriba IMPORTAR para aplicar exactamente este paquete"
if ($confirmation -cne "IMPORTAR") {
    Write-Host "Operación cancelada. La vista previa no realizó cambios."
    return
}

$result = Invoke-OnboardingCli -Action "apply" -ExpectedHash $preview.package_sha256
Write-Host ""
if ($result.idempotent) {
    Write-Host "El paquete ya había sido importado; no se crearon duplicados." -ForegroundColor Yellow
} else {
    Write-Host "Paquete importado correctamente." -ForegroundColor Green
}
Write-Host "Cliente: $($result.client_slug)"
Write-Host "Package ID: $($result.package_id)"
Write-Host "Webhook: $($result.webhook.message)"
