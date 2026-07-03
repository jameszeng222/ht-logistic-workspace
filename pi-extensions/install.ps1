# HT Logistic Workspace - Pi Extension installer
#
# Usage (in pi-extensions directory):
#   .\install.ps1
#
# This script will:
#   1. Locate ~/.pi/agent/extensions/ (create if missing)
#   2. Copy all-in-one.ts there (overwrite)
#   3. Ensure package.json exists in target dir (npm init -y if missing)
#   4. Install native deps (better-sqlite3, pdf-parse) IN the target dir
#      (Pi loads extension from ~/.pi/agent/extensions/, so node_modules
#       must live there, not in the source repo)
#   5. Deploy pi-agent-config (SYSTEM.md + skills/) to ~/.pi/agent/
#      (SYSTEM.md defines permission tiers; skills/ define per-domain workflows)
#   6. Print verification steps
#
# Why a dedicated installer:
#   Pi 用 jiti 加载 ~/.pi/agent/extensions/all-in-one.ts，Node 模块查找从
#   扩展文件所在目录向上找 node_modules。若依赖装在源码仓库 pi-extensions/
#   下，Pi 加载时找不到，扩展会报 Cannot find module 'better-sqlite3'。
#   所以必须把依赖装到 ~/.pi/agent/extensions/ 本地。

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Pi Extension Installer (all-in-one)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============ 0. Resolve source file ============
$srcFile = Join-Path $PSScriptRoot "all-in-one.ts"
if (-not (Test-Path $srcFile)) {
    Write-Host "ERROR: all-in-one.ts not found next to install.ps1 (looked: $srcFile)" -ForegroundColor Red
    Write-Host "Run this script from the pi-extensions directory." -ForegroundColor Red
    exit 1
}

# ============ 1. Resolve target dir ~/.pi/agent/extensions/ ============
$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = $env:HOME }
if (-not $homeDir) {
    Write-Host "ERROR: cannot resolve user home (USERPROFILE/HOME unset)" -ForegroundColor Red
    exit 1
}
$piAgentDir = Join-Path $homeDir ".pi\agent"
$extDir = Join-Path $piAgentDir "extensions"

Write-Host "[1/5] Target dir: $extDir" -ForegroundColor Yellow
if (-not (Test-Path $extDir)) {
    New-Item -ItemType Directory -Path $extDir -Force | Out-Null
    Write-Host "OK: created (was missing — extension was never installed before)" -ForegroundColor Green
} else {
    Write-Host "OK: exists" -ForegroundColor Green
}

# ============ 2. Copy all-in-one.ts ============
Write-Host "[2/5] Copying all-in-one.ts ..." -ForegroundColor Yellow
Copy-Item -Path $srcFile -Destination (Join-Path $extDir "all-in-one.ts") -Force
Write-Host "OK: copied (overwrote existing)" -ForegroundColor Green

# ============ 3. Ensure package.json in target dir ============
Write-Host "[3/5] Ensuring package.json in target dir ..." -ForegroundColor Yellow
$pkgJson = Join-Path $extDir "package.json"
if (-not (Test-Path $pkgJson)) {
    Push-Location $extDir
    try {
        npm init -y
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: npm init failed" -ForegroundColor Red
            exit 1
        }
    } finally { Pop-Location }
    Write-Host "OK: package.json created" -ForegroundColor Green
} else {
    Write-Host "OK: package.json already exists (kept)" -ForegroundColor Green
}

# ============ 4. Install native deps IN target dir ============
Write-Host "[4/5] Installing native deps in target dir ..." -ForegroundColor Yellow
Write-Host "  (better-sqlite3, pdf-parse — must live in ~/.pi/agent/extensions/node_modules)" -ForegroundColor Gray
Push-Location $extDir
try {
    npm install better-sqlite3@^11.3.0 pdf-parse@^1.1.1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed. Check network / node version." -ForegroundColor Red
        exit 1
    }
} finally { Pop-Location }
Write-Host "OK: deps installed" -ForegroundColor Green

# ============ 5. Deploy agent config (SYSTEM.md + skills/) ============
Write-Host "[5/6] Deploying agent config (SYSTEM.md + skills/) ..." -ForegroundColor Yellow
$agentConfigDir = Join-Path $PSScriptRoot "..\pi-agent-config"
if (Test-Path $agentConfigDir) {
    # SYSTEM.md -> ~/.pi/agent/SYSTEM.md
    $systemMd = Join-Path $agentConfigDir "SYSTEM.md"
    if (Test-Path $systemMd) {
        Copy-Item -Path $systemMd -Destination (Join-Path $piAgentDir "SYSTEM.md") -Force
        Write-Host "  OK: SYSTEM.md deployed" -ForegroundColor Green
    }
    # skills/ -> ~/.pi/agent/skills/
    $skillsSrc = Join-Path $agentConfigDir "skills"
    $skillsDst = Join-Path $piAgentDir "skills"
    if (Test-Path $skillsSrc) {
        if (-not (Test-Path $skillsDst)) {
            New-Item -ItemType Directory -Path $skillsDst -Force | Out-Null
        }
        Get-ChildItem -Path $skillsSrc -Filter "*.md" | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination (Join-Path $skillsDst $_.Name) -Force
        }
        Write-Host "  OK: skills/ deployed ($(@(Get-ChildItem -Path $skillsSrc -Filter '*.md')).Count files)" -ForegroundColor Green
    }
} else {
    Write-Host "  SKIP: pi-agent-config/ not found (skipping config deploy)" -ForegroundColor Yellow
}

# ============ 6. Verify ============
Write-Host "[6/6] Verifying ..." -ForegroundColor Yellow
$installedTs = Join-Path $extDir "all-in-one.ts"
$nodeModules = Join-Path $extDir "node_modules"
$bsql = Join-Path $nodeModules "better-sqlite3"
$pdfp = Join-Path $nodeModules "pdf-parse"
$allOk = $true
foreach ($p in @($installedTs, $bsql, $pdfp)) {
    if (Test-Path $p) {
        Write-Host "  [OK] $p" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $p" -ForegroundColor Red
        $allOk = $false
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
if ($allOk) {
    Write-Host "  Install Complete!" -ForegroundColor Green
} else {
    Write-Host "  Install finished with warnings (see MISSING above)" -ForegroundColor Yellow
}
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Installed to: $extDir" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Restart Pi (or Tauri app) so it reloads extension + SYSTEM.md + skills" -ForegroundColor White
Write-Host "  2. In Pi, ask: 'list the tools you can call'" -ForegroundColor White
Write-Host "     You should see logistic_* tools (invoice_packing, customs_generator," -ForegroundColor White
Write-Host "     customs_extractor, data_analysis, list_tools)" -ForegroundColor White
Write-Host "  3. Try: 'analyze C:\path\to\data.xlsx'" -ForegroundColor White
Write-Host "     Pi should call logistic_data_analysis directly (no asking permission)" -ForegroundColor White
Write-Host "  4. Permission mode: toggle in Tauri Settings > 工具权限模式" -ForegroundColor White
Write-Host "     - Standard: only delete/external-write/script executions prompt" -ForegroundColor White
Write-Host "     - Full Trust: all tool calls auto-approved, zero interruption" -ForegroundColor White
Write-Host ""
Write-Host "Note: Make sure Tauri app is running so the Python sidecar (port 8000)" -ForegroundColor Gray
Write-Host "      is up — logistic_* tools call it over HTTP." -ForegroundColor Gray
Write-Host ""
