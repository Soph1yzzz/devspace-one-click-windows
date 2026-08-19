Set-StrictMode -Version 2.0

function Assert-WindowsHost {
    if ($env:OS -ne "Windows_NT") {
        throw "This launcher supports Windows only."
    }
}

function Get-LauncherSettings {
    param([string]$ScriptRoot)

    $settings = [ordered]@{
        Port = 7676
        BridgePort = 7677
        StartupTimeoutSeconds = 30
        HttpTimeoutSeconds = 20
        BackupRetention = 10
    }

    $settingsFile = Join-Path $ScriptRoot "launcher.settings.json"
    if (Test-Path -LiteralPath $settingsFile -PathType Leaf) {
        $custom = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($name in @($settings.Keys)) {
            $property = $custom.PSObject.Properties[$name]
            if ($null -ne $property) {
                $settings[$name] = $property.Value
            }
        }
    }

    $settings.Port = [int]$settings.Port
    $settings.BridgePort = [int]$settings.BridgePort
    $settings.StartupTimeoutSeconds = [int]$settings.StartupTimeoutSeconds
    $settings.HttpTimeoutSeconds = [int]$settings.HttpTimeoutSeconds
    $settings.BackupRetention = [int]$settings.BackupRetention

    if ($settings.Port -lt 1 -or $settings.Port -gt 65535) {
        throw "Port must be between 1 and 65535."
    }
    if ($settings.BridgePort -lt 1 -or $settings.BridgePort -gt 65535) {
        throw "BridgePort must be between 1 and 65535."
    }
    if ($settings.BridgePort -eq $settings.Port) {
        throw "BridgePort must be different from Port."
    }
    if ($settings.StartupTimeoutSeconds -lt 5) {
        throw "StartupTimeoutSeconds must be at least 5."
    }
    if ($settings.HttpTimeoutSeconds -lt 5) {
        throw "HttpTimeoutSeconds must be at least 5."
    }
    if ($settings.BackupRetention -lt 1) {
        throw "BackupRetention must be at least 1."
    }

    return [pscustomobject]$settings
}

function Get-LauncherPaths {
    $runtimeDir = Join-Path $HOME ".devspace\runtime"
    return [pscustomobject]@{
        ConfigFile = Join-Path $HOME ".devspace\config.json"
        BackupDir = Join-Path $HOME ".devspace\backups"
        RuntimeDir = $runtimeDir
        TunnelPidFile = Join-Path $runtimeDir "cloudflared.pid"
        SessionGuardPidFile = Join-Path $runtimeDir "session-guard.pid"
        DevSpacePidFile = Join-Path $runtimeDir "devspace.pid"
        PublicUrlFile = Join-Path $runtimeDir "public-url.txt"
        TunnelOut = Join-Path $runtimeDir "cloudflared.out.log"
        TunnelErr = Join-Path $runtimeDir "cloudflared.err.log"
        SessionGuardOut = Join-Path $runtimeDir "session-guard.out.log"
        SessionGuardErr = Join-Path $runtimeDir "session-guard.err.log"
        SessionGuardState = Join-Path $runtimeDir "session-guard-state.json"
        SessionGuardRuntime = Join-Path $runtimeDir "session-guard-runtime.json"
        DevSpaceOut = Join-Path $runtimeDir "devspace.out.log"
        DevSpaceErr = Join-Path $runtimeDir "devspace.err.log"
    }
}

