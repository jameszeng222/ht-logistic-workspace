#!/usr/bin/env bash
# HT Logistic Workspace — 一键打包安装器脚本（macOS / Linux bash）
#
# 用法：
#   cd ht-logistic-workspace
#   bash scripts/build-installer.sh
#
# 产物：
#   macOS:   tauri-app/src-tauri/target/release/bundle/dmg/*.dmg
#   Linux:   tauri-app/src-tauri/target/release/bundle/deb/*.deb
#            tauri-app/src-tauri/target/release/bundle/appimage/*.AppImage
#
# 流程：
#   1. 打包 Python sidecar 为单文件可执行程序（PyInstaller）
#   2. 把 sidecar 拷到 python-sidecar/ 根目录（Tauri 打包后查找路径）
#   3. 清理 python-sidecar 下不需要打包的目录（.venv / dist / build / __pycache__）
#   4. npm install + npm run tauri build
#   5. 输出产物路径

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/python-sidecar"
TAURI_DIR="$REPO_ROOT/tauri-app"

echo -e "\033[36m================================================\033[0m"
echo -e "\033[36m  HT Logistic Workspace 安装器打包\033[0m"
echo -e "\033[36m================================================\033[0m"
echo ""

# ---------- 1. 打包 Python sidecar ----------
echo -e "\033[33m[1/4] 打包 Python sidecar...\033[0m"
cd "$SIDECAR_DIR"
if [ ! -d ".venv" ]; then
    echo "  创建 venv..."
    python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -r requirements.txt --quiet
pip install pyinstaller --quiet
echo "  运行 PyInstaller..."
pyinstaller ht-sidecar.spec --noconfirm --clean > /dev/null 2>&1
SIDECAR_BIN="dist/ht-sidecar"
if [ ! -f "$SIDECAR_BIN" ]; then
    echo "PyInstaller 打包失败：$SIDECAR_BIN 不存在" >&2
    exit 1
fi
cp "$SIDECAR_BIN" "ht-sidecar"
echo -e "  sidecar 已就位：python-sidecar/ht-sidecar \033[32m✓\033[0m"

# ---------- 2. 清理不需要打包的目录 ----------
echo ""
echo -e "\033[33m[2/4] 清理 python-sidecar 下无需打包的目录...\033[0m"
for d in build dist __pycache__ .pytest_cache; do
    if [ -d "$d" ]; then
        rm -rf "$d"
        echo "  已删除 $d"
    fi
done
find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
echo -e "  清理完成 \033[32m✓\033[0m"

# ---------- 3. 构建 Tauri 安装器 ----------
echo ""
echo -e "\033[33m[3/4] 构建 Tauri 安装器（首次构建较慢，约 10-20 分钟）...\033[0m"
cd "$TAURI_DIR"
npm install --silent
npm run tauri build

# ---------- 4. 输出产物路径 ----------
echo ""
echo -e "\033[32m[4/4] 构建完成！\033[0m"
BUNDLE_DIR="$TAURI_DIR/src-tauri/target/release/bundle"
echo ""
echo -e "\033[36m产物位置：\033[0m"
if [ -d "$BUNDLE_DIR/dmg" ]; then
    ls -1 "$BUNDLE_DIR/dmg/"*.dmg 2>/dev/null | while read -r f; do
        echo "  DMG 安装器:  $f"
    done
fi
if [ -d "$BUNDLE_DIR/deb" ]; then
    ls -1 "$BUNDLE_DIR/deb/"*.deb 2>/dev/null | while read -r f; do
        echo "  DEB 安装器:  $f"
    done
fi
if [ -d "$BUNDLE_DIR/appimage" ]; then
    ls -1 "$BUNDLE_DIR/appimage/"*.AppImage 2>/dev/null | while read -r f; do
        echo "  AppImage:    $f"
    done
fi
echo ""
echo -e "\033[36m把安装器发给用户，双击即可安装。\033[0m"
