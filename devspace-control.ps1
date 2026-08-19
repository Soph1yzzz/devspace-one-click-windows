param(
    [ValidateSet("start", "stop", "status", "restart-server", "ensure", "diagnose")]
    [string]$Action = "start"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Common = Join-Path $PSScriptRoot "devspace-common.ps1"
$SessionGuardScript = Join-Path $PSScriptRoot "session-guard.mjs"
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) {
    throw "Required helper was not found: $Common"
}
if (-not (Test-Path -LiteralPath $SessionGuardScript -PathType Leaf)) {
    throw "Required SessionGuard was not found: $SessionGuardScript"
}
. $Common

Assert-WindowsHost
$Settings = Get-LauncherSettings -ScriptRoot $PSScriptRoot
$Paths = Get-LauncherPaths
$Mutex = $null

# Cloudflare Tunnel forwards client IP headers. DevSpace must trust the local
# proxy chain (Cloudflare -> SessionGuard -> DevSpace) or OAuth/account-linking
# requests can fail with HTTP 400.
$env:DEVSPACE_TRUST_PROXY = "1"

function Get-TunnelProcess {
    return Get-ManagedProcess `
        -PidFile $Paths.TunnelPidFile `
        -AllowedNames @("cloudflared") `
        -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.BridgePort)")
}

function Get-LegacyTunnelProcess {
    return Get-ManagedProcess `
        -PidFile $Paths.TunnelPidFile `
        -AllowedNames @("cloudflared") `
        -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.Port)")
}

function Get-SessionGuardProcess {
    return Get-ManagedProcess `
        -PidFile $Paths.SessionGuardPidFile `
        -AllowedNames @("node") `
        -RequiredCommandLineFragments @(
            $SessionGuardScript,
            "--listen-port", [string]$Settings.BridgePort,
            "--upstream-port", [string]$Settings.Port,
            "--runtime-file", $Paths.SessionGuardRuntime
        )
}

function Get-LegacySessionGuardProcess {
    # V1 did not pass --runtime-file. Call this only when the V2 matcher failed.
    return Get-ManagedProcess `
        -PidFile $Paths.SessionGuardPidFile `
        -AllowedNames @("node") `
        -RequiredCommandLineFragments @($SessionGuardScript, "--listen-port", [string]$Settings.BridgePort, "--upstream-port", [string]$Settings.Port)
}

