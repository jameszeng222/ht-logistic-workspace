# HT Logistic Workspace — Python sidecar 一键环境配置脚本
#
# 用法（在 python-sidecar 目录下）：
#   .\setup.ps1
#
# 会做：
#   1. 创建 .venv（若不存在）
#   2. 配置 pip 清华镜像源（解决 SSL 证书 CN 不匹配问题）
#   3. 安装 requirements.txt 全部依赖
#   4. 安装 pyinstaller（用于后续打包 ht-sidecar.exe）
#   5. 提示如何启动服务
#
# 如果清华源也慢，把 $MIRROR 换成阿里源：
#   $MIRROR = "https://mirrors.aliyun.com/pypi/simple/"

$ErrorActionPreference = "Stop"
$MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
$MIRROR_HOST = "pypi.tuna.tsinghua.edu.cn"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  HT Logistic Workspace — Sidecar 配置" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============ 1. 创建虚拟环境 ============
if (-not (Test-Path ".\.venv\Scripts\Activate.ps1")) {
    Write-Host "[1/5] 创建虚拟环境 .venv ..." -ForegroundColor Yellow
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "创建 venv 失败，请确认已安装 Python 3.10+" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ 虚拟环境已创建" -ForegroundColor Green
} else {
    Write-Host "[1/5] 虚拟环境 .venv 已存在，跳过" -ForegroundColor Green
}

# ============ 2. 激活虚拟环境 ============
Write-Host "[2/5] 激活虚拟环境 ..." -ForegroundColor Yellow
. .\.venv\Scripts\Activate.ps1
Write-Host "✓ 已激活" -ForegroundColor Green

# ============ 3. 配置 pip 镜像源 ============
Write-Host "[3/5] 配置 pip 清华镜像源 ..." -ForegroundColor Yellow
python -m pip config set global.index-url $MIRROR
python -m pip config set global.trusted-host $MIRROR_HOST
Write-Host "✓ 镜像源已配置（仅当前用户生效）" -ForegroundColor Green

# ============ 4. 升级 pip ============
Write-Host "[4/5] 升级 pip ..." -ForegroundColor Yellow
python -m pip install --upgrade pip -i $MIRROR --trusted-host $MIRROR_HOST
Write-Host "✓ pip 已升级" -ForegroundColor Green

# ============ 5. 安装依赖 ============
Write-Host "[5/5] 安装 requirements.txt 依赖 ..." -ForegroundColor Yellow
pip install -r requirements.txt -i $MIRROR --trusted-host $MIRROR_HOST
if ($LASTEXITCODE -ne 0) {
    Write-Host "依赖安装失败，尝试换阿里源 ..." -ForegroundColor Yellow
    $MIRROR = "https://mirrors.aliyun.com/pypi/simple/"
    $MIRROR_HOST = "mirrors.aliyun.com"
    pip config set global.index-url $MIRROR
    pip config set global.trusted-host $MIRROR_HOST
    pip install -r requirements.txt -i $MIRROR --trusted-host $MIRROR_HOST
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ 依赖安装失败，请检查网络后手动重试" -ForegroundColor Red
        exit 1
    }
}
Write-Host "✓ 依赖安装完成" -ForegroundColor Green

# ============ 6. 安装 pyinstaller（打包用）============
Write-Host "[+] 安装 pyinstaller（用于打包 ht-sidecar.exe）..." -ForegroundColor Yellow
pip install pyinstaller -i $MIRROR --trusted-host $MIRROR_HOST
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠ pyinstaller 安装失败，打包时再处理" -ForegroundColor Yellow
} else {
    Write-Host "✓ pyinstaller 已安装" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  配置完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor White
Write-Host "  启动 sidecar：  python -m uvicorn main:app --reload --port 8000" -ForegroundColor White
Write-Host "  打包 sidecar：   pyinstaller ht-sidecar.spec" -ForegroundColor White
Write-Host "  健康检查：       http://127.0.0.1:8000/api/health" -ForegroundColor White
Write-Host ""