function Get-SessionGuardRuntimeState {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    try {
        $parsed = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($null -eq $parsed -or $parsed.schemaVersion -ne 1) {
            return $null
        }

        $countersProperty = $parsed.PSObject.Properties["counters"]
        if ($null -eq $countersProperty -or $null -eq $countersProperty.Value) {
            return $null
        }
        $counters = $countersProperty.Value

        function Read-Counter {
            param([object]$Object, [string]$Name)
            $property = $Object.PSObject.Properties[$Name]
            if ($null -eq $property -or $null -eq $property.Value) { return [long]0 }
            try { return [long]$property.Value } catch { return [long]0 }
        }

        function Read-OptionalString {
            param([object]$Object, [string]$Name)
            $property = $Object.PSObject.Properties[$Name]
            if ($null -eq $property -or $null -eq $property.Value) { return $null }
            $value = [string]$property.Value
            if ([string]::IsNullOrWhiteSpace($value)) { return $null }
            return $value
        }

        return [pscustomobject]@{
            GuardInstanceId = Read-OptionalString -Object $parsed -Name "guardInstanceId"
            StartedAt = Read-OptionalString -Object $parsed -Name "startedAt"
            LastInboundAt = Read-OptionalString -Object $parsed -Name "lastInboundAt"
            LastMcpAt = Read-OptionalString -Object $parsed -Name "lastMcpAt"
            LastInitializeAt = Read-OptionalString -Object $parsed -Name "lastInitializeAt"
            LastRecoveryStartedAt = Read-OptionalString -Object $parsed -Name "lastRecoveryStartedAt"
            LastRecoverySucceededAt = Read-OptionalString -Object $parsed -Name "lastRecoverySucceededAt"
            LastDownstream404At = Read-OptionalString -Object $parsed -Name "lastDownstream404At"
            HttpRequests = Read-Counter -Object $counters -Name "httpRequests"
            McpRequests = Read-Counter -Object $counters -Name "mcpRequests"
            InitializeRequests = Read-Counter -Object $counters -Name "initializeRequests"
            Downstream404 = Read-Counter -Object $counters -Name "downstream404"
            RecoveriesStarted = Read-Counter -Object $counters -Name "recoveriesStarted"
            RecoveriesSucceeded = Read-Counter -Object $counters -Name "recoveriesSucceeded"
            RecoveriesFailed = Read-Counter -Object $counters -Name "recoveriesFailed"
        }
    } catch {
        return $null
    }
}

function Resolve-DevSpaceCli {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    $devspace = Get-Command devspace -ErrorAction SilentlyContinue

    if ($null -eq $node) {
        throw "node was not found in PATH. Install Node.js first."
    }
    if ($null -eq $npm) {
        throw "npm was not found in PATH. Install Node.js first."
    }
    if ($null -eq $devspace) {
        throw "devspace was not found in PATH. Install it with: npm install -g @waishnav/devspace"
    }

    $globalRoot = (& $npm.Source root -g).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($globalRoot)) {
        throw "npm root -g did not return a usable path."
    }

    $packageDir = Join-Path $globalRoot "@waishnav\devspace"
    $packageJsonFile = Join-Path $packageDir "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonFile -PathType Leaf)) {
        throw "The global @waishnav/devspace package was not found at $packageDir."
    }

    $package = Get-Content -LiteralPath $packageJsonFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $binPath = $null
    if ($package.bin -is [string]) {
        $binPath = $package.bin
    } elseif ($null -ne $package.bin) {
        $devspaceBin = $package.bin.PSObject.Properties["devspace"]
        if ($null -ne $devspaceBin) {
            $binPath = [string]$devspaceBin.Value
        } else {
            $firstBin = @($package.bin.PSObject.Properties)[0]
            if ($null -ne $firstBin) {
                $binPath = [string]$firstBin.Value
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($binPath)) {
        throw "The DevSpace package does not declare a CLI entry in package.json."
    }

    $cliPath = Join-Path $packageDir $binPath
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw "The DevSpace CLI declared by package.json was not found: $cliPath"
    }

    return [pscustomobject]@{
        NodePath = $node.Source
        CliPath = (Resolve-Path -LiteralPath $cliPath).ProviderPath
        Version = [string]$package.version
    }
}

function Resolve-Cloudflared {
    $command = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $wingetLink = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe"
    if (Test-Path -LiteralPath $wingetLink -PathType Leaf) {
        return $wingetLink
    }

    throw "cloudflared was not found. Install it with: winget install --id Cloudflare.cloudflared"
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)

    try {
        $instance = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return [string]$instance.CommandLine
    } catch {
        return $null
    }
}

