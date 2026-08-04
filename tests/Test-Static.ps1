$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Root = Split-Path -Parent $PSScriptRoot
$PowerShellFiles = Get-ChildItem -LiteralPath $Root -Filter "*.ps1" -File -Recurse
$CmdFiles = Get-ChildItem -LiteralPath $Root -Filter "*.cmd" -File

$failed = $false
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        Write-Host "FAIL: $Message" -ForegroundColor Red
        $script:failed = $true
    } else {
        Write-Host "PASS: $Message" -ForegroundColor Green
    }
}

foreach ($file in $PowerShellFiles) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    Assert-True ($errors.Count -eq 0) "PowerShell parses: $($file.FullName.Substring($Root.Length + 1))"
}

foreach ($file in $CmdFiles) {
    $content = Get-Content -LiteralPath $file.FullName -Raw
    Assert-True ($content -match 'powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0') "CMD uses script-relative path: $($file.Name)"
}

$Common = Join-Path $Root "devspace-common.ps1"
. $Common

$settings = Get-LauncherSettings -ScriptRoot $Root
Assert-True ($settings.Port -ge 1 -and $settings.Port -le 65535) "Default port is valid"

$cli = Resolve-DevSpaceCli
Assert-True (Test-Path -LiteralPath $cli.CliPath -PathType Leaf) "DevSpace CLI is resolved from package metadata"
Assert-True (-not [string]::IsNullOrWhiteSpace($cli.Version)) "DevSpace version is available"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("devspace-one-click-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $jsonFile = Join-Path $tempRoot "config.json"
    Write-JsonAtomically -Value ([pscustomobject]@{ allowedRoots = @("C:\example") }) -Destination $jsonFile
    $roundTrip = Get-Content -LiteralPath $jsonFile -Raw | ConvertFrom-Json
    Assert-True (@($roundTrip.allowedRoots).Count -eq 1) "Atomic JSON write produces readable config"

    $urlFile = Join-Path $tempRoot "public-url.txt"
    Set-Content -LiteralPath $urlFile -Value "https://valid-example.trycloudflare.com" -Encoding ascii
    Assert-True ((Get-ValidatedPublicUrl -Path $urlFile) -eq "https://valid-example.trycloudflare.com") "Valid Quick Tunnel URL is accepted"

    Set-Content -LiteralPath $urlFile -Value "https://example.com" -Encoding ascii
    $rejected = $false
    try { Get-ValidatedPublicUrl -Path $urlFile | Out-Null } catch { $rejected = $true }
    Assert-True $rejected "Non-Quick-Tunnel URL is rejected"
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$secretPatterns = @(
    'ghp_[A-Za-z0-9]+',
    'github_pat_[A-Za-z0-9_]+',
    'sk-[A-Za-z0-9]+',
    'AKIA[0-9A-Z]{16}',
    '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
)
$secretHits = @()
foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object { $_.FullName -notmatch '\\.git\\' }) {
    $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    foreach ($pattern in $secretPatterns) {
        if ($content -match $pattern) {
            $secretHits += "$($file.FullName): $pattern"
        }
    }
}
Assert-True ($secretHits.Count -eq 0) "No common secret patterns found"

$absoluteUserPathHits = @(Select-String -Path (Get-ChildItem -LiteralPath $Root -File -Recurse).FullName -Pattern 'C:\\Users\\' -AllMatches -ErrorAction SilentlyContinue)
Assert-True ($absoluteUserPathHits.Count -eq 0) "No user-specific absolute paths found"

if ($failed) {
    exit 1
}
Write-Host "All static and isolated checks passed." -ForegroundColor Cyan
