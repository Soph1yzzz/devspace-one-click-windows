param(
    [string]$Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Common = Join-Path $PSScriptRoot "devspace-common.ps1"
$Controller = Join-Path $PSScriptRoot "devspace-control.ps1"
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) {
    throw "Required helper was not found: $Common"
}
if (-not (Test-Path -LiteralPath $Controller -PathType Leaf)) {
    throw "Required controller was not found: $Controller"
}
. $Common

Assert-WindowsHost
$Settings = Get-LauncherSettings -ScriptRoot $PSScriptRoot
$Paths = Get-LauncherPaths
$backupFile = $null
$configChanged = $false
$previousPublicUrl = $null
$stackWasRunning = $false
$mutex = $null

function Normalize-InputPath {
    param([string]$Value)

    $normalized = $Value.Trim()
    if ($normalized.Length -ge 2) {
        $first = $normalized[0]
        $last = $normalized[$normalized.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or
            ($first -eq "'" -and $last -eq "'")) {
            $normalized = $normalized.Substring(1, $normalized.Length - 2).Trim()
        }
    }
    return $normalized
}

function Get-StackState {
    $cli = Resolve-DevSpaceCli
    $tunnel = Get-ManagedProcess `
        -PidFile $Paths.TunnelPidFile `
        -AllowedNames @("cloudflared") `
        -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.Port)")
    $server = Get-ManagedProcess `
        -PidFile $Paths.DevSpacePidFile `
        -AllowedNames @("node") `
        -RequiredCommandLineFragments @($cli.CliPath, "serve")

    return [pscustomobject]@{
        Tunnel = $tunnel
        Server = $server
        FullyRunning = ($null -ne $tunnel -and $null -ne $server)
    }
}

try {
    $mutex = Enter-LauncherMutex -Name "RootChange"

    if (-not (Test-Path -LiteralPath $Paths.ConfigFile -PathType Leaf)) {
        throw "DevSpace config was not found: $($Paths.ConfigFile)"
    }

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $Path = Read-Host "Enter the folder path DevSpace may access"
    }
    $Path = Normalize-InputPath -Value $Path
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "No folder path was entered. Nothing was changed."
    }

    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
    $item = Get-Item -LiteralPath $resolved -Force
    if (-not $item.PSIsContainer) {
        throw "The path exists but is not a folder: $resolved"
    }

    $normalizedResolved = $resolved.TrimEnd('\')
    $driveRoot = [System.IO.Path]::GetPathRoot($resolved).TrimEnd('\')
    $homeRoot = $HOME.TrimEnd('\')
    if ($normalizedResolved -ieq $driveRoot) {
        throw "A drive root cannot be exposed to DevSpace: $resolved"
    }
    if ($normalizedResolved -ieq $homeRoot) {
        throw "The entire user home cannot be exposed to DevSpace: $resolved"
    }

    Write-Host "Validated folder: $resolved" -ForegroundColor Cyan

    $configJson = [System.IO.File]::ReadAllText($Paths.ConfigFile, [System.Text.Encoding]::UTF8)
    $config = $configJson | ConvertFrom-Json
    $state = Get-StackState
    $stackWasRunning = $state.FullyRunning

    if ($stackWasRunning) {
        $previousPublicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
    } elseif (Test-Path -LiteralPath $Paths.PublicUrlFile -PathType Leaf) {
        try { $previousPublicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile } catch { }
    }

    New-Item -ItemType Directory -Path $Paths.BackupDir -Force | Out-Null
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = Join-Path $Paths.BackupDir "config-before-root-change-$timestamp.json"
    Copy-Item -LiteralPath $Paths.ConfigFile -Destination $backupFile

    if ($null -eq $config.PSObject.Properties["allowedRoots"]) {
        $config | Add-Member -NotePropertyName allowedRoots -NotePropertyValue @($resolved)
    } else {
        $config.allowedRoots = @($resolved)
    }
    Write-JsonAtomically -Value $config -Destination $Paths.ConfigFile
    $configChanged = $true

    if ($stackWasRunning) {
        Write-Host "Restarting DevSpace while keeping the current tunnel URL..." -ForegroundColor Yellow
        & $Controller restart-server
    } else {
        Write-Host "DevSpace is not fully running. Starting a new Quick Tunnel and server..." -ForegroundColor Yellow
        & $Controller start
    }
    if ($LASTEXITCODE -ne 0) {
        throw "DevSpace could not be started with the new folder."
    }

    $activeConfig = ([System.IO.File]::ReadAllText($Paths.ConfigFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
    $activeRoots = @($activeConfig.allowedRoots)
    if ($activeRoots.Count -ne 1 -or $activeRoots[0] -ine $resolved) {
        throw "The active DevSpace root does not match the requested folder."
    }

    $publicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
    if ($stackWasRunning -and $publicUrl -ne $previousPublicUrl) {
        throw "The public URL changed unexpectedly during the server-only restart."
    } elseif ((-not $stackWasRunning) -and $previousPublicUrl -and $publicUrl -ne $previousPublicUrl) {
        Write-Host "The MCP URL changed because the Cloudflare Quick Tunnel was restarted." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "DevSpace folder change completed." -ForegroundColor Green
    Write-Host "Allowed folder: $resolved" -ForegroundColor Green
    Write-Host "MCP URL:     $publicUrl/mcp" -ForegroundColor Green
    Write-Host ""

    Get-ChildItem -LiteralPath $Paths.BackupDir -Filter "config-before-root-change-*.json" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $Settings.BackupRetention |
        Remove-Item -Force -ErrorAction SilentlyContinue
} catch {
    $failure = $_
    Write-Host ""
    Write-Host "Change failed: $($failure.Exception.Message)" -ForegroundColor Red

    if ($configChanged -and $backupFile -and (Test-Path -LiteralPath $backupFile)) {
        Write-Host "Restoring the previous DevSpace config..." -ForegroundColor Yellow
        try {
            Copy-Item -LiteralPath $backupFile -Destination $Paths.ConfigFile -Force
            if ($stackWasRunning) {
                & $Controller restart-server
            } else {
                & $Controller start
            }
            Write-Host "Previous config was restored and restarted." -ForegroundColor Yellow
            if (Test-Path -LiteralPath $Paths.PublicUrlFile -PathType Leaf) {
                try {
                    $restoredUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
                    Write-Host "Restored MCP URL: $restoredUrl/mcp" -ForegroundColor Yellow
                } catch { }
            }
        } catch {
            Write-Host "Automatic rollback also failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "The DevSpace config was not changed." -ForegroundColor Yellow
    }
    exit 1
} finally {
    Exit-LauncherMutex -Mutex $mutex
}
