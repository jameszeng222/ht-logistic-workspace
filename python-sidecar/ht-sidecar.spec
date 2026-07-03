# -*- mode: python ; coding: utf-8 -*-
"""HT Logistic Workspace — Python sidecar PyInstaller 打包配置

把 python-sidecar/ 打包成单个 exe（ht-sidecar.exe / ht-sidecar），
Tauri 在 setup 时通过 src-tauri/src/main.rs 的 resolve_sidecar 定位并拉起它。

构建步骤（Windows PowerShell / Linux bash 通用）：
    cd python-sidecar
    pip install -r requirements.txt
    pip install pyinstaller
    pyinstaller ht-sidecar.spec          # 产物在 dist/ht-sidecar/ht-sidecar(.exe)

构建后 Tauri 会通过 resources 把整个 python-sidecar/ 目录随 app 打包，
main.rs 的 resolve_sidecar 优先找 python-sidecar/ht-sidecar(.exe) 启动；
找不到则降级到 `python main.py`（开发模式）。

注意：
  - onefile 模式启动稍慢（每次解压到临时目录），但分发最简单。
  - 模板/资源文件通过 datas 列表打包，运行时通过 sys._MEIPASS 访问。
    tools/invoice_packing.py 等用 `Path(__file__).parent / "templates"` 定位，
    PyInstaller 会把 tools/templates/ 解到 <_MEIPASS>/tools/templates/，
    路径自动对齐。
  - uvicorn 有大量运行时动态导入，必须显式声明 hiddenimports，否则打包后跑不起来。
"""

import sys
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# uvicorn / fastapi 的动态导入很多，全部收集
hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("fastapi")
    + collect_submodules("starlette")
    + [
        # multipart 文件上传
        "multipart",
    ]
)

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=[],
    datas=[
        # (源, 目标相对 bundle 根) —— 把 tools/templates 和 tools/assets 一起打包
        ("tools/templates", "tools/templates"),
        ("tools/assets", "tools/assets"),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 排除不需要的大模块以减小体积
        "tkinter",
        "matplotlib",
        "PyQt5",
        "PySide6",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="ht-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,             # UPX 压缩减小体积（需系统装 upx，未装则忽略）
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,        # 不弹控制台窗口（Tauri 端也加了 CREATE_NO_WINDOW 双保险）
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon=None,  # 可后续加 .ico
)
