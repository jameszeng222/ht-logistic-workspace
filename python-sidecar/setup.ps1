# HT Logistic Workspace - Python sidecar setup script
#
# Usage (in python-sidecar directory):
#   .\setup.ps1
#
# This script will:
#   1. Create .venv if not exists
#   2. Configure pip mirror (Tsinghua) to bypass SSL cert CN mismatch
#   3. Install requirements.txt
#   4. Install pyinstaller (for packaging ht-sidecar.exe)
#   5. Print how to start the service
#
# If Tsinghua mirror is slow, switch to Aliyun by editing $MIRROR below.

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
$MIRROR_HOST = "pypi.tuna.tsinghua.edu.cn"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace - Sidecar Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============ 1. Create venv ============
if (-not (Test-Path ".\.venv\Scripts\Activate.ps1")) {
    Write-Host "[1/5] Creating virtual environment .venv ..." -ForegroundColor Yellow
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to create venv. Please confirm Python 3.10+ is installed." -ForegroundColor Red
        exit 1
    }
    Write-Host "OK: venv created" -ForegroundColor Green
} else {
    Write-Host "[1/5] venv .venv already exists, skip" -ForegroundColor Green
}

# ============ 2. Activate venv ============
Write-Host "[2/5] Activating venv ..." -ForegroundColor Yellow
. .\.venv\Scripts\Activate.ps1
Write-Host "OK: activated" -ForegroundColor Green

# ============ 3. Configure pip mirror ============
Write-Host "[3/5] Configuring pip mirror (Tsinghua) ..." -ForegroundColor Yellow
python -m pip config set global.index-url $MIRROR
python -m pip config set global.trusted-host $MIRROR_HOST
Write-Host "OK: mirror configured (current user only)" -ForegroundColor Green

# ============ 4. Upgrade pip ============
Write-Host "[4/5] Upgrading pip ..." -ForegroundColor Yellow
python -m pip install --upgrade pip -i $MIRROR --trusted-host $MIRROR_HOST
Write-Host "OK: pip upgraded" -ForegroundColor Green

# ============ 5. Install requirements ============
Write-Host "[5/5] Installing requirements.txt ..." -ForegroundColor Yellow
pip install -r requirements.txt -i $MIRROR --trusted-host $MIRROR_HOST
if ($LASTEXITCODE -ne 0) {
    Write-Host "Install failed with Tsinghua mirror, trying Aliyun ..." -ForegroundColor Yellow
    $MIRROR = "https://mirrors.aliyun.com/pypi/simple/"
    $MIRROR_HOST = "mirrors.aliyun.com"
    python -m pip config set global.index-url $MIRROR
    python -m pip config set global.trusted-host $MIRROR_HOST
    pip install -r requirements.txt -i $MIRROR --trusted-host $MIRROR_HOST
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: install failed. Check network and retry manually." -ForegroundColor Red
        exit 1
    }
}
Write-Host "OK: requirements installed" -ForegroundColor Green

# ============ 6. Install pyinstaller (for packaging) ============
Write-Host "[+] Installing pyinstaller (for packaging ht-sidecar.exe) ..." -ForegroundColor Yellow
pip install pyinstaller -i $MIRROR --trusted-host $MIRROR_HOST
if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: pyinstaller install failed, handle later when packaging" -ForegroundColor Yellow
} else {
    Write-Host "OK: pyinstaller installed" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  Start sidecar:  python -m uvicorn main:app --reload --port 8000" -ForegroundColor White
Write-Host "  Package:        pyinstaller ht-sidecar.spec" -ForegroundColor White
Write-Host "  Health check:   http://127.0.0.1:8000/api/health" -ForegroundColor White
Write-Host ""
