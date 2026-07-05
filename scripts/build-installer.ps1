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
    pyinstaller ht-sidecar.spec --noconfirm --clean 2>&1 | Out-Null
    if (-not (Test-Path "dist\ht-sidecar.exe")) {
        throw "PyInstaller failed: dist\ht-sidecar.exe not found"
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
    Remove-Item $piRuntimeDir -Recurse -Force
}
New-Item -ItemType Directory -Path $piRuntimeDir -Force | Out-Null

# 2a. Download portable Node.js (x64)
$nodeVersion = "v22.20.0"
$nodeArch = "x64"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-$nodeArch.zip"
$nodeZip = Join-Path $env:TEMP "node-portable.zip"
$nodeExtractDir = Join-Path $env:TEMP "node-portable-extract"

Write-Host "  Downloading Node.js $nodeVersion (win-$nodeArch)..." -ForegroundColor Gray
if (Test-Path $nodeExtractDir) { Remove-Item $nodeExtractDir -Recurse -Force }
Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
Expand-Archive -Path $nodeZip -DestinationPath $nodeExtractDir -Force
$nodeDir = Get-ChildItem -Path $nodeExtractDir -Directory | Select-Object -First 1
Copy-Item (Join-Path $nodeDir.FullName "node.exe") $piRuntimeDir -Force
Write-Host "  node.exe ready" -ForegroundColor Gray

# 2b. Use portable node to run npm and install pi package
Write-Host "  Installing pi package into pi-runtime..." -ForegroundColor Gray
$npmCli = Join-Path $nodeDir.FullName "node_modules\npm\bin\npm-cli.js"
$pkgJson = @{ name = "pi-runtime"; version = "1.0.0"; private = $true } | ConvertTo-Json
Set-Content -Path (Join-Path $piRuntimeDir "package.json") -Value $pkgJson

Push-Location $piRuntimeDir
try {
    & (Join-Path $piRuntimeDir "node.exe") $npmCli install "@earendil-works/pi-coding-agent" --no-save --ignore-scripts 2>&1 | Out-Null
    if (-not (Test-Path "node_modules\@earendil-works\pi-coding-agent")) {
        throw "pi package install failed"
    }
}
finally {
    Pop-Location
}
Write-Host "  pi package installed" -ForegroundColor Gray

# 2c. Generate pi.cmd launcher (calls portable node to run pi cli.js)
#     NOTE: here-string @"..."@ must have "@" at start of its own line.
$piCliJs = "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
$piCmdLines = @(
    '@echo off',
    'setlocal',
    'set "PI_RUNTIME_DIR=%~dp0"',
    'set "PATH=%PI_RUNTIME_DIR%;%PATH%"',
    '"%PI_RUNTIME_DIR%node.exe" "%PI_RUNTIME_DIR%' + $piCliJs + '" %*'
)
$piCmdContent = $piCmdLines -join "`r`n"
Set-Content -Path (Join-Path $piRuntimeDir "pi.cmd") -Value $piCmdContent -Encoding ASCII
Write-Host "  pi.cmd launcher generated" -ForegroundColor Gray

# 2d. Clean up npm cache and non-runtime files to reduce size
Remove-Item (Join-Path $piRuntimeDir "package.json") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $piRuntimeDir "package-lock.json") -Force -ErrorAction SilentlyContinue
Get-ChildItem $piRuntimeDir -Recurse -Include "*.md","*.map","*.markdown" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

$runtimeSize = [math]::Round((Get-ChildItem $piRuntimeDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "  pi-runtime ready (about ${runtimeSize} MB)" -ForegroundColor Green

# ---------- 3. Clean sidecar temp + build Tauri installer ----------
Write-Host ""
Write-Host "[3/4] Cleaning + building Tauri installer..." -ForegroundColor Yellow
$cleanupDirs = @("build", "dist", "__pycache__", ".pytest_cache")
foreach ($d in $cleanupDirs) {
    $p = Join-Path $sidecarDir $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Get-ChildItem $sidecarDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

Push-Location $tauriDir
try {
    npm install --silent
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally {
    Pop-Location
}

# ---------- 4. Print output paths ----------
Write-Host ""
Write-Host "[4/4] Build complete!" -ForegroundColor Green
$bundleDir = Join-Path $tauriDir "src-tauri\target\release\bundle"
Write-Host ""
Write-Host "Output:" -ForegroundColor Cyan
if (Test-Path (Join-Path $bundleDir "nsis")) {
    Get-ChildItem (Join-Path $bundleDir "nsis\*.exe") | ForEach-Object {
        $size = [math]::Round($_.Length / 1MB, 1)
        Write-Host "  NSIS installer: $($_.FullName) (${size} MB)" -ForegroundColor White
    }
}
if (Test-Path (Join-Path $bundleDir "msi")) {
    Get-ChildItem (Join-Path $bundleDir "msi\*.msi") | ForEach-Object {
        $size = [math]::Round($_.Length / 1MB, 1)
        Write-Host "  MSI installer:  $($_.FullName) (${size} MB)" -ForegroundColor White
    }
}
Write-Host ""
Write-Host "Users just double-click the .exe to install. No Node.js/Python/Rust needed." -ForegroundColor Cyan
