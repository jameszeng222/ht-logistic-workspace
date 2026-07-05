# HT Logistic Workspace — 一键打包傻瓜安装器脚本（Windows PowerShell）
#
# 用法：
#   cd ht-logistic-workspace
#   .\scripts\build-installer.ps1
#
# 产物（用户双击即可安装，无需装 Node.js / Python / Rust）：
#   tauri-app\src-tauri\target\release\bundle\nsis\HT Logistic Agent_0.1.0_x64-setup.exe
#
# 流程：
#   1. 打包 Python sidecar（PyInstaller → ht-sidecar.exe）
#   2. 准备 pi-runtime（下载便携版 Node.js + npm 装 pi 包 + 生成 pi.cmd 启动脚本）
#   3. npm install + npm run tauri build（把 sidecar + pi-runtime 一起打包）
#   4. 输出产物路径

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sidecarDir = Join-Path $repoRoot "python-sidecar"
$tauriDir = Join-Path $repoRoot "tauri-app"
$piRuntimeDir = Join-Path $repoRoot "pi-runtime"

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace 傻瓜安装器打包" -ForegroundColor Cyan
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
    Copy-Item "dist\ht-sidecar.exe" "ht-sidecar.exe" -Force
    Write-Host "  sidecar exe 已就位" -ForegroundColor Green
} finally {
    Pop-Location
}

# ---------- 2. 准备 pi-runtime（便携 Node + pi 包）----------
Write-Host ""
Write-Host "[2/4] 准备 pi-runtime（便携版 Node.js + pi 包）..." -ForegroundColor Yellow

# 清理旧的 pi-runtime
if (Test-Path $piRuntimeDir) {
    Remove-Item $piRuntimeDir -Recurse -Force
}
New-Item -ItemType Directory -Path $piRuntimeDir -Force | Out-Null

# 2a. 下载便携版 Node.js（x64）
$nodeVersion = "v22.20.0"  # LTS
$nodeArch = "x64"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-$nodeArch.zip"
$nodeZip = Join-Path $env:TEMP "node-portable.zip"
$nodeExtractDir = Join-Path $env:TEMP "node-portable-extract"

Write-Host "  下载 Node.js $nodeVersion (win-$nodeArch)..." -ForegroundColor Gray
if (Test-Path $nodeExtractDir) { Remove-Item $nodeExtractDir -Recurse -Force }
Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
Expand-Archive -Path $nodeZip -DestinationPath $nodeExtractDir -Force
$nodeDir = Get-ChildItem -Path $nodeExtractDir -Directory | Select-Object -First 1
# 把 node.exe 拷到 pi-runtime 根目录
Copy-Item (Join-Path $nodeDir.FullName "node.exe") $piRuntimeDir -Force
Write-Host "  node.exe 已就位" -ForegroundColor Gray

# 2b. 用便携 node 跑 npm 装 pi 包
Write-Host "  安装 pi 包到 pi-runtime..." -ForegroundColor Gray
$npmCli = Join-Path $nodeDir.FullName "node_modules\npm\bin\npm-cli.js"
# 先在 pi-runtime 下建 package.json
$pkgJson = @{ name = "pi-runtime"; version = "1.0.0"; private = $true } | ConvertTo-Json
Set-Content -Path (Join-Path $piRuntimeDir "package.json") -Value $pkgJson
# 用便携 node + npm 装 pi
Push-Location $piRuntimeDir
try {
    & (Join-Path $piRuntimeDir "node.exe") $npmCli install "@earendil-works/pi-coding-agent" --no-save --ignore-scripts 2>&1 | Out-Null
    if (-not (Test-Path "node_modules\@earendil-works\pi-coding-agent")) {
        throw "pi 包安装失败"
    }
} finally {
    Pop-Location
}
Write-Host "  pi 包已安装" -ForegroundColor Gray

# 2c. 生成 pi.cmd 启动脚本（调用便携 node 运行 pi 的 cli.js）
$piCliJs = "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
$piCmdContent = @"
@echo off
setlocal
set "PI_RUNTIME_DIR=%~dp0"
set "PATH=%PI_RUNTIME_DIR%;%PATH%"
"%PI_RUNTIME_DIR%node.exe" "%PI_RUNTIME_DIR%$piCliJs" %*
"@
Set-Content -Path (Join-Path $piRuntimeDir "pi.cmd") -Value $piCmdContent -Encoding ASCII
Write-Host "  pi.cmd 启动脚本已生成" -ForegroundColor Gray

# 2d. 清理 npm 缓存和多余文件，减小体积
Remove-Item (Join-Path $piRuntimeDir "package.json") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $piRuntimeDir "package-lock.json") -Force -ErrorAction SilentlyContinue
Get-ChildItem $piRuntimeDir -Recurse -Directory -Filter "*.ts" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
# 删除 .md / .map / LICENSE 等非运行时文件
Get-ChildItem $piRuntimeDir -Recurse -Include "*.md","*.map","*.markdown" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

$runtimeSize = [math]::Round((Get-ChildItem $piRuntimeDir -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "  pi-runtime 准备完成（约 ${runtimeSize} MB）" -ForegroundColor Green

# ---------- 3. 清理 sidecar 临时文件 + 构建 Tauri 安装器 ----------
Write-Host ""
Write-Host "[3/4] 清理 + 构建 Tauri 安装器..." -ForegroundColor Yellow
# 清理 sidecar 临时目录
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
        $size = [math]::Round($_.Length / 1MB, 1)
        Write-Host "  NSIS 安装器: $($_.FullName) (${size} MB)" -ForegroundColor White
    }
}
if (Test-Path (Join-Path $bundleDir "msi")) {
    Get-ChildItem (Join-Path $bundleDir "msi\*.msi") | ForEach-Object {
        $size = [math]::Round($_.Length / 1MB, 1)
        Write-Host "  MSI 安装器:  $($_.FullName) (${size} MB)" -ForegroundColor White
    }
}
Write-Host ""
Write-Host "用户双击 .exe 安装即可，无需装 Node.js / Python / Rust。" -ForegroundColor Cyan
