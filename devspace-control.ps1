param(
    [ValidateSet("start", "stop", "status", "restart-server")]
    [string]$Action = "start"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Common = Join-Path $PSScriptRoot "devspace-common.ps1"
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) {
    throw "Required helper was not found: $Common"
}
. $Common

Assert-WindowsHost
$Settings = Get-LauncherSettings -ScriptRoot $PSScriptRoot
$Paths = Get-LauncherPaths
$Mutex = $null

# Cloudflare Tunnel forwards client IP headers. DevSpace must trust the local
# tunnel proxy or OAuth/account-linking requests can fail with HTTP 400.
$env:DEVSPACE_TRUST_PROXY = "1"

function Get-TunnelProcess {
    return Get-ManagedProcess `
        -PidFile $Paths.TunnelPidFile `
        -AllowedNames @("cloudflared") `
        -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.Port)")
}

function Get-DevSpaceProcess {
    $cli = Resolve-DevSpaceCli
    return Get-ManagedProcess `
        -PidFile $Paths.DevSpacePidFile `
        -AllowedNames @("node") `
        -RequiredCommandLineFragments @($cli.CliPath, "serve")
}

function Stop-TunnelProcess {
    Stop-ManagedProcess `
        -PidFile $Paths.TunnelPidFile `
        -AllowedNames @("cloudflared") `
        -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.Port)")
}

function Stop-DevSpaceProcess {
    $cli = Resolve-DevSpaceCli
    Stop-ManagedProcess `
        -PidFile $Paths.DevSpacePidFile `
        -AllowedNames @("node") `
        -RequiredCommandLineFragments @($cli.CliPath, "serve")
}

function Show-Status {
    $tunnel = Get-TunnelProcess
    $server = Get-DevSpaceProcess
    $mcpUrl = "(not available)"

    if (Test-Path -LiteralPath $Paths.PublicUrlFile -PathType Leaf) {
        try {
            $mcpUrl = "$(Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile)/mcp"
        } catch {
            $mcpUrl = "(invalid stored URL)"
        }
    }

    Write-Output "cloudflared: $(if ($null -ne $tunnel) { "running (PID $($tunnel.Id))" } else { "stopped" })"
    Write-Output "DevSpace:    $(if ($null -ne $server) { "running (PID $($server.Id))" } else { "stopped" })"
    Write-Output "MCP URL:     $mcpUrl"
}

function Start-DevSpaceServer {
    param([string]$PublicUrl)

    Assert-PortAvailable -Port $Settings.Port
    Set-DevSpacePublicBaseUrl -PublicUrl $PublicUrl

    $cli = Resolve-DevSpaceCli
    Remove-Item -LiteralPath $Paths.DevSpaceOut, $Paths.DevSpaceErr -Force -ErrorAction SilentlyContinue

    $server = Start-Process -FilePath $cli.NodePath `
        -ArgumentList @($cli.CliPath, "serve") `
        -RedirectStandardOutput $Paths.DevSpaceOut `
        -RedirectStandardError $Paths.DevSpaceErr `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -LiteralPath $Paths.DevSpacePidFile -Value $server.Id -Encoding ascii

    $started = Wait-ForOwnedListener `
        -Port $Settings.Port `
        -ProcessId $server.Id `
        -Process $server `
        -TimeoutSeconds $Settings.StartupTimeoutSeconds

    if (-not $started) {
        Stop-ManagedProcess `
            -PidFile $Paths.DevSpacePidFile `
            -AllowedNames @("node") `
            -RequiredCommandLineFragments @($cli.CliPath, "serve")
        throw "DevSpace did not start on port $($Settings.Port). Check $($Paths.DevSpaceErr)."
    }

    return $server
}

function Start-QuickTunnel {
    $cloudflared = Resolve-Cloudflared
    Remove-Item -LiteralPath $Paths.TunnelOut, $Paths.TunnelErr -Force -ErrorAction SilentlyContinue

    $tunnel = Start-Process -FilePath $cloudflared `
        -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$($Settings.Port)") `
        -RedirectStandardOutput $Paths.TunnelOut `
        -RedirectStandardError $Paths.TunnelErr `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -LiteralPath $Paths.TunnelPidFile -Value $tunnel.Id -Encoding ascii

    $deadline = (Get-Date).AddSeconds($Settings.StartupTimeoutSeconds)
    $publicUrl = $null
    do {
        Start-Sleep -Milliseconds 500
        $log = ((Get-Content -LiteralPath $Paths.TunnelOut, $Paths.TunnelErr -Raw -ErrorAction SilentlyContinue) -join "`n")
        if ($log -match "https://[a-z0-9-]+\.trycloudflare\.com") {
            $publicUrl = $Matches[0]
        }
    } while ([string]::IsNullOrWhiteSpace($publicUrl) -and (Get-Date) -lt $deadline -and -not $tunnel.HasExited)

    if ([string]::IsNullOrWhiteSpace($publicUrl)) {
        Stop-TunnelProcess
        throw "The Cloudflare Quick Tunnel did not return a public URL. Check $($Paths.TunnelErr)."
    }

    Set-Content -LiteralPath $Paths.PublicUrlFile -Value $publicUrl -Encoding ascii
    return $publicUrl
}

New-Item -ItemType Directory -Path $Paths.RuntimeDir -Force | Out-Null

try {
    $Mutex = Enter-LauncherMutex -Name "Control"

    if ($Action -eq "status") {
        Show-Status
        exit 0
    }

    if ($Action -eq "stop") {
        Stop-DevSpaceProcess
        Stop-TunnelProcess
        Write-Output "DevSpace and its Quick Tunnel are stopped."
        exit 0
    }

    if ($Action -eq "restart-server") {
        $tunnel = Get-TunnelProcess
        if ($null -eq $tunnel) {
            throw "The managed Cloudflare tunnel is not running. Use the start action instead."
        }

        $publicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
        Stop-DevSpaceProcess
        Start-DevSpaceServer -PublicUrl $publicUrl | Out-Null
        Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
        Show-Status
        exit 0
    }

    Stop-DevSpaceProcess
    Stop-TunnelProcess
    Assert-PortAvailable -Port $Settings.Port

    $publicUrl = $null
    try {
        $publicUrl = Start-QuickTunnel
        Start-DevSpaceServer -PublicUrl $publicUrl | Out-Null
        Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
    } catch {
        try { Stop-DevSpaceProcess } catch { }
        try { Stop-TunnelProcess } catch { }
        throw
    }

    Show-Status
} finally {
    Exit-LauncherMutex -Mutex $Mutex
}