function Get-ManagedProcess {
    param(
        [string]$PidFile,
        [string[]]$AllowedNames,
        [string[]]$RequiredCommandLineFragments = @()
    )

    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
        return $null
    }

    $rawPid = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if (-not ($rawPid -match "^\d+$")) {
        return $null
    }

    $process = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
    if ($null -eq $process -or $AllowedNames -notcontains $process.ProcessName) {
        return $null
    }

    if ($RequiredCommandLineFragments.Count -gt 0) {
        $commandLine = Get-ProcessCommandLine -ProcessId $process.Id
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            return $null
        }
        foreach ($fragment in $RequiredCommandLineFragments) {
            if ($commandLine.IndexOf($fragment, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                return $null
            }
        }
    }

    return $process
}

function Stop-ManagedProcess {
    param(
        [string]$PidFile,
        [string[]]$AllowedNames,
        [string[]]$RequiredCommandLineFragments = @()
    )

    $process = Get-ManagedProcess -PidFile $PidFile -AllowedNames $AllowedNames -RequiredCommandLineFragments $RequiredCommandLineFragments
    if ($null -ne $process) {
        Stop-Process -Id $process.Id -ErrorAction Stop
        $process.WaitForExit(10000) | Out-Null
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Write-JsonAtomically {
    param(
        [object]$Value,
        [string]$Destination
    )

    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $temporaryFile = Join-Path $parent (([System.IO.Path]::GetFileName($Destination)) + "." + [guid]::NewGuid().ToString("N") + ".tmp")
    $json = $Value | ConvertTo-Json -Depth 20
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    try {
        [System.IO.File]::WriteAllText($temporaryFile, $json + [Environment]::NewLine, $utf8WithoutBom)
        Move-Item -LiteralPath $temporaryFile -Destination $Destination -Force
    } finally {
        Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-ValidatedPublicUrl {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "The current public URL file was not found: $Path"
    }
    $url = (Get-Content -LiteralPath $Path -Raw).Trim()
    if (-not ($url -match "^https://[a-z0-9-]+\.trycloudflare\.com$")) {
        throw "The stored public URL is not a valid Cloudflare Quick Tunnel URL."
    }
    return $url
}

function Wait-ForOwnedListener {
    param(
        [int]$Port,
        [int]$ProcessId,
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 500
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $ProcessId } |
            Select-Object -First 1
        if ($null -ne $listener) {
            return $true
        }
    } while ((Get-Date) -lt $deadline -and -not $Process.HasExited)

    return $false
}

function Assert-PortAvailable {
    param([int]$Port)

    $occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $occupied) {
        throw "Port $Port is already in use by PID $($occupied.OwningProcess). Stop that process first."
    }
}

function Test-PublicMetadata {
    param(
        [string]$PublicUrl,
        [int]$TimeoutSeconds
    )

    $metadataUrl = "$PublicUrl/.well-known/oauth-protected-resource/mcp"
    $response = Invoke-WebRequest -Uri $metadataUrl -UseBasicParsing -TimeoutSec $TimeoutSeconds
    if ($response.StatusCode -ne 200) {
        throw "Public OAuth metadata check failed with HTTP $($response.StatusCode)."
    }
}

function Set-DevSpacePublicBaseUrl {
    param([string]$PublicUrl)

    & devspace config set publicBaseUrl $PublicUrl | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "DevSpace could not update publicBaseUrl."
    }
}

function Enter-LauncherMutex {
    param(
        [string]$Name,
        [int]$TimeoutSeconds = 5
    )

    $mutex = New-Object System.Threading.Mutex($false, "Local\DevSpaceOneClick-$Name")
    try {
        if (-not $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))) {
            $mutex.Dispose()
            throw "Another DevSpace One-Click operation is already running."
        }
    } catch [System.Threading.AbandonedMutexException] {
        # The previous process ended unexpectedly. Ownership is still granted.
    }
    return $mutex
}

function Exit-LauncherMutex {
    param([System.Threading.Mutex]$Mutex)

    if ($null -ne $Mutex) {
        try { $Mutex.ReleaseMutex() } catch { }
        $Mutex.Dispose()
    }
}
