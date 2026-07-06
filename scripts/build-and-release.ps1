# HT Logistic Workspace - 一键构建 + 发布脚本
#
# 自动完成：版本号 bump、设签名环境变量、构建安装包、验证产物、打印上传清单
#
# 用法：
#   cd ht-logistic-workspace
#   .\scripts\build-and-release.ps1
#
# 可选参数：
#   -Version 0.1.3          指定版本号（默认自动 +0.0.1）
#   -SkipVersionBump        不 bump 版本号，用当前版本
#   -KeyPath "C:\Users\HT\.tauri\ht-logistic.key"
#   -KeyPassword "123"
#
# 前置条件：
#   1. 已安装 Rust + Node.js + Python（开发环境）
#   2. 签名私钥在 C:\Users\HT\.tauri\ht-logistic.key（密码 123）
#   3. 代码已 pull 到最新（git pull origin main）

param(
    [string]$Version = "",
    [switch]$SkipVersionBump,
    [string]$KeyPath = "$env:USERPROFILE\.tauri\ht-logistic.key",
    [string]$KeyPassword = "123"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriConfPath = Join-Path $repoRoot "tauri-app\src-tauri\tauri.conf.json"

# ========== 工具函数 ==========

function Write-Step { param([string]$msg)
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
}

function Write-OK { param([string]$msg)
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn { param([string]$msg)
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
}

function Write-Err { param([string]$msg)
    Write-Host "  [ERROR] $msg" -ForegroundColor Red
}

# ========== 0. 前置检查 ==========

Write-Step "Step 0: 前置检查"

# 0a. 检查是否在仓库根目录
if (-not (Test-Path $tauriConfPath)) {
    Write-Err "未找到 tauri.conf.json，请确认在仓库根目录运行此脚本"
    Write-Host "  当前目录: $(Get-Location)"
    Write-Host "  期望路径: $tauriConfPath"
    exit 1
}
Write-OK "在仓库根目录"

# 0b. 检查签名私钥
if (-not (Test-Path $KeyPath)) {
    Write-Err "未找到签名私钥: $KeyPath"
    Write-Host "  请确认私钥文件存在，或用 -KeyPath 参数指定路径"
    exit 1
}
Write-OK "签名私钥存在: $KeyPath"

# 0c. 检查当前版本号
$tauriConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
$currentVersion = $tauriConf.version
Write-OK "当前版本: $currentVersion"

# 0d. 检查 git 是否有未提交改动
$gitStatus = git status --porcelain 2>&1
if ($gitStatus) {
    Write-Warn "git 有未提交改动，构建前请先处理:"
    Write-Host $gitStatus
    $continue = Read-Host "  继续构建？(y/N)"
    if ($continue -ne 'y') { exit 1 }
}

# 0e. 检查是否已 pull 最新代码
Write-Host "  检查远程是否有新提交..."
git fetch origin main 2>&1 | Out-Null
$localCommit = git rev-parse HEAD 2>&1
$remoteCommit = git rev-parse origin/main 2>&1
if ($localCommit -ne $remoteCommit) {
    Write-Warn "本地和远程不一致，建议先 git pull origin main"
    Write-Host "  本地: $localCommit"
    Write-Host "  远程: $remoteCommit"
    $continue = Read-Host "  继续构建？(y/N)"
    if ($continue -ne 'y') { exit 1 }
} else {
    Write-OK "本地已是最新"
}

# ========== 1. Bump 版本号 ==========

if ($SkipVersionBump) {
    $newVersion = $currentVersion
    Write-Step "Step 1: 跳过版本号 bump（用当前版本 $newVersion）"
} else {
    if ($Version) {
        $newVersion = $Version
    } else {
        # 自动 +0.0.1
        $parts = $currentVersion.Split('.')
        $patch = [int]$parts[2] + 1
        $newVersion = "$($parts[0]).$($parts[1]).$patch"
    }

    Write-Step "Step 1: Bump 版本号 $currentVersion -> $newVersion"

    $content = Get-Content $tauriConfPath -Raw
    $newContent = $content -replace '"version":\s*"[^"]+"', "`"version`": `"$newVersion`""
    Set-Content -Path $tauriConfPath -Value $newContent -NoNewline

    # 验证
    $verifyConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json
    if ($verifyConf.version -ne $newVersion) {
        Write-Err "版本号写入失败，期望 $newVersion，实际 $($verifyConf.version)"
        exit 1
    }
    Write-OK "版本号已更新: $newVersion"
}

# ========== 2. 设签名环境变量 ==========

Write-Step "Step 2: 设置签名环境变量"

# 私钥内容（-Raw 整文件读取，保留换行）
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $KeyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KeyPassword

# 验证
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Err "TAURI_SIGNING_PRIVATE_KEY 设置失败"
    exit 1
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY.StartsWith("untrusted comment")) {
    Write-Warn "私钥内容前 30 字符: $($env:TAURI_SIGNING_PRIVATE_KEY.Substring(0, [Math]::Min(30, $env:TAURI_SIGNING_PRIVATE_KEY.Length)))"
    Write-Warn "私钥应该以 'untrusted comment' 开头，可能是格式问题"
}
Write-OK "TAURI_SIGNING_PRIVATE_KEY 已设置（长度: $($env:TAURI_SIGNING_PRIVATE_KEY.Length)）"
Write-OK "TAURI_SIGNING_PRIVATE_KEY_PASSWORD 已设置（长度: $($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD.Length)）"

# ========== 3. 调用原构建脚本 ==========

Write-Step "Step 3: 开始构建（调用 build-installer.ps1）"
Write-Host "  这一步大约需要 5-15 分钟，请耐心等待..." -ForegroundColor Gray
Write-Host "  包含：PyInstaller 打包 sidecar + 下载 Node.js + 装 pi + Tauri 构建 + NSIS 打包" -ForegroundColor Gray

$buildScript = Join-Path $PSScriptRoot "build-installer.ps1"
if (-not (Test-Path $buildScript)) {
    Write-Err "未找到构建脚本: $buildScript"
    exit 1
}

& $buildScript
if ($LASTEXITCODE -ne 0) {
    Write-Err "构建失败（exit code $LASTEXITCODE）"
    exit 1
}

# ========== 4. 验证产物 ==========

Write-Step "Step 4: 验证构建产物"

$bundleDir = Join-Path $repoRoot "tauri-app\src-tauri\target\release\bundle\nsis"
if (-not (Test-Path $bundleDir)) {
    Write-Err "产物目录不存在: $bundleDir"
    exit 1
}

# 4a. 检查 3 个必需文件
$setupExe = Get-ChildItem (Join-Path $bundleDir "*-setup.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setupExe) {
    Write-Err "未找到 setup.exe"
    exit 1
}
Write-OK "setup.exe: $($setupExe.Name) ($([math]::Round($setupExe.Length/1MB, 1)) MB)"

$setupSig = "$($setupExe.FullName).sig"
if (-not (Test-Path $setupSig)) {
    Write-Err "未找到 .sig 文件: $setupSig"
    Write-Host "  这通常是因为 TAURI_SIGNING_PRIVATE_KEY 环境变量没设对"
    exit 1
}
$sigSize = (Get-Item $setupSig).Length
Write-OK ".sig 文件: $([math]::Round($sigSize/1KB, 1)) KB"

$latestJsonPath = Join-Path $bundleDir "latest.json"
if (-not (Test-Path $latestJsonPath)) {
    Write-Err "未找到 latest.json"
    exit 1
}
Write-OK "latest.json 存在"

# 4b. 检查 latest.json 无 BOM
$bytes = [System.IO.File]::ReadAllBytes($latestJsonPath)
$first3 = "$($bytes[0]),$($bytes[1]),$($bytes[2])"
if ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    Write-Err "latest.json 有 UTF-8 BOM（EF BB BF），Tauri updater 会解析失败！"
    Write-Host "  前 3 字节: $first3 (239,187,191 = BOM)"
    exit 1
} else {
    Write-OK "latest.json 无 BOM（前 3 字节: $first3）"
}

