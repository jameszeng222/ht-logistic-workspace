# HT Logistic Workspace - All-in-one installer build script (Windows PowerShell)
#
# Usage:
#   cd ht-logistic-workspace
#   .\scripts\build-installer.ps1
#
# Output (users just double-click to install, no Node.js/Python/Rust needed):
#   tauri-app\src-tauri\target\release\bundle\nsis\HT Logistic Agent_0.1.0_x64-setup.exe
#
# Steps:
#   1. Build Python sidecar (PyInstaller -> ht-sidecar.exe)
#   2. Prepare pi-runtime (download portable Node.js + npm install pi + generate pi.cmd)
#   3. npm install + npm run tauri build (bundle sidecar + pi-runtime together)
#   4. Print output paths

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sidecarDir = Join-Path $repoRoot "python-sidecar"
$tauriDir = Join-Path $repoRoot "tauri-app"
$piRuntimeDir = Join-Path $repoRoot "pi-runtime"

function Write-PiLauncher {
    param([Parameter(Mandatory = $true)][string]$RuntimeDir)

    $piCliJs = "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
    $piCliPath = Join-Path $RuntimeDir $piCliJs
    if (-not (Test-Path $piCliPath)) {
        throw "Pi CLI entry not found: $piCliPath"
    }

    $launcherLine = '"%PI_RUNTIME_DIR%node.exe" "%PI_RUNTIME_DIR%node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*'
    if ($launcherLine -match "[`r`n]") {
        throw "Internal error: pi.cmd launcher line contains a newline."
    }

    $piCmdContent = @(
        '@echo off',
        'setlocal',
        'set "PI_RUNTIME_DIR=%~dp0"',
        'set "PATH=%PI_RUNTIME_DIR%;%PATH%"',
        $launcherLine
    ) -join "`r`n"

    $piCmdPath = Join-Path $RuntimeDir "pi.cmd"
    [System.IO.File]::WriteAllText($piCmdPath, $piCmdContent + "`r`n", [System.Text.Encoding]::ASCII)
    Test-PiLauncher -RuntimeDir $RuntimeDir
}

