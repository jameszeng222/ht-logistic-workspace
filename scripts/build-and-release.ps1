# HT Logistic Workspace - One-click build + release script
#
# Automates: version bump, signing env vars, build, verify, print upload checklist
#
# Usage:
#   cd ht-logistic-workspace
#   .\scripts\build-and-release.ps1
#
# Optional params:
#   -Version 0.1.3          Specify version (default: auto +0.0.1)
#   -SkipVersionBump        Don't bump version, use current
#   -KeyPath "C:\Users\HT\.tauri\ht-logistic.key"
#   -KeyPassword "123"
#
# Prerequisites:
#   1. Rust + Node.js + Python installed (dev environment)
#   2. Signing private key at C:\Users\HT\.tauri\ht-logistic.key (password 123)
#   3. Code already pulled to latest (git pull origin main)

param(
    [string]$Version = "",
    [switch]$SkipVersionBump,
    [string]$KeyPath = "$env:USERPROFILE\.tauri\ht-logistic.key",
    [string]$KeyPassword = "123"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriConfPath = Join-Path $repoRoot "tauri-app\src-tauri\tauri.conf.json"

# ========== Helper functions ==========

function Write-Step {
    param([string]$msg)
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
}

function Write-OK {
    param([string]$msg)
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn {
    param([string]$msg)
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$msg)
    Write-Host "  [ERROR] $msg" -ForegroundColor Red
}

# ========== 0. Pre-checks ==========

Write-Step "Step 0: Pre-checks"

# 0a. Check repo root
if (-not (Test-Path $tauriConfPath)) {
    Write-Err "tauri.conf.json not found, please run this script from repo root"
    Write-Host "  Current dir: $(Get-Location)"
    Write-Host "  Expected: $tauriConfPath"
    exit 1
}
Write-OK "In repo root"

# 0b. Check signing key
if (-not (Test-Path $KeyPath)) {
    Write-Err "Signing key not found: $KeyPath"
    Write-Host "  Use -KeyPath to specify the key path"
    exit 1
}
Write-OK "Signing key exists: $KeyPath"

# 0c. Check current version
$tauriConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
$currentVersion = $tauriConf.version
Write-OK "Current version: $currentVersion"

# 0d. Check git status
#     Use cmd /c to avoid PowerShell NativeCommandError on git's stderr output
$gitStatus = (& cmd /c "git status --porcelain 2>&1") | Out-String
if ($gitStatus.Trim()) {
    Write-Warn "Git has uncommitted changes:"
    Write-Host $gitStatus
    $continue = Read-Host "  Continue? (y/N)"
    if ($continue -ne 'y') { exit 1 }
}

# 0e. Check remote sync
#     Git writes progress/info to stderr (not stdout), which PowerShell treats
#     as a native command error under $ErrorActionPreference="Stop". Wrap git
#     calls with 2>&1 and capture output, or use cmd /c to avoid the issue.
Write-Host "  Checking remote sync..."
$fetchOutput = & cmd /c "git fetch origin main 2>&1" | Out-String
$localCommit = (& cmd /c "git rev-parse HEAD 2>&1").Trim()
$remoteCommit = (& cmd /c "git rev-parse origin/main 2>&1").Trim()
if ($localCommit -ne $remoteCommit) {
    Write-Warn "Local and remote differ, recommend: git pull origin main"
    Write-Host "  Local:  $localCommit"
    Write-Host "  Remote: $remoteCommit"
    $continue = Read-Host "  Continue? (y/N)"
    if ($continue -ne 'y') { exit 1 }
} else {
    Write-OK "Local is up to date"
}

# ========== 1. Bump version ==========

if ($SkipVersionBump) {
    $newVersion = $currentVersion
    Write-Step "Step 1: Skip version bump (using $newVersion)"
} else {
    if ($Version) {
        $newVersion = $Version
    } else {
        # Auto +0.0.1
        $parts = $currentVersion.Split('.')
        $patch = [int]$parts[2] + 1
        $newVersion = "$($parts[0]).$($parts[1]).$patch"
    }

    Write-Step "Step 1: Bump version $currentVersion -> $newVersion"

    $content = Get-Content $tauriConfPath -Raw
    $newContent = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
    Set-Content -Path $tauriConfPath -Value $newContent -NoNewline

    # Verify
    $verifyConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
    if ($verifyConf.version -ne $newVersion) {
        Write-Err "Version write failed, expected $newVersion, got $($verifyConf.version)"
        exit 1
    }
    Write-OK "Version updated: $newVersion"

    # Commit the version bump so repo version stays in sync with built/released version.
    # Without this, local tauri.conf.json has the new version but remote doesn't,
    # causing "版本对不上" confusion on next pull/build.
    & cmd /c "git add tauri-app/src-tauri/tauri.conf.json 2>&1" | Out-Null
    & cmd /c "git -c user.name='trae-agent' -c user.email='agent@trae.local' commit -m `"chore: bump version to $newVersion`" 2>&1" | Out-Null
    Write-OK "Version bump committed locally (not pushed — will push after build succeeds)"
}

# ========== 2. Set signing env vars ==========

Write-Step "Step 2: Set signing env vars"

# Private key content (-Raw reads whole file as string, preserves newlines)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $KeyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeyPassword

# Verify
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Err "TAURI_SIGNING_PRIVATE_KEY not set"
    exit 1
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY.StartsWith("untrusted comment")) {
    Write-Warn "Key first 30 chars: $($env:TAURI_SIGNING_PRIVATE_KEY.Substring(0, [Math]::Min(30, $env:TAURI_SIGNING_PRIVATE_KEY.Length)))"
    Write-Warn "Key should start with 'untrusted comment', may be format issue"
}
Write-OK "TAURI_SIGNING_PRIVATE_KEY set (length: $($env:TAURI_SIGNING_PRIVATE_KEY.Length))"
Write-OK "TAURI_SIGNING_PRIVATE_KEY_PASSWORD set (length: $($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD.Length))"

# ========== 3. Run build script ==========

Write-Step "Step 3: Building (calling build-installer.ps1)"
Write-Host "  This takes about 5-15 minutes, please wait..." -ForegroundColor Gray
Write-Host "  Includes: PyInstaller + Node.js download + pi install + Tauri build + NSIS" -ForegroundColor Gray

$buildScript = Join-Path $PSScriptRoot "build-installer.ps1"
if (-not (Test-Path $buildScript)) {
    Write-Err "Build script not found: $buildScript"
    exit 1
}

& $buildScript
if ($LASTEXITCODE -ne 0) {
    Write-Err "Build failed (exit code $LASTEXITCODE)"
    exit 1
}

# ========== 4. Verify artifacts ==========

Write-Step "Step 4: Verify build artifacts"

$bundleDir = Join-Path $repoRoot "tauri-app\src-tauri\target\release\bundle\nsis"
if (-not (Test-Path $bundleDir)) {
    Write-Err "Bundle dir not found: $bundleDir"
    exit 1
}

# 4a. Check 3 required files
$setupExe = Get-ChildItem (Join-Path $bundleDir "*-setup.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setupExe) {
    Write-Err "setup.exe not found"
    exit 1
}
$setupSizeMB = [math]::Round($setupExe.Length / 1MB, 1)
Write-OK "setup.exe: $($setupExe.Name) ($setupSizeMB MB)"

$setupSig = "$($setupExe.FullName).sig"
if (-not (Test-Path $setupSig)) {
    Write-Err ".sig file not found: $setupSig"
    Write-Host "  Usually because TAURI_SIGNING_PRIVATE_KEY env var not set correctly"
    exit 1
}
$sigSize = (Get-Item $setupSig).Length
$sigSizeKB = [math]::Round($sigSize / 1KB, 1)
Write-OK ".sig file: $sigSizeKB KB"

$latestJsonPath = Join-Path $bundleDir "latest.json"
if (-not (Test-Path $latestJsonPath)) {
    Write-Err "latest.json not found"
    exit 1
}
Write-OK "latest.json exists"

# 4b. Check latest.json has no BOM
$bytes = [System.IO.File]::ReadAllBytes($latestJsonPath)
$first3 = "$($bytes[0]),$($bytes[1]),$($bytes[2])"
if ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    Write-Err "latest.json has UTF-8 BOM (EF BB BF), Tauri updater will fail to parse!"
    Write-Host "  First 3 bytes: $first3 (239,187,191 = BOM)"
    exit 1
} else {
    Write-OK "latest.json no BOM (first 3 bytes: $first3)"
}

# 4c. Verify latest.json JSON parsing
try {
    $jsonContent = [System.IO.File]::ReadAllText($latestJsonPath)
    $json = $jsonContent | ConvertFrom-Json
    if ($json.version -ne $newVersion) {
        Write-Err "latest.json version mismatch: expected $newVersion, got $($json.version)"
        exit 1
    }
    if (-not $json.platforms.'windows-x86_64'.signature) {
        Write-Err "latest.json signature field empty"
        exit 1
    }
    if (-not $json.platforms.'windows-x86_64'.url) {
        Write-Err "latest.json url field empty"
        exit 1
    }
    Write-OK "latest.json JSON parsed successfully"
    Write-OK "  version: $($json.version)"
    Write-OK "  pub_date: $($json.pub_date)"
    Write-OK "  signature length: $($json.platforms.'windows-x86_64'.signature.Length)"
    Write-OK "  url: $($json.platforms.'windows-x86_64'.url)"
} catch {
    Write-Err "latest.json JSON parse failed: $_"
    exit 1
}

# 4d. Verify signature is valid base64
$sig = $json.platforms.'windows-x86_64'.signature
try {
    $sigBytes = [System.Convert]::FromBase64String($sig)
    $sigText = [System.Text.Encoding]::UTF8.GetString($sigBytes)
    if ($sigText -match 'trusted comment: signature from tauri secret key') {
        Write-OK "signature decodes to valid Tauri signature"
    } else {
        Write-Warn "signature decoded content:"
        Write-Host $sigText
    }
} catch {
    Write-Err "signature is not valid base64: $_"
    exit 1
}

# ========== 5. Print upload checklist ==========

Write-Step "Step 5: Build complete! Upload checklist"

Write-Host ""
Write-Host "3 files to upload to GitHub Release:" -ForegroundColor Yellow
Write-Host ""

$filesToUpload = @(
    @{ Path = $setupExe.FullName; Desc = "Installer" },
    @{ Path = $setupSig; Desc = "Signature" },
    @{ Path = $latestJsonPath; Desc = "Manifest" }
)

foreach ($f in $filesToUpload) {
    if (Test-Path $f.Path) {
        $size = [math]::Round((Get-Item $f.Path).Length / 1MB, 2)
        Write-Host "  [$($f.Desc)] $f.Path" -ForegroundColor White
        Write-Host "          Size: $size MB" -ForegroundColor Gray
    } else {
        Write-Host "  [$($f.Desc)] $f.Path  (MISSING!)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "GitHub Release steps:" -ForegroundColor Cyan
Write-Host "  1. Open: https://github.com/jameszeng222/ht-logistic-workspace/releases/new" -ForegroundColor Gray
Write-Host "  2. Tag: v$newVersion  (must match version)" -ForegroundColor Gray
Write-Host "  3. Title: HT Logistic Agent v$newVersion" -ForegroundColor Gray
Write-Host "  4. Upload the 3 files above" -ForegroundColor Gray
Write-Host "  5. Publish release" -ForegroundColor Gray
Write-Host ""
Write-Host "After publish, client 'Check for updates' will get the new version." -ForegroundColor Green
Write-Host ""

# 5a. Auto open bundle folder
$openFolder = Read-Host "Open bundle folder in explorer? (Y/n)"
if ($openFolder -ne 'n') {
    Start-Process explorer.exe -ArgumentList $bundleDir
}

# 5b. Auto open GitHub Release page
$openGitHub = Read-Host "Open GitHub Release create page? (Y/n)"
if ($openGitHub -ne 'n') {
    Start-Process "https://github.com/jameszeng222/ht-logistic-workspace/releases/new"
}

# 5c. Push version bump commit to remote (so repo version stays in sync).
#     Ask before pushing — user may want to verify build first.
if (-not $SkipVersionBump) {
    $doPush = Read-Host "Push version bump commit to remote? (y/N)"
    if ($doPush -eq 'y') {
        Write-Host "Pushing version bump commit..." -ForegroundColor Gray
        & cmd /c "git push origin main 2>&1" | Out-String | Write-Host
        if ($LASTEXITCODE -eq 0) {
            Write-OK "Version bump pushed. Repo now in sync with released v$newVersion."
        } else {
            Write-Warn "Push failed (exit $LASTEXITCODE). Push manually after upload: git push origin main"
        }
    } else {
        Write-Host "  Skipped push. Remember to push manually:" -ForegroundColor Yellow
        Write-Host "    git push origin main" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  All done!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