# 4c. 验证 latest.json JSON 解析
try {
    $jsonContent = [System.IO.File]::ReadAllText($latestJsonPath)
    $json = $jsonContent | ConvertFrom-Json
    if ($json.version -ne $newVersion) {
        Write-Err "latest.json version 不匹配: 期望 $newVersion，实际 $($json.version)"
        exit 1
    }
    if (-not $json.platforms.'windows-x86_64'.signature) {
        Write-Err "latest.json signature 字段为空"
        exit 1
    }
    if (-not $json.platforms.'windows-x86_64'.url) {
        Write-Err "latest.json url 字段为空"
        exit 1
    }
    Write-OK "latest.json JSON 解析成功"
    Write-OK "  version: $($json.version)"
    Write-OK "  pub_date: $($json.pub_date)"
    Write-OK "  signature 长度: $($json.platforms.'windows-x86_64'.signature.Length)"
    Write-OK "  url: $($json.platforms.'windows-x86_64'.url)"
} catch {
    Write-Err "latest.json JSON 解析失败: $_"
    exit 1
}

# 4d. 验证 signature 非空且是 base64
$sig = $json.platforms.'windows-x86_64'.signature
try {
    $sigBytes = [System.Convert]::FromBase64String($sig)
    $sigText = [System.Text.Encoding]::UTF8.GetString($sigBytes)
    if ($sigText -match 'trusted comment: signature from tauri secret key') {
        Write-OK "signature 解码后是有效的 Tauri 签名"
    } else {
        Write-Warn "signature 解码后内容:"
        Write-Host $sigText
    }
} catch {
    Write-Err "signature 不是有效的 base64: $_"
    exit 1
}