function Test-PiLauncher {
    param([Parameter(Mandatory = $true)][string]$RuntimeDir)

    $piCmdPath = Join-Path $RuntimeDir "pi.cmd"
    $nodePath = Join-Path $RuntimeDir "node.exe"
    $piCliPath = Join-Path $RuntimeDir "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"

    if (-not (Test-Path $piCmdPath)) { throw "pi.cmd missing: $piCmdPath" }
    if (-not (Test-Path $nodePath)) { throw "node.exe missing: $nodePath" }
    if (-not (Test-Path $piCliPath)) { throw "Pi CLI entry missing: $piCliPath" }

    $lines = [System.IO.File]::ReadAllLines($piCmdPath, [System.Text.Encoding]::ASCII)
    $expected = '"%PI_RUNTIME_DIR%node.exe" "%PI_RUNTIME_DIR%node_modules\@earendil-works\pi-coding-agent\dist\cli.js" %*'
    if ($lines.Count -lt 5 -or $lines[4] -ne $expected) {
        throw "pi.cmd launcher is invalid. Expected one command line: $expected"
    }
}

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace Installer Build" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. Build Python sidecar ----------
Write-Host "[1/4] Building Python sidecar..." -ForegroundColor Yellow
Push-Location $sidecarDir
try {
    if (-not (Test-Path ".venv")) {
        Write-Host "  Creating venv..." -ForegroundColor Gray
        python -m venv .venv
    }
    & .\.venv\Scripts\Activate.ps1
    pip install -r requirements.txt --quiet
    pip install pyinstaller --quiet
    Write-Host "  Running PyInstaller..." -ForegroundColor Gray
    # PyInstaller writes INFO logs to stderr, which PowerShell treats as errors
    # (NativeCommandError). Route stdout+stderr to a log file via cmd.exe so we
    # can check $LASTEXITCODE and inspect the log if it fails.
    $pyinstallerLog = Join-Path $env:TEMP "ht-pyinstaller.log"
    cmd /c "pyinstaller ht-sidecar.spec --noconfirm --clean > `"$pyinstallerLog`" 2>&1"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "dist\ht-sidecar.exe")) {
        Write-Host "  PyInstaller log:" -ForegroundColor Red
        if (Test-Path $pyinstallerLog) {
            Get-Content $pyinstallerLog -Tail 50 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
            Write-Host "  Full log: $pyinstallerLog" -ForegroundColor Gray
        }
        throw "PyInstaller failed (exit code $LASTEXITCODE). See log above."
    }
    Copy-Item "dist\ht-sidecar.exe" "ht-sidecar.exe" -Force
    Write-Host "  sidecar exe ready" -ForegroundColor Green
}
finally {
    Pop-Location
}

# ---------- 2. Prepare pi-runtime (portable Node + pi package) ----------
Write-Host ""
Write-Host "[2/4] Preparing pi-runtime (portable Node.js + pi package)..." -ForegroundColor Yellow

if (Test-Path $piRuntimeDir) {
    # Use robocopy mirror trick for long-path safety (Remove-Item fails on >260 chars)
    $emptyTemp = Join-Path $env:TEMP "ht-empty-dir-for-mirror"
    New-Item -ItemType Directory -Path $emptyTemp -Force | Out-Null
    robocopy $emptyTemp $piRuntimeDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    Remove-Item $piRuntimeDir -Force -ErrorAction SilentlyContinue
    Remove-Item $emptyTemp -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $piRuntimeDir -Force | Out-Null

# 2a. Download portable Node.js (x64)
#     Use curl.exe (bundled on Windows 10+) for resume + auto retry,
#     more stable than Invoke-WebRequest (IWR often EOFs on flaky networks).
#     -L follow redirects, --retry auto retry, -C - resume, --connect-timeout timeout
$nodeVersion = "v22.20.0"
$nodeArch = "x64"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-$nodeArch.zip"
$nodeZip = Join-Path $env:TEMP "node-portable.zip"
$nodeExtractDir = Join-Path $env:TEMP "node-portable-extract"

Write-Host "  Downloading Node.js $nodeVersion (win-$nodeArch)..." -ForegroundColor Gray
if (Test-Path $nodeExtractDir) { Remove-Item $nodeExtractDir -Recurse -Force }

# Prefer curl.exe (most stable), fallback to Invoke-WebRequest
$curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlExe) {
    Write-Host "    using curl.exe with retry + resume..." -ForegroundColor Gray
    & curl.exe -L --retry 5 --retry-delay 3 --retry-connrefused `
        --connect-timeout 30 --max-time 600 `
        -C - -o "$nodeZip" "$nodeUrl"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $nodeZip)) {
        throw "curl download failed (exit $LASTEXITCODE). Manually download $nodeUrl to $nodeZip"
    }
} else {
    Write-Host "    curl.exe not found, falling back to Invoke-WebRequest..." -ForegroundColor Gray
    $downloaded = $false
    for ($i = 1; $i -le 3; $i++) {
        try {
            Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing -TimeoutSec 600
            $downloaded = $true
            break
        } catch {
            Write-Host "    IWR failed (attempt $i/3): $($_.Exception.Message)" -ForegroundColor Yellow
            if ($i -lt 3) { Start-Sleep -Seconds 3 }
        }
    }
    if (-not $downloaded) {
        throw "Node.js download failed (IWR retried 3 times). Manually download $nodeUrl to $nodeZip"
    }
}
Write-Host "    download complete" -ForegroundColor Gray

Expand-Archive -Path $nodeZip -DestinationPath $nodeExtractDir -Force
$nodeDir = Get-ChildItem -Path $nodeExtractDir -Directory | Select-Object -First 1
Copy-Item (Join-Path $nodeDir.FullName "node.exe") $piRuntimeDir -Force
Write-Host "  node.exe ready" -ForegroundColor Green

# 2b. Use portable node to run npm and install pi package
Write-Host "  Installing pi package into pi-runtime..." -ForegroundColor Gray
$npmCli = Join-Path $nodeDir.FullName "node_modules\npm\bin\npm-cli.js"
$pkgJson = @{ name = "pi-runtime"; version = "1.0.0"; private = $true } | ConvertTo-Json
Set-Content -Path (Join-Path $piRuntimeDir "package.json") -Value $pkgJson

Push-Location $piRuntimeDir
try {
    # npm writes progress/logs to stderr; route through cmd to a log file to
    # avoid NativeCommandError and surface diagnostics on failure.
    $npmLog = Join-Path $env:TEMP "ht-npm-install.log"
    $npmExe = Join-Path $piRuntimeDir "node.exe"
    cmd /c "`"$npmExe`" `"$npmCli`" install @earendil-works/pi-coding-agent --no-save --ignore-scripts > `"$npmLog`" 2>&1"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "node_modules\@earendil-works\pi-coding-agent")) {
        Write-Host "  npm install log:" -ForegroundColor Red
        if (Test-Path $npmLog) {
            Get-Content $npmLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
            Write-Host "  Full log: $npmLog" -ForegroundColor Gray
        }
        throw "pi package install failed (exit code $LASTEXITCODE). See log above."
    }
}
finally {
    Pop-Location
}
Write-Host "  pi package installed" -ForegroundColor Gray

# 2c. Generate pi.cmd launcher (calls portable node to run pi cli.js)
Write-PiLauncher -RuntimeDir $piRuntimeDir
Write-Host "  pi.cmd launcher generated and validated" -ForegroundColor Gray

# 2d. Clean up npm cache and non-runtime files to reduce size and avoid
#     NSIS path-too-long errors (aws-sdk .d.ts paths exceed Windows MAX_PATH).
#     Pi runs compiled .js via node.exe — .d.ts/.ts/.map/test files are dead weight.
Remove-Item (Join-Path $piRuntimeDir "package.json") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $piRuntimeDir "package-lock.json") -Force -ErrorAction SilentlyContinue

# Non-runtime file extensions (TypeScript declarations, source maps, docs, etc.)
$junkExts = @("*.md","*.markdown","*.map","*.d.ts","*.ts","*.flow","*.coffee","*.tsbuildinfo","*.text","*.txt")
foreach ($ext in $junkExts) {
    Get-ChildItem $piRuntimeDir -Recurse -Include $ext -File -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
}

# Junk directories (tests, docs, type defs, npm bin scripts, IDE configs)
$junkDirs = @("__tests__","__mocks__","tests","test","docs","documentation",".github",".bin",".vscode",".idea","coverage","node_modules/.cache")
foreach ($sub in $junkDirs) {
    $p = Join-Path $piRuntimeDir $sub
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}

# Remove @types packages entirely (TypeScript type definitions, not used at runtime)
Get-ChildItem (Join-Path $piRuntimeDir "node_modules\@types") -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# 2d-extra. Remove unused large dependencies to avoid NSIS MAX_PATH errors.
#   pi-coding-agent bundles many AI provider SDKs (mistralai, aws-sdk, etc.)
#   with deeply nested file paths. Our project only uses Claude (via Anthropic SDK),
#   so we can safely delete these unused provider SDKs.
#   File paths like @mistralai/mistralai/esm/models/operations/getchat...post.js
#   (95-char filename) cause NSIS to fail with MAX_PATH 260 limit.
#
#   NOTE: We only remove @mistralai (the worst offender with 95-char filenames).
#   Other SDKs (@aws-sdk etc.) have shorter paths and don't trigger NSIS limit,
#   so we keep them to avoid breaking pi-coding-agent's module resolution.
$unusedPackages = @(
    "@mistralai"           # Mistral AI SDK - not used (project uses Claude), worst path-length offender
)
foreach ($pkg in $unusedPackages) {
    $p = Join-Path $piRuntimeDir "node_modules\$pkg"
    if (Test-Path $p) {
        $size = [math]::Round((Get-ChildItem $p -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
        # Use robocopy mirror trick for long-path safety (Remove-Item fails on >260 chars
        # which is exactly the case for @mistralai's deeply nested files)
        $emptyTemp = Join-Path $env:TEMP "ht-empty-dir-for-mirror"
        New-Item -ItemType Directory -Path $emptyTemp -Force | Out-Null
        robocopy $emptyTemp $p /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
        Remove-Item $p -Force -ErrorAction SilentlyContinue
        Remove-Item $emptyTemp -Force -ErrorAction SilentlyContinue
        Write-Host "  removed unused package: $pkg (${size} MB)" -ForegroundColor Gray
    }
}

$runtimeSize = [math]::Round((Get-ChildItem $piRuntimeDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "  pi-runtime ready (about ${runtimeSize} MB after cleanup)" -ForegroundColor Green

# 2e. Copy pi-runtime to src-tauri/pi-runtime/ for Tauri to pick up via
#     relative path "pi-runtime/" in tauri.conf.json.
#     Tauri v2 resources config doesn't support Windows absolute paths (strips
#     drive letter), so we must use relative path. NSIS MAX_PATH risk is
#     mitigated by step 2d-extra (removed @mistralai with 95-char filenames).
$tauriSrcDir = Join-Path $tauriDir "src-tauri"
$repoPiRuntimeDir = Join-Path $tauriSrcDir "pi-runtime"

Write-Host "  Copying pi-runtime to src-tauri ($repoPiRuntimeDir)..." -ForegroundColor Gray
# Remove existing pi-runtime dir. Use robocopy mirror trick instead of Remove-Item
# because PowerShell Remove-Item uses ANSI Win32 APIs that fail on paths >260 chars
# (the very problem we're trying to solve). robocopy /MIR with an empty source
# effectively deletes all contents of the target while handling long paths.
if (Test-Path $repoPiRuntimeDir) {
    Write-Host "  cleaning existing pi-runtime dir (using robocopy for long-path safety)..." -ForegroundColor Gray
    $emptyTemp = Join-Path $env:TEMP "ht-empty-dir-for-mirror"
    New-Item -ItemType Directory -Path $emptyTemp -Force | Out-Null
    robocopy $emptyTemp $repoPiRuntimeDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    Remove-Item $repoPiRuntimeDir -Force -ErrorAction SilentlyContinue
    Remove-Item $emptyTemp -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $repoPiRuntimeDir -Force | Out-Null
# robocopy handles long paths better than Copy-Item; /MIR mirrors, /NFL /NDL no file/dir listing
robocopy $piRuntimeDir $repoPiRuntimeDir /MIR /NFL /NDL /NJH /NJS | Out-Null
# Verify the copy actually succeeded — robocopy can silently fail (e.g. source missing,
# permission denied) and leave $repoPiRuntimeDir empty, which then makes tauri build
# fail with the cryptic "resource path doesn't exist" error.
$piLauncherInRepo = Join-Path $repoPiRuntimeDir "pi.cmd"
if (-not (Test-Path $piLauncherInRepo)) {
    Write-Host "  [ERROR] robocopy failed to copy pi-runtime to src-tauri" -ForegroundColor Red
    Write-Host "  Source: $piRuntimeDir" -ForegroundColor Gray
    Write-Host "  Target: $repoPiRuntimeDir" -ForegroundColor Gray
    Write-Host "  Source exists: $(Test-Path $piRuntimeDir)" -ForegroundColor Gray
    Write-Host "  Target exists: $(Test-Path $repoPiRuntimeDir)" -ForegroundColor Gray
    if (Test-Path $piRuntimeDir) {
        Write-Host "  Source contents (first 10):" -ForegroundColor Gray
        Get-ChildItem $piRuntimeDir -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    }
    throw "robocopy failed: pi.cmd not found in $repoPiRuntimeDir after copy. See diagnostics above."
}
Test-PiLauncher -RuntimeDir $repoPiRuntimeDir
Write-Host "  src-tauri pi-runtime validated ($repoPiRuntimeDir)" -ForegroundColor Gray

# Check for any remaining paths that would exceed NSIS MAX_PATH 260 limit.
# NSIS builds in %TEMP%\nsiXXXX.tmp\ (~30 chars) + relative path from src-tauri.
# Warn (don't fail) on paths >220 chars to leave margin.
$longPaths = Get-ChildItem $repoPiRuntimeDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName.Length -gt 220 }
if ($longPaths) {
    Write-Host "  [WARN] Found $($longPaths.Count) files with paths >220 chars (NSIS may fail):" -ForegroundColor Yellow
    $longPaths | Select-Object -First 5 | ForEach-Object {
        Write-Host "    $($_.FullName.Length) chars: $($_.FullName)" -ForegroundColor Gray
    }
    Write-Host "  Consider removing more unused packages if NSIS fails." -ForegroundColor Yellow
} else {
    Write-Host "  no paths >220 chars (NSIS MAX_PATH safe)" -ForegroundColor Green
}

# ---------- 3. Clean sidecar temp + build Tauri installer ----------
Write-Host ""
Write-Host "[3/4] Cleaning + building Tauri installer..." -ForegroundColor Yellow
$cleanupDirs = @("build", "dist", "__pycache__", ".pytest_cache")
foreach ($d in $cleanupDirs) {
    $p = Join-Path $sidecarDir $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
Get-ChildItem $sidecarDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# ---------- 3. Clean sidecar temp + build Tauri installer ----------
Write-Host ""
Write-Host "[3/4] Cleaning + building Tauri installer..." -ForegroundColor Yellow

# 3a. Verify updater signing key is configured (required to generate .sig artifacts)
#     NOTE: Tauri v2 official env var names are TAURI_SIGNING_PRIVATE_KEY and
#     TAURI_SIGNING_PRIVATE_KEY_PASSWORD (see v2.tauri.app/reference/environment-variables).
#     Writing TAURI_PRIVATE_KEY won't work, .sig won't be generated.
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Host ""
    Write-Host "WARNING: TAURI_SIGNING_PRIVATE_KEY environment variable not set." -ForegroundColor Red
    Write-Host "  Without the signing key, the updater .sig file won't be generated," -ForegroundColor Yellow
    Write-Host "  and auto-update will fail signature verification." -ForegroundColor Yellow
    Write-Host "  Generate a key pair with:" -ForegroundColor Yellow
    Write-Host "    npm run tauri signer generate -- -w `$HOME/.tauri/ht-logistic.key" -ForegroundColor Gray
    Write-Host "  Then set before running this script:" -ForegroundColor Yellow
    Write-Host "    `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content `$HOME/.tauri/ht-logistic.key -Raw" -ForegroundColor Gray
    Write-Host "    `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'your-password-if-set'" -ForegroundColor Gray
    Write-Host "  Continuing build WITHOUT updater signature (auto-update disabled)..." -ForegroundColor Yellow
    Write-Host ""
}

