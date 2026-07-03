# HT Logistic Workspace — 一键开发启动脚本
#
# 用法（在仓库根目录）：
#   .\dev.ps1
#
# 会做：
#   1. 检查 python-sidecar/.venv 是否存在，没有就提示先跑 setup.ps1
#   2. 在后台启动 Python sidecar（uvicorn，端口 8000）
#   3. 等待 sidecar 健康检查通过
#   4. 前台启动 Tauri dev（npm run tauri dev）
#   5. Tauri 退出时自动 kill sidecar
#
# 关闭：Ctrl+C 停 Tauri，sidecar 会自动停。

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarDir = Join-Path $RepoRoot "python-sidecar"
$TauriDir = Join-Path $RepoRoot "tauri-app"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace — 开发启动" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ============ 检查 venv ============
$venvPython = Join-Path $SidecarDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "✗ python-sidecar/.venv 不存在，请先在 python-sidecar 目录跑 .\setup.ps1" -ForegroundColor Red
    exit 1
}

# ============ 启动 sidecar（后台）============
Write-Host "[1/3] 启动 Python sidecar（后台，端口 8000）..." -ForegroundColor Yellow
$sidecarJob = Start-Process -FilePath $venvPython `
    -ArgumentList "-m", "uvicorn", "main:app", "--port", "8000" `
    -WorkingDirectory $SidecarDir `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput "$SidecarDir\.sidecar.log" `
    -RedirectStandardError "$SidecarDir\.sidecar.err"
Write-Host "✓ sidecar PID: $($sidecarJob.Id)" -ForegroundColor Green

# ============ 等待 sidecar 就绪 ============
Write-Host "[2/3] 等待 sidecar 就绪 ..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) {
    Write-Host "✗ sidecar 15s 内未就绪，查看日志：$SidecarDir\.sidecar.err" -ForegroundColor Red
    Stop-Process -Id $sidecarJob.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "✓ sidecar 在线（http://127.0.0.1:8000）" -ForegroundColor Green

# ============ 启动 Tauri dev（前台）============
Write-Host "[3/3] 启动 Tauri dev ..." -ForegroundColor Yellow
try {
    Push-Location $TauriDir
    npm run tauri dev
} finally {
    Pop-Location
    # Tauri 退出后清理 sidecar
    Write-Host "停止 sidecar ..." -ForegroundColor Yellow
    Stop-Process -Id $sidecarJob.Id -Force -ErrorAction SilentlyContinue
    Write-Host "✓ 已清理" -ForegroundColor Green
}
