Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-WslProjectPath {
    param(
        [string]$Distro,
        [string]$WindowsPath
    )
    $resolved = (Resolve-Path -LiteralPath $WindowsPath).Path
    $wslPath = (& wsl -d $Distro -- wslpath -a $resolved | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $wslPath) {
        throw "No fue posible convertir la ruta del proyecto para WSL."
    }
    return $wslPath
}

function Invoke-WslProjectScript {
    param(
        [string]$Distro,
        [string]$ScriptName,
        [string[]]$Arguments = @()
    )
    $projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $wslRoot = Get-WslProjectPath -Distro $Distro -WindowsPath $projectRoot
    $wslScript = "$wslRoot/scripts/wsl/$ScriptName"
    & wsl -d $Distro -- bash $wslScript $wslRoot @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Falló $ScriptName dentro de WSL."
    }
}

function Get-WslKeepAlivePidPath {
    param([string]$Distro)

    $projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $workDirectory = Join-Path $projectRoot "work"
    if (-not (Test-Path -LiteralPath $workDirectory)) {
        New-Item -ItemType Directory -Path $workDirectory | Out-Null
    }
    return (Join-Path $workDirectory "wsl-keepalive-$Distro.pid")
}

function Start-WslKeepAlive {
    param([string]$Distro)

    $pidPath = Get-WslKeepAlivePidPath -Distro $Distro
    if (Test-Path -LiteralPath $pidPath) {
        $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw)
        $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($existing -and $existing.ProcessName -eq "wsl") {
            return
        }
        Remove-Item -LiteralPath $pidPath -Force
    }

    $wslExecutable = Join-Path $env:SystemRoot "System32\wsl.exe"
    $process = Start-Process `
        -FilePath $wslExecutable `
        -ArgumentList @("-d", $Distro, "--", "sleep", "infinity") `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -LiteralPath $pidPath -Value $process.Id -NoNewline
    Start-Sleep -Seconds 2
}

function Stop-WslKeepAlive {
    param([string]$Distro)

    $pidPath = Get-WslKeepAlivePidPath -Distro $Distro
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return
    }

    $keepAlivePid = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-Process -Id $keepAlivePid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "wsl") {
        Stop-Process -Id $keepAlivePid -Force
    }
    Remove-Item -LiteralPath $pidPath -Force
}
