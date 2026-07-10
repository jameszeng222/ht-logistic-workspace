# HT Logistic Workspace - One-click dev launcher
#
# Usage (from repo root):
#   .\dev.ps1
#
# This script will:
#   1. Check python-sidecar/.venv exists (else prompt to run setup.ps1 first)
#   2. Start Python sidecar in background (uvicorn, port 8000)
#   3. Wait for sidecar health check to pass
#   4. Start Tauri dev in foreground (npm run tauri dev)
#   5. Auto-kill sidecar when Tauri exits
#
# Stop: Ctrl+C on Tauri, sidecar will be cleaned up automatically.

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarDir = Join-Path $RepoRoot "python-sidecar"
$TauriDir = Join-Path $RepoRoot "tauri-app"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace - Dev Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ============ Check venv ============
$venvPython = Join-Path $SidecarDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "ERROR: python-sidecar\.venv not found." -ForegroundColor Red
    Write-Host "Run setup first:  cd python-sidecar; .\setup.ps1" -ForegroundColor Yellow
    exit 1
}

# ============ Ensure pi-runtime.7z placeholder exists (dev mode) ============
# tauri.conf.json declares "pi-runtime.7z" as a resource, so Tauri's build
# script checks the file exists at compile time. In dev mode the real 7z is
# not built (only build-installer.ps1 creates it), so we create a 1-byte
# placeholder. At runtime, ensure_pi_runtime_extracted() tries to extract it,
# fails gracefully (returns None), and find_pi() falls through to dev-mode
# paths (current_exe parents / cwd / PATH) where the real pi-runtime lives.
$pi7z = Join-Path $TauriDir "src-tauri\pi-runtime.7z"
if (-not (Test-Path $pi7z)) {
    Write-Host "[0/3] Creating pi-runtime.7z placeholder for dev mode ..." -ForegroundColor Yellow
    [System.IO.File]::WriteAllBytes($pi7z, [byte[]](0))
    Write-Host "OK: placeholder created (real 7z built only by build-installer.ps1)" -ForegroundColor Green
}

# ============ Start sidecar (background) ============
Write-Host "[1/3] Starting Python sidecar (background, port 8000) ..." -ForegroundColor Yellow
$sidecarJob = Start-Process -FilePath $venvPython `
    -ArgumentList "-m", "uvicorn", "main:app", "--port", "8000" `
    -WorkingDirectory $SidecarDir `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput "$SidecarDir\.sidecar.log" `
    -RedirectStandardError "$SidecarDir\.sidecar.err"
Write-Host "OK: sidecar PID $($sidecarJob.Id)" -ForegroundColor Green

# ============ Wait for sidecar ready ============
Write-Host "[2/3] Waiting for sidecar ready ..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) {
    Write-Host "ERROR: sidecar not ready in 15s. Check log: $SidecarDir\.sidecar.err" -ForegroundColor Red
    Stop-Process -Id $sidecarJob.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "OK: sidecar online (http://127.0.0.1:8000)" -ForegroundColor Green

# ============ Start Tauri dev (foreground) ============
Write-Host "[3/3] Starting Tauri dev ..." -ForegroundColor Yellow
try {
    Push-Location $TauriDir
    npm run tauri dev
} finally {
    Pop-Location
    Write-Host "Stopping sidecar ..." -ForegroundColor Yellow
    Stop-Process -Id $sidecarJob.Id -Force -ErrorAction SilentlyContinue
    Write-Host "OK: cleaned up" -ForegroundColor Green
}