$cleanupDirs = @("build", "dist", "__pycache__", ".pytest_cache")
foreach ($d in $cleanupDirs) {
    $p = Join-Path $sidecarDir $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
Get-ChildItem $sidecarDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

Push-Location $tauriDir
try {
    npm install --silent
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally {
    Pop-Location
}

# 3b. Clean up src-tauri/pi-runtime — it's now embedded in the NSIS installer,
#     no longer needed on disk. Removing it keeps the repo clean and avoids
#     accidental commits of this large directory.
#     Use robocopy mirror trick for long-path safety.
if (Test-Path $repoPiRuntimeDir) {
    $emptyTemp = Join-Path $env:TEMP "ht-empty-dir-for-mirror"
    New-Item -ItemType Directory -Path $emptyTemp -Force | Out-Null
    robocopy $emptyTemp $repoPiRuntimeDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    Remove-Item $repoPiRuntimeDir -Force -ErrorAction SilentlyContinue
    Remove-Item $emptyTemp -Force -ErrorAction SilentlyContinue
}

# ---------- 4. Generate latest.json + print upload checklist ----------
Write-Host ""
Write-Host "[4/4] Build complete! Generating updater manifest..." -ForegroundColor Green
$bundleDir = Join-Path $tauriDir "src-tauri\target\release\bundle\nsis"

# Locate the NSIS setup .exe (filename includes version + arch, e.g. "HT Logistic Agent_0.1.0_x64-setup.exe")
$setupExe = Get-ChildItem (Join-Path $bundleDir "*-setup.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setupExe) {
    throw "NSIS setup .exe not found in $bundleDir"
}
$setupSig = "$($setupExe.FullName).sig"

# Read app version from tauri.conf.json
$tauriConfPath = Join-Path $tauriDir "src-tauri\tauri.conf.json"
$tauriConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
$appVersion = $tauriConf.version

# GitHub Release asset URL pattern: releases/latest/download/<filename>
# The tag is set by the user when creating the release; the "latest" alias resolves to the most recent.
$repoOwner = "jameszeng222"
$repoName = "ht-logistic-workspace"
$setupUrl = "https://github.com/$repoOwner/$repoName/releases/latest/download/$($setupExe.Name)"

# Read signature content (single-line base64 + header)
$signature = ""
if (Test-Path $setupSig) {
    $signature = (Get-Content $setupSig -Raw).Trim()
} else {
    Write-Host "  WARNING: .sig file not found at $setupSig" -ForegroundColor Yellow
    Write-Host "  Auto-update will not work. Did you set TAURI_SIGNING_PRIVATE_KEY?" -ForegroundColor Yellow
}

# Build the updater manifest consumed by the client's check() call.
# Field names are dictated by the Tauri updater protocol:
#   version:  new version string
#   notes:    release notes (shown in the UI)
#   pub_date: ISO 8601 timestamp
#   platforms: per-target signature + download URL
#   "windows-x86_64" is the target key Tauri uses on x64 Windows.
$releaseNotes = "HT Logistic Agent v$appVersion. See GitHub Release for details."
$latestJson = @{
    version = $appVersion
    notes = $releaseNotes
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = @{
        "windows-x86_64" = @{
            signature = $signature
            url = $setupUrl
        }
    }
} | ConvertTo-Json -Depth 5

$latestJsonPath = Join-Path $bundleDir "latest.json"
# Use .NET API to write UTF-8 without BOM (PowerShell 5.x Set-Content -Encoding UTF8
# adds BOM, Tauri updater uses serde_json which rejects UTF-8 BOM, causing
# "error decoding response body". Must use UTF8Encoding($false) to explicitly disable BOM.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($latestJsonPath, $latestJson, $utf8NoBom)

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Build artifacts ready" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Upload these 3 files to a new GitHub Release:" -ForegroundColor Yellow
Write-Host ""
$filesToUpload = @($setupExe.FullName, $setupSig, $latestJsonPath)
foreach ($f in $filesToUpload) {
    if (Test-Path $f) {
        $size = [math]::Round((Get-Item $f).Length / 1MB, 1)
        Write-Host "  $f  (${size} MB)" -ForegroundColor White
    } else {
        Write-Host "  $f  (MISSING!)" -ForegroundColor Red
    }
}
Write-Host ""
Write-Host "Release steps:" -ForegroundColor Cyan
Write-Host "  1. Tag: v$appVersion  (must match version in tauri.conf.json)" -ForegroundColor Gray
Write-Host "  2. Title: HT Logistic Agent v$appVersion" -ForegroundColor Gray
Write-Host "  3. Attach the 3 files above" -ForegroundColor Gray
Write-Host "  4. Publish release" -ForegroundColor Gray
Write-Host ""
Write-Host "Client endpoint (already configured in tauri.conf.json):" -ForegroundColor Cyan
Write-Host "  https://github.com/$repoOwner/$repoName/releases/latest/download/latest.json" -ForegroundColor Gray
Write-Host ""
Write-Host "Users: just double-click the .exe to install. No Node.js/Python/Rust needed." -ForegroundColor Green
