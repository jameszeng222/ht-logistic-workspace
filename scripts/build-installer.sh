#!/usr/bin/env bash
# HT Logistic Workspace — 一键打包傻瓜安装器脚本（macOS / Linux bash）
#
# 用法：
#   cd ht-logistic-workspace
#   bash scripts/build-installer.sh
#
# 产物（用户双击即可安装，无需装 Node.js / Python / Rust）：
#   macOS: tauri-app/src-tauri/target/release/bundle/dmg/*.dmg
#   Linux: tauri-app/src-tauri/target/release/bundle/deb/*.deb + appimage/*.AppImage
#
# 流程：
#   1. 打包 Python sidecar（PyInstaller → ht-sidecar）
#   2. 准备 pi-runtime（下载便携版 Node.js + npm 装 pi 包 + 生成 pi 启动脚本）
#   3. npm install + npm run tauri build（把 sidecar + pi-runtime 一起打包）
#   4. 输出产物路径

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/python-sidecar"
TAURI_DIR="$REPO_ROOT/tauri-app"
PI_RUNTIME_DIR="$REPO_ROOT/pi-runtime"

echo -e "\033[36m================================================\033[0m"
echo -e "\033[36m  HT Logistic Workspace 傻瓜安装器打包\033[0m"
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
if [ ! -f "dist/ht-sidecar" ]; then
    echo "PyInstaller 打包失败" >&2; exit 1
fi
cp "dist/ht-sidecar" "ht-sidecar"
chmod +x "ht-sidecar"
echo -e "  sidecar 已就位 \033[32m✓\033[0m"

# ---------- 2. 准备 pi-runtime（便携 Node + pi 包）----------
echo ""
echo -e "\033[33m[2/4] 准备 pi-runtime（便携版 Node.js + pi 包）...\033[0m"

rm -rf "$PI_RUNTIME_DIR"
mkdir -p "$PI_RUNTIME_DIR"

# 2a. 下载便携版 Node.js
NODE_VERSION="v22.20.0"
OS_TYPE="$(uname -s)"
ARCH_TYPE="$(uname -m)"
case "$OS_TYPE" in
    Darwin) NODE_OS="darwin";;
    Linux)  NODE_OS="linux";;
    *) echo "不支持的系统: $OS_TYPE" >&2; exit 1;;
esac
case "$ARCH_TYPE" in
    x86_64|amd64) NODE_ARCH="x64";;
    arm64|aarch64) NODE_ARCH="arm64";;
    *) echo "不支持的架构: $ARCH_TYPE" >&2; exit 1;;
esac
NODE_TARBALL="node-$NODE_VERSION-$NODE_OS-$NODE_ARCH.tar.xz"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL"
NODE_TMP="$(mktemp -d)"

echo "  下载 Node.js $NODE_VERSION ($NODE_OS-$NODE_ARCH)..."
curl -fsSL "$NODE_URL" | tar -xJ -C "$NODE_TMP"
NODE_BIN_DIR=$(find "$NODE_TMP" -name "node" -type f -executable | head -1 | xargs dirname)
cp "$NODE_BIN_DIR/node" "$PI_RUNTIME_DIR/node"
chmod +x "$PI_RUNTIME_DIR/node"

# 2b. 用便携 node 跑 npm 装 pi 包
echo "  安装 pi 包到 pi-runtime..."
NPM_CLI=$(find "$NODE_TMP" -path "*/npm/bin/npm-cli.js" | head -1)
echo '{"name":"pi-runtime","version":"1.0.0","private":true}' > "$PI_RUNTIME_DIR/package.json"
cd "$PI_RUNTIME_DIR"
"$PI_RUNTIME_DIR/node" "$NPM_CLI" install "@earendil-works/pi-coding-agent" --no-save --ignore-scripts > /dev/null 2>&1
if [ ! -d "node_modules/@earendil-works/pi-coding-agent" ]; then
    echo "pi 包安装失败" >&2; exit 1
fi

# 2c. 生成 pi 启动脚本
PI_CLI_JS="node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
cat > "$PI_RUNTIME_DIR/pi" << EOF
#!/usr/bin/env bash
# pi 启动脚本（便携版，调用内嵌 node 运行 pi）
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
export PATH="\$DIR:\$PATH"
exec "\$DIR/node" "\$DIR/$PI_CLI_JS" "\$@"
EOF
chmod +x "$PI_RUNTIME_DIR/pi"
echo -e "  pi 启动脚本已生成 \033[32m✓\033[0m"

# 2d. 清理多余文件，减小体积
rm -f "$PI_RUNTIME_DIR/package.json" "$PI_RUNTIME_DIR/package-lock.json"
find "$PI_RUNTIME_DIR" -name "*.md" -delete 2>/dev/null || true
find "$PI_RUNTIME_DIR" -name "*.map" -delete 2>/dev/null || true
find "$PI_RUNTIME_DIR" -name "*.markdown" -delete 2>/dev/null || true
rm -rf "$NODE_TMP"

RUNTIME_SIZE=$(du -sh "$PI_RUNTIME_DIR" | cut -f1)
echo -e "  pi-runtime 准备完成（约 ${RUNTIME_SIZE}）\033[32m✓\033[0m"

# ---------- 3. 清理 sidecar + 构建 Tauri ----------
echo ""
echo -e "\033[33m[3/4] 清理 + 构建 Tauri 安装器...\033[0m"
cd "$SIDECAR_DIR"
for d in build dist __pycache__ .pytest_cache; do
    [ -d "$d" ] && rm -rf "$d"
done
find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

cd "$TAURI_DIR"
npm install --silent
npm run tauri build

# ---------- 4. 输出产物 ----------
echo ""
echo -e "\033[32m[4/4] 构建完成！\033[0m"
BUNDLE_DIR="$TAURI_DIR/src-tauri/target/release/bundle"
echo ""
echo -e "\033[36m产物位置：\033[0m"
if [ -d "$BUNDLE_DIR/dmg" ]; then
    ls -lh "$BUNDLE_DIR/dmg/"*.dmg 2>/dev/null | awk '{print "  DMG 安装器:  "$NF" ("$5")"}'
fi
if [ -d "$BUNDLE_DIR/deb" ]; then
    ls -lh "$BUNDLE_DIR/deb/"*.deb 2>/dev/null | awk '{print "  DEB 安装器:  "$NF" ("$5")"}'
fi
if [ -d "$BUNDLE_DIR/appimage" ]; then
    ls -lh "$BUNDLE_DIR/appimage/"*.AppImage 2>/dev/null | awk '{print "  AppImage:    "$NF" ("$5")"}'
fi
echo ""
echo -e "\033[36m用户双击安装即可，无需装 Node.js / Python / Rust。\033[0m"