# ========== 5. 打印上传清单 ==========

Write-Step "Step 5: 构建完成！上传清单"

Write-Host ""
Write-Host "需要上传到 GitHub Release 的 3 个文件:" -ForegroundColor Yellow
Write-Host ""

$filesToUpload = @(
    @{ Path = $setupExe.FullName; Desc = "安装包" },
    @{ Path = $setupSig; Desc = "签名文件" },
    @{ Path = $latestJsonPath; Desc = "更新清单" }
)

foreach ($f in $filesToUpload) {
    if (Test-Path $f.Path) {
        $size = [math]::Round((Get-Item $f.Path).Length / 1MB, 2)
        Write-Host "  [$($f.Desc)] $f.Path" -ForegroundColor White
        Write-Host "          大小: $size MB" -ForegroundColor Gray
    } else {
        Write-Host "  [$($f.Desc)] $f.Path  (MISSING!)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "GitHub Release 操作步骤:" -ForegroundColor Cyan
Write-Host "  1. 浏览器打开: https://github.com/jameszeng222/ht-logistic-workspace/releases/new" -ForegroundColor Gray
Write-Host "  2. Tag: v$newVersion  (必须和 version 一致)" -ForegroundColor Gray
Write-Host "  3. Title: HT Logistic Agent v$newVersion" -ForegroundColor Gray
Write-Host "  4. 上传上面 3 个文件" -ForegroundColor Gray
Write-Host "  5. 发布 Release" -ForegroundColor Gray
Write-Host ""
Write-Host "发布后，客户端设置页'检查更新'即可拉到新版。" -ForegroundColor Green
Write-Host ""

# 5a. 自动打开产物文件夹
$openFolder = Read-Host "是否自动打开产物文件夹？(Y/n)"
if ($openFolder -ne 'n') {
    Start-Process explorer.exe -ArgumentList $bundleDir
}

# 5b. 自动打开 GitHub Release 页面
$openGitHub = Read-Host "是否自动打开 GitHub Release 创建页面？(Y/n)"
if ($openGitHub -ne 'n') {
    Start-Process "https://github.com/jameszeng222/ht-logistic-workspace/releases/new"
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  全部完成！" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