function Get-DevSpaceProcess {
    $cli = Resolve-DevSpaceCli
    return Get-ManagedProcess `
        -PidFile $Paths.DevSpacePidFile `
        -AllowedNames @("node") `
        -RequiredCommandLineFragments @($cli.CliPath, "serve")
}

function Stop-TunnelProcess {
    $tunnel = Get-TunnelProcess
    if ($null -ne $tunnel) {
        Stop-ManagedProcess `
            -PidFile $Paths.TunnelPidFile `
            -AllowedNames @("cloudflared") `
            -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.BridgePort)")
        return
    }

    # One-time migration support for pre-SessionGuard launcher instances.
    $legacy = Get-LegacyTunnelProcess
    if ($null -ne $legacy) {
        Stop-ManagedProcess `
            -PidFile $Paths.TunnelPidFile `
            -AllowedNames @("cloudflared") `
            -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.Port)")
        return
    }

    Remove-Item -LiteralPath $Paths.TunnelPidFile -Force -ErrorAction SilentlyContinue
}

function Stop-SessionGuardProcess {
    $guard = Get-SessionGuardProcess
    if ($null -ne $guard) {
        Stop-ManagedProcess `
            -PidFile $Paths.SessionGuardPidFile `
            -AllowedNames @("node") `
            -RequiredCommandLineFragments @(
                $SessionGuardScript,
                "--listen-port", [string]$Settings.BridgePort,
                "--upstream-port", [string]$Settings.Port,
                "--runtime-file", $Paths.SessionGuardRuntime
            )
        return
    }

    $legacy = Get-LegacySessionGuardProcess
    if ($null -ne $legacy) {
        Stop-ManagedProcess `
            -PidFile $Paths.SessionGuardPidFile `
            -AllowedNames @("node") `
            -RequiredCommandLineFragments @($SessionGuardScript, "--listen-port", [string]$Settings.BridgePort, "--upstream-port", [string]$Settings.Port)
        return
    }

    Remove-Item -LiteralPath $Paths.SessionGuardPidFile -Force -ErrorAction SilentlyContinue
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
    $legacyTunnel = if ($null -eq $tunnel) { Get-LegacyTunnelProcess } else { $null }
    $guard = Get-SessionGuardProcess
    $legacyGuard = if ($null -eq $guard) { Get-LegacySessionGuardProcess } else { $null }
    $server = Get-DevSpaceProcess
    $runtime = Get-SessionGuardRuntimeState -Path $Paths.SessionGuardRuntime
    $mcpUrl = "(not available)"

    if (Test-Path -LiteralPath $Paths.PublicUrlFile -PathType Leaf) {
        try {
            $mcpUrl = "$(Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile)/mcp"
        } catch {
            $mcpUrl = "(invalid stored URL)"
        }
    }

    $tunnelText = if ($null -ne $tunnel) {
        "running (PID $($tunnel.Id))"
    } elseif ($null -ne $legacyTunnel) {
        "legacy direct mode (PID $($legacyTunnel.Id); restart once to migrate)"
    } else {
        "stopped"
    }

    $lastMcp = if ($null -eq $runtime) { "unavailable" } elseif ($runtime.LastMcpAt) { $runtime.LastMcpAt } else { "never" }
    $recoveryText = if ($null -eq $runtime) {
        "unavailable"
    } else {
        "$($runtime.RecoveriesSucceeded) succeeded, $($runtime.RecoveriesFailed) failed"
    }

    $guardText = if ($null -ne $guard) {
        "running (PID $($guard.Id))"
    } elseif ($null -ne $legacyGuard) {
        "legacy V1 (PID $($legacyGuard.Id); restart once to upgrade)"
    } else {
        "stopped"
    }

    Write-Output "cloudflared:  $tunnelText"
    Write-Output "SessionGuard: $guardText"
    Write-Output "DevSpace:     $(if ($null -ne $server) { "running (PID $($server.Id))" } else { "stopped" })"
    Write-Output "MCP URL:      $mcpUrl"
    Write-Output "Last MCP seen: $lastMcp"
    Write-Output "Recovery:      $recoveryText"
}

function Start-SessionGuard {
    Assert-PortAvailable -Port $Settings.BridgePort
    $cli = Resolve-DevSpaceCli
    Remove-Item -LiteralPath $Paths.SessionGuardOut, $Paths.SessionGuardErr -Force -ErrorAction SilentlyContinue

    $argumentLine = '"{0}" --listen-host 127.0.0.1 --listen-port {1} --upstream-host 127.0.0.1 --upstream-port {2} --state-file "{3}" --runtime-file "{4}"' -f `
        $SessionGuardScript, $Settings.BridgePort, $Settings.Port, $Paths.SessionGuardState, $Paths.SessionGuardRuntime

    $guard = Start-Process -FilePath $cli.NodePath `
        -ArgumentList $argumentLine `
        -RedirectStandardOutput $Paths.SessionGuardOut `
        -RedirectStandardError $Paths.SessionGuardErr `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -LiteralPath $Paths.SessionGuardPidFile -Value $guard.Id -Encoding ascii

    $started = Wait-ForOwnedListener `
        -Port $Settings.BridgePort `
        -ProcessId $guard.Id `
        -Process $guard `
        -TimeoutSeconds $Settings.StartupTimeoutSeconds

    if (-not $started) {
        Stop-SessionGuardProcess
        throw "SessionGuard did not start on port $($Settings.BridgePort). Check $($Paths.SessionGuardErr)."
    }

    return $guard
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
        -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$($Settings.BridgePort)") `
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

function Start-FullStack {
    Stop-TunnelProcess
    Stop-SessionGuardProcess
    Stop-DevSpaceProcess
    Assert-PortAvailable -Port $Settings.Port
    Assert-PortAvailable -Port $Settings.BridgePort

    try {
        # The guard exists before public ingress, so a new tunnel never points directly at DevSpace.
        Start-SessionGuard | Out-Null
        $publicUrl = Start-QuickTunnel
        Start-DevSpaceServer -PublicUrl $publicUrl | Out-Null
        Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
    } catch {
        try { Stop-TunnelProcess } catch { }
        try { Stop-SessionGuardProcess } catch { }
        try { Stop-DevSpaceProcess } catch { }
        throw
    }
}

function Ensure-Stack {
    $tunnel = Get-TunnelProcess
    $legacyTunnel = if ($null -eq $tunnel) { Get-LegacyTunnelProcess } else { $null }
    $guard = Get-SessionGuardProcess
    $server = Get-DevSpaceProcess

    if ($null -ne $legacyTunnel) {
        Write-Host "Migrating the legacy direct tunnel to SessionGuard. The Quick Tunnel URL will change once." -ForegroundColor Yellow
        Start-FullStack
        return
    }

    if ($null -ne $tunnel -and $null -ne $guard -and $null -ne $server) {
        try {
            $publicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
        } catch {
            Write-Host "The managed tunnel is running but its stored public URL is unavailable. Rebuilding the stack safely..." -ForegroundColor Yellow
            Start-FullStack
            return
        }
        Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
        return
    }

    if ($null -ne $tunnel) {
        try {
            $publicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
        } catch {
            Write-Host "The managed tunnel is running but its stored public URL is unavailable. Rebuilding the stack safely..." -ForegroundColor Yellow
            Start-FullStack
            return
        }

        # Preserve the existing public URL whenever the tunnel is still healthy.
        if ($null -eq $guard) {
            $legacyGuard = Get-LegacySessionGuardProcess
            if ($null -ne $legacyGuard) {
                Write-Host "Upgrading the running SessionGuard V1 process in place while keeping the current tunnel URL..." -ForegroundColor Yellow
                Stop-SessionGuardProcess
            } else {
                Write-Host "SessionGuard is stopped. Restoring it without replacing the current tunnel URL..." -ForegroundColor Yellow
            }
            Start-SessionGuard | Out-Null
        }
        if ($null -eq $server) {
            Write-Host "DevSpace is stopped. Restoring it behind the existing SessionGuard and tunnel..." -ForegroundColor Yellow
            Start-DevSpaceServer -PublicUrl $publicUrl | Out-Null
        }
        Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
        return
    }

    # No public ingress exists, so a new Quick Tunnel URL is unavoidable. Keep an
    # existing SessionGuard alive when possible so its external-session mappings survive.
    if ($null -eq $guard) {
        Start-SessionGuard | Out-Null
    }
    $publicUrl = Start-QuickTunnel
    if ($null -ne $server) {
        Stop-DevSpaceProcess
    }
    Start-DevSpaceServer -PublicUrl $publicUrl | Out-Null
    Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
}

function Show-Diagnostics {
    Show-Status
    Write-Output ""

    foreach ($entry in @(
        [pscustomobject]@{ Name = "SessionGuard"; Port = $Settings.BridgePort },
        [pscustomobject]@{ Name = "DevSpace"; Port = $Settings.Port }
    )) {
        $listener = Get-NetTCPConnection -LocalPort $entry.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $listener) {
            Write-Output "$($entry.Name) listener: 127.0.0.1:$($entry.Port) (PID $($listener.OwningProcess))"
        } else {
            Write-Output "$($entry.Name) listener: not listening on port $($entry.Port)"
        }
    }

    $runtime = Get-SessionGuardRuntimeState -Path $Paths.SessionGuardRuntime
    if ($null -eq $runtime) {
        Write-Output "SessionGuard diagnostics: runtime state unavailable or invalid."
    } else {
        Write-Output "Guard instance: $($runtime.GuardInstanceId)"
        Write-Output "HTTP/MCP requests: $($runtime.HttpRequests) / $($runtime.McpRequests)"
        Write-Output "Initialize requests: $($runtime.InitializeRequests)"
        Write-Output "Downstream session 404s: $($runtime.Downstream404)"
        Write-Output "Recovery attempts: $($runtime.RecoveriesStarted); succeeded: $($runtime.RecoveriesSucceeded); failed: $($runtime.RecoveriesFailed)"
        Write-Output "Last downstream 404: $(if ($runtime.LastDownstream404At) { $runtime.LastDownstream404At } else { "never" })"
    }

    try {
        $localMetadata = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$($Settings.BridgePort)/.well-known/oauth-protected-resource/mcp" `
            -UseBasicParsing `
            -TimeoutSec $Settings.HttpTimeoutSeconds
        Write-Output "Local metadata through SessionGuard: HTTP $($localMetadata.StatusCode)"
    } catch {
        Write-Output "Local metadata through SessionGuard: unavailable"
    }

    try {
        $publicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
        Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
        Write-Output "Public metadata through tunnel: HTTP 200"
    } catch {
        Write-Output "Public metadata through tunnel: unavailable"
    }

    Write-Output "Diagnostic hint: if ChatGPT reports a DevSpace invocation failure but 'Last MCP seen' does not advance while all three processes are healthy, the request may have failed before reaching SessionGuard."
}

New-Item -ItemType Directory -Path $Paths.RuntimeDir -Force | Out-Null

try {
    $Mutex = Enter-LauncherMutex -Name "Control"

    if ($Action -eq "status") {
        Show-Status
        exit 0
    }

    if ($Action -eq "diagnose") {
        Show-Diagnostics
        exit 0
    }

    if ($Action -eq "stop") {
        # Cut public ingress first, then stop the recovery layer and DevSpace.
        Stop-TunnelProcess
        Stop-SessionGuardProcess
        Stop-DevSpaceProcess
        Write-Output "DevSpace, SessionGuard, and the Quick Tunnel are stopped."
        exit 0
    }

    if ($Action -eq "restart-server") {
        $tunnel = Get-TunnelProcess
        $guard = Get-SessionGuardProcess
        if ($null -eq $tunnel -or $null -eq $guard) {
            throw "The managed Cloudflare tunnel and SessionGuard must be running. Use the start action instead."
        }

        $publicUrl = Get-ValidatedPublicUrl -Path $Paths.PublicUrlFile
        Stop-DevSpaceProcess
        Start-DevSpaceServer -PublicUrl $publicUrl | Out-Null
        Test-PublicMetadata -PublicUrl $publicUrl -TimeoutSeconds $Settings.HttpTimeoutSeconds
        Show-Status
        exit 0
    }

    if ($Action -eq "ensure") {
        Ensure-Stack
        Show-Status
        exit 0
    }

    Start-FullStack
    Show-Status
} finally {
    Exit-LauncherMutex -Mutex $Mutex
}
