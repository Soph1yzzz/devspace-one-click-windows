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
$cli = Resolve-DevSpaceCli

$tunnel = Get-ManagedProcess `
    -PidFile $Paths.TunnelPidFile `
    -AllowedNames @("cloudflared") `
    -RequiredCommandLineFragments @("tunnel", "--url", "127.0.0.1:$($Settings.Port)")
$server = Get-ManagedProcess `
    -PidFile $Paths.DevSpacePidFile `
    -AllowedNames @("node") `
    -RequiredCommandLineFragments @($cli.CliPath, "serve")

if ($null -ne $tunnel -and $null -ne $server) {
    Write-Host "DevSpace is already running. Keeping the current URL." -ForegroundColor Green
    & $Controller status
    exit $LASTEXITCODE
}

Write-Host "DevSpace is not fully running. Starting a new Cloudflare Quick Tunnel..." -ForegroundColor Yellow
& $Controller start
exit $LASTEXITCODE
