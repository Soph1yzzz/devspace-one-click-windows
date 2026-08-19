$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Common = Join-Path $PSScriptRoot "devspace-common.ps1"
$Controller = Join-Path $PSScriptRoot "devspace-control.ps1"
$SessionGuardScript = Join-Path $PSScriptRoot "session-guard.mjs"
if (-not (Test-Path -LiteralPath $Common -PathType Leaf)) {
    throw "Required helper was not found: $Common"
}
if (-not (Test-Path -LiteralPath $Controller -PathType Leaf)) {
    throw "Required controller was not found: $Controller"
}
if (-not (Test-Path -LiteralPath $SessionGuardScript -PathType Leaf)) {
    throw "Required SessionGuard was not found: $SessionGuardScript"
}
. $Common

Assert-WindowsHost

# Keep start-devspace.cmd as the only normal entry point. The controller's ensure
# action repairs only the missing layer when possible, preserving the current
# Quick Tunnel URL and SessionGuard mappings instead of rebuilding everything.
& $Controller ensure
exit $LASTEXITCODE
