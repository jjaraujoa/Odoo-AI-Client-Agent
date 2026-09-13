[CmdletBinding()]
param([string]$Distro = "odoo19e")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Wsl-Common.ps1")

function Set-DotEnvValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Value
    )
    $content = [IO.File]::ReadAllText($Path)
    $line = "$Name=$Value"
    $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
    if ([regex]::IsMatch($content, $pattern)) {
        $content = [regex]::Replace($content, $pattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $line })
    } else {
        if ($content -and -not $content.EndsWith("`n")) { $content += [Environment]::NewLine }
        $content += $line + [Environment]::NewLine
    }
    [IO.File]::WriteAllText($Path, $content, [Text.UTF8Encoding]::new($false))
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) {
    throw "No existe .env. Ejecute primero la instalación WSL del piloto."
}

Start-WslKeepAlive -Distro $Distro
Invoke-WslProjectScript -Distro $Distro -ScriptName "sync-runtime-artifacts.sh"

$wslRoot = Get-WslProjectPath -Distro $Distro -WindowsPath $projectRoot
$wslScript = "$wslRoot/scripts/wsl/start-quick-tunnel.sh"
$output = & wsl -d $Distro -u root -- bash $wslScript $wslRoot
if ($LASTEXITCODE -ne 0) { throw "No fue posible iniciar el Quick Tunnel dentro de WSL." }
$urlLine = @($output | Where-Object { $_ -match '^QUICK_TUNNEL_URL=https://' }) | Select-Object -Last 1
if (-not $urlLine) { throw "El iniciador no devolvió la URL temporal esperada." }
$url = ($urlLine -split '=', 2)[1].Trim().TrimEnd('/')
if ($url -notmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') {
    throw "Cloudflare devolvió una URL temporal inesperada."
}

Set-DotEnvValue -Path $envPath -Name "N8N_WEBHOOK_URL" -Value "$url/"
Invoke-WslProjectScript -Distro $Distro -ScriptName "update-secrets.sh"

Write-Host ""
Write-Host "Quick Tunnel temporal activo." -ForegroundColor Green
Write-Host "URL base: $url/"
Write-Host "Ruta pública permitida: $url/webhook/odoo-ai-telegram"
Write-Host "El editor de n8n y las demás rutas responden 404 a través del túnel."
Write-Host "Esta URL cambia cuando se detiene y se vuelve a iniciar el Quick Tunnel."
