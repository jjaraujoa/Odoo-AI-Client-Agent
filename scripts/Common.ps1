Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ProjectRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Read-DotEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No existe $Path. Ejecute primero scripts/Initialize-Pilot.ps1."
    }
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) { continue }
        $parts = $trimmed.Split("=", 2)
        $values[$parts[0].Trim()] = $parts[1].Trim()
    }
    return $values
}

function Convert-SecureStringToPlainText {
    param([Security.SecureString]$SecureValue)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Invoke-AgentAdmin {
    param(
        [hashtable]$Environment,
        [string]$Path,
        [hashtable]$Body
    )
    $port = if ($Environment["CONTROL_API_PORT"]) { $Environment["CONTROL_API_PORT"] } else { "8080" }
    $headers = @{ "X-Admin-Key" = $Environment["CONTROL_API_ADMIN_KEY"] }
    return Invoke-RestMethod `
        -Uri "http://127.0.0.1:$port$Path" `
        -Method Post `
        -Headers $headers `
        -ContentType "application/json" `
        -Body ($Body | ConvertTo-Json -Depth 10 -Compress)
}

