# HT Logistic Workspace — 一键打包安装器脚本（Windows PowerShell）
#
# 用法：
#   cd ht-logistic-workspace
#   .\scripts\build-installer.ps1
#
# 产物：
#   tauri-app\src-tauri\target\release\bundle\nsis\HT Logistic Agent_0.1.0_x64-setup.exe
#   tauri-app\src-tauri\target\release\bundle\msi\HT Logistic Agent_0.1.0_x64_en-US.msi
#
# 流程：
#   1. 打包 Python sidecar 为单文件 exe（PyInstaller）
#   2. 把 sidecar exe 拷到 python-sidecar\ 根目录（Tauri 打包后查找路径）
#   3. 清理 python-sidecar 下不需要打包的目录（.venv / dist / build / __pycache__）
#      避免被 resources 通配符打进去，缩小安装包体积
#   4. npm install + npm run tauri build
#   5. 输出产物路径

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sidecarDir = Join-Path $repoRoot "python-sidecar"
$tauriDir = Join-Path $repoRoot "tauri-app"

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace 安装器打包" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. 打包 Python sidecar ----------
Write-Host "[1/4] 打包 Python sidecar..." -ForegroundColor Yellow
Push-Location $sidecarDir
try {
    if (-not (Test-Path ".venv")) {
        Write-Host "  创建 venv..." -ForegroundColor Gray
        python -m venv .venv
    }
    & .\.venv\Scripts\Activate.ps1
    pip install -r requirements.txt --quiet
    pip install pyinstaller --quiet
    Write-Host "  运行 PyInstaller..." -ForegroundColor Gray
    pyinstaller ht-sidecar.spec --noconfirm --clean 2>&1 | Out-Null
    if (-not (Test-Path "dist\ht-sidecar.exe")) {
        throw "PyInstaller 打包失败：dist\ht-sidecar.exe 不存在"
    }
    # 拷到 python-sidecar 根目录（main.rs resolve_sidecar 查找路径）
    Copy-Item "dist\ht-sidecar.exe" "ht-sidecar.exe" -Force
    Write-Host "  sidecar exe 已就位：python-sidecar\ht-sidecar.exe" -ForegroundColor Green
} finally {
    Pop-Location
}

# ---------- 2. 清理不需要打包的目录 ----------
Write-Host ""
Write-Host "[2/4] 清理 python-sidecar 下无需打包的目录..." -ForegroundColor Yellow
$cleanupDirs = @("build", "dist", "__pycache__", ".pytest_cache")
foreach ($d in $cleanupDirs) {
    $p = Join-Path $sidecarDir $d
    if (Test-Path $p) {
        Remove-Item $p -Recurse -Force
        Write-Host "  已删除 $d" -ForegroundColor Gray
    }
}
# 递归删除 __pycache__
Get-ChildItem $sidecarDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
Write-Host "  清理完成" -ForegroundColor Green

# ---------- 3. 构建 Tauri 安装器 ----------
Write-Host ""
Write-Host "[3/4] 构建 Tauri 安装器（首次构建较慢，约 10-20 分钟）..." -ForegroundColor Yellow
Push-Location $tauriDir
try {
    npm install --silent
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build 失败" }
} finally {
    Pop-Location
}

# ---------- 4. 输出产物路径 ----------
Write-Host ""
Write-Host "[4/4] 构建完成！" -ForegroundColor Green
$bundleDir = Join-Path $tauriDir "src-tauri\target\release\bundle"
Write-Host ""
Write-Host "产物位置：" -ForegroundColor Cyan
if (Test-Path (Join-Path $bundleDir "nsis")) {
    Get-ChildItem (Join-Path $bundleDir "nsis\*.exe") | ForEach-Object {
        Write-Host "  NSIS 安装器: $($_.FullName)" -ForegroundColor White
    }
}
if (Test-Path (Join-Path $bundleDir "msi")) {
    Get-ChildItem (Join-Path $bundleDir "msi\*.msi") | ForEach-Object {
        Write-Host "  MSI 安装器:  $($_.FullName)" -ForegroundColor White
    }
}
Write-Host ""
Write-Host "把 .exe 安装器发给用户，双击即可安装。" -ForegroundColor Cyan
