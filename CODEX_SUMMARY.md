# HT Logistic Workspace — 阶段总结（给 Codex 接力）

本文档面向接力的 AI 编程助手（Codex 等）。它总结了项目当前形态、最近迭代的成果、架构关键点、已知约束和后续建议。读完这一份就能继续开发，不需要回溯历史对话。

---

## 1. 项目一句话

HT Logistic Workspace 是一个**本地桌面物流 AI 工作台**：Tauri v2 + React 做客户端，Rust 管 Pi RPC 子进程和本地文件/会话，Python FastAPI sidecar 承载 Excel/PDF 物流工具，Pi extension 把工具暴露给 AI agent 调用。**已支持傻瓜包分发**（内嵌 Python sidecar + 便携 Node.js + pi 包，用户双击安装即用）和**手动检查更新**（基于 Tauri updater + GitHub Release）。

**产品方向（用户明确强调）**：不要做成泛 AI 聊天页面，要做成「物流工具 + AI 助手 + 文件侧栏」同屏工作台。高频业务是**单据制作**和**数据分析**，报关处理不是当前重点。

---

## 2. 当前产品形态

主页面三栏布局（工具导航已从中间底部移到左侧栏，中间只留执行区）：

- **左侧（300px）**：会话管理（按项目名分组，不按完整目录）+ **物流工具导航**（`sidebar-tools-nav`，点击切换中间执行区当前工具）。已删除会话分支/Fork 入口。
- **中间**：上方 AI 助手聊天区（空状态有 📦 图标 + 3 个示例 prompt chip，composer 拆分为两组 pill），下方 `tool-workbench` 工具执行区（`ToolsPanel` 设 `hideNav`，只渲染当前工具的选文件/执行/结果，不再渲染工具列表）。
- **右侧（326px）**：文件浏览器。支持目录浏览、双 tab（工作目录/会话目录）、文件拖拽到聊天框、"分析"按钮加入附件。

**工具导航现状**：左侧栏 `toolsList.map` 会显示 sidecar 返回的**所有工具**（含报关工具 `customs-generator` / `customs-extractor`）。`DAILY_TOOL_IDS = {"invoice-packing","data-analysis"}` 仅用于自动选中默认工具，**未做显示过滤**。如需"报关降级"需改 `App.tsx` 左侧栏渲染逻辑（只 map `DAILY_TOOL_IDS` 或加排序/折叠）。

**视觉风格**：Codex/轻客户端调性，浅色默认，少分隔线，多用留白、圆角、hover 状态和轻阴影。支持深色/浅色主题切换（顶栏 ☀️/🌙 按钮）。

**设置面板**：工作目录、扩展技能、模型配置、错误处理、工具权限模式、Agent 人设/系统提示词、**关于与更新**（检查更新按钮 + 版本号显示 + 下载进度条）。

---

## 3. 技术栈

### 桌面客户端
- Tauri v2（Rust 后端命令 + React 前端）
- React 18 + Vite 5 + TypeScript
- `@tauri-apps/plugin-dialog`（原生文件/目录选择）
- `@tauri-apps/plugin-fs`（读本地文件为字节数组）
- `@tauri-apps/plugin-updater`（自动更新：检查/下载/签名校验）
- `@tauri-apps/plugin-process`（更新后 relaunch 重启应用）
- `react-markdown` + `remark-gfm` + `chart.js` + `react-chartjs-2`

### 工具 sidecar
- Python 3.10+（推荐 3.11/3.12，3.13+ 在 Windows 可能缺预编译 wheel）
- FastAPI on `127.0.0.1:8000`
- pandas / openpyxl / pdfplumber / pytesseract（OCR 可选）
- **PyInstaller onefile 模式打包为 `ht-sidecar.exe`**，运行时解压到临时目录

### Agent / Pi
- Pi 以 `pi --mode rpc --append-system-prompt <Pilot身份提示词>` 由 Tauri Rust 主进程启动
- `pi --session <path>` 用于续聊历史会话（restart_pi 命令）
- **傻瓜包模式**：便携 Node.js + pi 包内嵌到安装包的 `pi-runtime/` 目录，`find_pi()` 优先查这里
- Pi extension: `~/.pi/agent/extensions/all-in-one.ts`
- Agent 配置: `~/.pi/agent/SYSTEM.md` + `~/.pi/agent/skills/` + `~/.pi/agent/APPEND_SYSTEM.md`（Pilot 身份提示词）

### 打包与分发
- **Windows**: NSIS installer（`perMachine` 安装模式，SimpChinese+English 双语言）
- **macOS/Linux**: DMG / AppImage / DEB（由 `build-installer.sh` 处理）
- **pi-runtime**: 便携 Node.js + npm install pi 包 + 生成 `pi.cmd`/`pi` 启动脚本
- **updater 签名**: Tauri 内置 minisign 签名，构建时用 `TAURI_SIGNING_PRIVATE_KEY` 环境变量签名 setup.exe

---

## 4. 关键目录与文件

```
ht-logistic-workspace/
├── tauri-app/
│   ├── src/
│   │   ├── App.tsx              # 主界面：会话/chat/工具区/文件侧栏/设置/更新检查
│   │   ├── styles.css           # 全局样式：双主题 + 布局 + 组件
│   │   ├── FileBrowser.tsx      # 文件浏览器：双 tab + 拖拽 + 分析按钮
│   │   ├── ToolsPanel.tsx       # 物流工具区：选文件→调 sidecar→保存→解读
│   │   ├── Markdown.tsx         # Markdown 渲染（含 GFM、代码高亮）
│   │   ├── Chart.tsx            # chart.js 图表渲染
│   │   ├── CommandPalette.tsx   # 斜杠命令面板
│   │   ├── ExtensionManager.tsx # Pi 扩展管理
│   │   ├── pi-client.ts         # Pi 事件类型定义
│   │   ├── types.ts             # 共享类型
│   │   ├── utils.ts             # rebuildTurnsFromMessages / isTutorialWelcome（教程过滤）
│   │   └── updater.ts           # 自动更新封装：checkUpdate / downloadAndInstallUpdate
│   ├── src-tauri/
│   │   ├── src/main.rs          # Rust 后端：Pi RPC + sidecar + 文件命令 + updater 插件注册
│   │   ├── capabilities/default.json  # 权限配置（含 updater:default / process:default）
│   │   ├── tauri.conf.json      # Tauri 配置（含 plugins.updater + bundle.resources + createUpdaterArtifacts）
│   │   └── Cargo.toml           # 含 tauri-plugin-updater / tauri-plugin-process
│   ├── package.json             # 注意：npm 命令必须在此目录运行
│   └── vite.config.ts
├── python-sidecar/
│   ├── main.py                  # FastAPI 入口
│   ├── ht-sidecar.spec          # PyInstaller 打包配置（datas 只打包存在的目录）
│   ├── tools/                   # 工具实现（纯函数：输入 bytes，输出 bytes/JSON）
│   │   ├── invoice_packing.py   # 引用 tools/templates/（用户提供的 Excel 模板）
│   │   ├── data_analysis.py
│   │   ├── customs_generator.py
│   │   ├── customs_extractor.py
│   │   └── ...
│   ├── requirements.txt
│   └── setup.ps1
├── pi-extensions/
│   ├── all-in-one.ts            # 注册 logistic_* 工具，HTTP 调 sidecar
│   └── install.ps1
├── pi-agent-config/
│   ├── SYSTEM.md
│   └── skills/
├── scripts/
│   ├── build-installer.ps1      # Windows 一键打包（sidecar + pi-runtime + NSIS + latest.json）
│   ├── build-installer.sh       # macOS/Linux 一键打包
│   └── install-python.ps1
├── PROJECT_HANDOFF.md           # 原始交接文档（产品方向 + 约束）
├── CODEX_SUMMARY.md             # 本文件
├── dev.ps1                      # 一键启动（sidecar + tauri dev）
└── deploy.ps1
```

---

## 5. 最近迭代成果（按时间倒序）

### 本轮：傻瓜包工程收尾（7z 压缩 + installer-hooks + 模型配置 + 发布链路加固）

**7z 压缩方案（绕过 NSIS MAX_PATH 260）**：
- `pi-runtime/` 整个目录压成单文件 `pi-runtime.7z` 作为 Tauri resource 打包
- 首次启动时 Rust 用 `sevenz-rust2` crate 解压到 `%LOCALAPPDATA%\ht-logistic\pi-runtime\`（用户可写、路径短）
- `tauri.conf.json` 的 `bundle.resources` 从 `"pi-runtime/"` 改为 `"pi-runtime.7z": "./pi-runtime.7z"`
- `main.rs` 新增 `ensure_pi_runtime_extracted()`：首次启动解压，已解压则跳过
- 彻底绕过 NSIS MAX_PATH 问题（之前 `C:\ht-build\` 短路径方案已废弃）

**installer-hooks.nsh（NSIS 安装前杀进程）**：
- 新增 `src-tauri/installer-hooks.nsh`，`NSIS_HOOK_PREINSTALL` 钩子 `taskkill /F` 残留的 `HT Logistic Agent.exe` 和 `ht-sidecar.exe`
- 解决"安装时无法打开要写入的文件 ht-sidecar"错误（旧进程锁文件）
- `main.rs` 窗口关闭处理器改为同时杀 Pi 和 sidecar（不只杀 sidecar）

**模型配置模块更新**：
- `ModelConfig::default()` 更新默认 provider 和模型：DeepSeek v4-flash/pro、OpenAI gpt-4.1、Anthropic sonnet-4-5、Gemini 2.5、OpenRouter
- `get_model_config` 命令加迁移合并逻辑：把默认 provider 列表合并进用户已保存的配置，覆盖 models/base_url/name，但保留用户的 api_key/enabled
- 新增 `test_model_connection` 命令：用 reqwest 发 `max_tokens=1` 的最小请求验证 API key（支持 OpenAI-compatible + Anthropic Messages API）
- 前端设置页加"测试连接"按钮 + 结果显示

**open_update_folder 命令**：
- 更新失败时用户找不到已下载的 setup.exe，新增命令扫描 `%TEMP%` 找 `*-setup.exe` 并打开 explorer
- 前端更新错误状态加"打开更新文件夹"按钮

**发布链路加固（build-and-release.ps1）**：
- **4e STRONG ASSERT**：构建后断言 latest.json 的 url 和 signature 都包含当前版本号，不匹配直接 exit 1，防止上传坏版本
- **url 自动修正**：Tauri 默认 url 用空格（本地文件名），GitHub asset 用点（自动替换），脚本自动改 url 为 GitHub asset 实际名
- **signature 自动修正**：从 `.sig` 文件读取签名覆盖 latest.json（保证与当前 setup.exe 匹配）
- **stale bundle 清理**：`build-installer.ps1` 在 `tauri build` 前删 `target/release/bundle/nsis/`，防止旧版本号 setup.exe 残留被误选
- **setup.exe 版本匹配**：`build-and-release.ps1` 优先选文件名匹配当前版本号的 setup.exe，找不到才 fallback
- **version bump 自动 push**：构建和 release 成功后自动 `git push origin main`，防止远程版本号落后导致下次 bump 到同版本号
- **Manifest 描述统一**：`$filesToUpload` 的 Desc 统一为 "Updater manifest"，加空路径断言防止 gh release create 漏传 latest.json
- **PowerShell 5.x 兼容**：所有 .ps1 脚本清除非 ASCII 字符（中文注释、em-dash），防止 PS 5.x 把 UTF-8 no-BOM 文件按 ANSI/GBK 读导致解析错误

### 上一轮：自动更新 + 打包流程完善

**自动更新（手动检查模式）**：
- 接入 `tauri-plugin-updater` + `tauri-plugin-process`
- `tauri.conf.json` 加 `plugins.updater` 配置（endpoint 指向 GitHub Release latest.json）
- `capabilities/default.json` 加 `updater:default` + `process:default` 权限
- 前端 `src/updater.ts` 封装 checkUpdate / downloadAndInstallUpdate（含进度回调 + relaunch）
- App.tsx 设置面板加"关于与更新"区块：当前版本 + 检查更新按钮 + 发现新版本/下载进度/错误状态 UI
- `build-installer.ps1` / `.sh` 末尾生成 `latest.json`（含 version/notes/pub_date/platforms.signature/url）
- `tauri.conf.json` 设 `createUpdaterArtifacts: true`，构建自动生成 `.sig` 签名文件

**打包流程修复（Windows NSIS）**：
- `resources` 用 glob `ht-sidecar*` 适配跨平台（Linux 无 .exe 后缀）
- `targets` 改为 `["nsis"]`，跳过 WiX MSI 打包失败的坑
- spec 文件 datas 只打包实际存在的目录（`tools/templates/` 缺失时跳过）
- 清理 pi-runtime 里的 `.d.ts`/`.ts`/`.map`/测试文件（aws-sdk 等路径超 MAX_PATH）
- pyinstaller/npm 输出重定向到日志文件，失败时打印尾部 50 行

**Pilot 身份与教程过滤**：
- `spawn_pi` 加 `--append-system-prompt` CLI 参数硬注入 Pilot 身份（比 APPEND_SYSTEM.md 自动加载可靠）
- `utils.ts` 的 `isTutorialWelcome` 加中文签名（"欢迎来到 Pi"、"我是 Pi"等），移除空 userMessage 检查
- App.tsx `agent_end` 处理器同步移除 userMessage 检查，实时流和历史会话都过滤教程欢迎语

**UI 微调**：
- 工具执行区 `.tools-detail` 改 `align-self: stretch` + `overflow-y: auto`（按钮不再被裁切）
- Markdown 段落间距收紧（line-height 1.55，p margin 4px）
- 会话切换加 `setSwitching(true)` + `requestAnimationFrame` 平滑过渡
- 历史会话标题条按会话名动态显示

### 更早的迭代（见 git log）

- `a962816` 代码审查修复 + UI 美学升级（16 项）
- `622b82f` 侧栏 300px + 工具区去白背景
- `70f882b` 聊天区滚动 + 工作目录入口
- `36c600f` 文件管理区联动聊天 + 历史会话续聊

---

## 6. 架构关键点（容易踩坑的地方）

### 6.1 Pi 子进程管理

- **Pi 由 Rust 主进程启动**，不由 Python sidecar 启动。
- 启动方式：`pi --mode rpc --append-system-prompt <Pilot身份>`，通过 stdin/stdout JSON-RPC 通信。
- **Pilot 身份注入**：用 `--append-system-prompt` CLI 参数比依赖 `~/.pi/agent/APPEND_SYSTEM.md` 自动加载更可靠。
- 续聊历史会话：用 `pi --session <path>` 重启 pi 进程（不要用 `switch_session` RPC，RPC 模式下不可靠）。
- `restart_pi(cwd, sessionPath)` 是统一入口：切换工作目录、续聊历史会话都走它。
- 前端通过 `listen("pi-event")` 和 `listen("pi-stderr")` 接收事件。
- `process_gen` AtomicU64 代际号：restart 后旧进程退出不误报 `pi_process_exit`。

### 6.2 find_pi() 优先级链（傻瓜包模式）

```
1. 打包内嵌 pi-runtime/（current_exe 向上找 6 层 + cwd 向上找）
   → pi-runtime/pi.cmd (Windows) 或 pi-runtime/pi (macOS/Linux)
   → 内部调用 pi-runtime/node.exe 运行 pi-runtime/node_modules/@earendil-works/pi-coding-agent
2. 系统 PATH 查找（用户自己装了 pi）
3. Windows npm 全局目录（APPDATA/npm, USERPROFILE/AppData/Roaming/npm）
```

### 6.3 教程欢迎语过滤

Pi 首次会话会输出教程式欢迎语（中英文都有），需要过滤掉：
- `utils.ts` 的 `isTutorialWelcome(userMessage, assistantText)` 纯按 assistantText 签名匹配
- 签名列表：`"Welcome to Pi"`、`"interactive tutorial"`、`"agentic coding environment"`、`"欢迎来到 Pi"`、`"我是 Pi"`、`"教程之旅"`、`"你想搭个什么小工具"` 等
- **不要加 userMessage 空检查**：Pi 会把教程作为对首条消息的回复输出
- `rebuildTurnsFromMessages`（历史）和 `agent_end` 处理器（实时流）都要过滤

### 6.4 布局与滚动（critical）

- `.app` 用 CSS Grid：`grid-template-rows: var(--header-h) 1fr`。
- `.main` 必须是 `overflow: hidden` + `grid-template-rows: minmax(0, 1fr) auto auto`。
  - **绝对不能改成 `overflow: visible`**：会让 grid 行高约束失效，消息把 composer 顶出屏幕且无法滚动。
- `.messages` 内部 `overflow-y: auto`，滚动按钮 `position: absolute` 放在 `.messages` 内部。

### 6.5 下拉框：Portal + fixed

- 模型/权限下拉用 `createPortal` 渲染到 `document.body`，`position: fixed`。
- 定位：按钮 `getBoundingClientRect()` → `setDropdownPos({ left, bottom, width })`。

### 6.6 工作目录（workdir）

- localStorage key: `pi-workdir`。空字符串 = 不设定。
- 切换会重启 pi 进程（`restart_pi(cwd, null)`），新建会话的 `--cwd` 也基于此路径。
- workdir 显示在顶栏右侧按钮上，显示目录 basename。

### 6.7 权限模式（三档）

localStorage key: `pi-permission-mode`，值：`cautious` / `workspace`（默认推荐）/ `trust`。
Pi 事件 `extension_ui_request` 的 `method` 字段：`select` / `confirm` / `input` / `editor`。权限模式通过拦截 `confirm` 实现差异化放行。

### 6.8 工具区 ↔ sidecar

- 前端用 Tauri `readFile` 读本地文件为字节数组，包成 `File` 再 `FormData` 上传。
- **不能用 `fetch('file://...')`**：Tauri webview 默认禁止 file:// 协议。
- 文件型结果：弹原生保存对话框 → `invoke("write_binary_file")` 写盘。
- JSON 型结果：直接展示，可一键"让助手解读"。

### 6.9 自动更新机制

- **endpoint**: `https://github.com/jameszeng222/ht-logistic-workspace/releases/latest/download/latest.json`
- **latest.json 结构**: `{ version, notes, pub_date, platforms: { "windows-x86_64": { signature, url } } }`
- **签名环境变量（Tauri v2 官方名，别写错）**: `TAURI_SIGNING_PRIVATE_KEY`（私钥内容或路径）+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（密码，空密码可省）。**注意不是 `TAURI_PRIVATE_KEY` / `TAURI_KEY_PASSWORD`**——后者不生效，`.sig` 不会生成。见 https://v2.tauri.app/reference/environment-variables/
- **公钥**: 已写入 `tauri.conf.json` 的 `plugins.updater.pubkey`（`RW` 开头，minisign 格式）
- **installMode**: `passive`（Windows 更新时显示小进度条窗口，无需用户交互）
- **当前状态**: 代码已接入（插件注册 + 前端 UI + 脚本生成 latest.json），但**必须满足以下条件自动更新才真正可用**：
  1. `tauri.conf.json` 的 `pubkey` 已替换为真实公钥（✅ 已完成）
  2. 构建时设了 `TAURI_SIGNING_PRIVATE_KEY` 环境变量（生成 `.sig`）
  3. GitHub Release 已上传 `setup.exe` + `setup.exe.sig` + `latest.json` 三件套
  4. Release 的 tag 版本号与 `latest.json` 里 `version` 一致
- **当前模式**: 手动检查（设置页"检查更新"按钮）。启动时自动检查留到后续（用户明确说晚点做）。
- **首次启用 cold-start**: 老版本（无 updater 插件）无法自动更新，需手动下载一次新版。

### 6.10 打包流程关键点（Windows）

- **NSIS MAX_PATH 260 限制（已彻底解决）**: pi-runtime 里 aws-sdk/mistralai 等包的 `.d.ts`/`.js` 路径超长，NSIS `makensis` 用 ANSI Win32 API 硬性失败。**当前方案**：把 pi-runtime 整个目录压成 `pi-runtime.7z` 单文件作为 Tauri resource 打包，首次启动时 Rust 用 `sevenz-rust2` 解压到 `%LOCALAPPDATA%\ht-logistic\pi-runtime\`。旧的 `C:\ht-build\` 短路径方案已废弃。
- **installer-hooks.nsh**: NSIS `NSIS_HOOK_PREINSTALL` 钩子 `taskkill /F` 残留进程，解决"安装时无法打开要写入的文件 ht-sidecar"（旧进程锁文件）。
- **resources 配置**: `ht-sidecar*` glob 适配跨平台，`pi-runtime.7z` 单文件。
- **targets 只用 nsis**: WiX MSI 打包会失败，且不需要两种安装包格式。
- **PowerShell NativeCommandError**: pyinstaller/npm 把 INFO 日志写到 stderr，PowerShell 当错误抛。用 `cmd /c "... > log.txt 2>&1"` 重定向。
- **PowerShell 5.x 编码陷阱**: PS 5.x 把 UTF-8 no-BOM 文件按 ANSI/GBK 读，中文注释/em-dash 会破坏解析器。所有 .ps1 脚本必须 ASCII-only，或保存为 UTF-8 with BOM。
- **stale bundle 清理**: `build-installer.ps1` 在 `tauri build` 前删 `target/release/bundle/nsis/`，防止旧版本号 setup.exe 残留被 `Get-ChildItem *-setup.exe | Select -First 1` 误选。

---

## 7. 重要设计约束（不要违反）

1. **不要把工具区做成单独页面**。助手和工具必须同屏。
2. **不要恢复会话分支/Fork UI**。`BranchNavigator.tsx` 是历史残留文件，`App.tsx` 已不引用，后续可删除（别误以为它在用）。
3. **不要让报关工具抢主界面**。保留在后端和 extension。当前左侧栏会显示所有工具（含报关），如需降级显示改 `App.tsx` 的 `toolsList.map`。
4. **不要让 UI 回到重分隔线风格**。用背景层次、留白、轻边框、hover 状态。
5. **不要让 Python sidecar 启动 Pi**。Pi 由 Rust 主进程管理。
6. **不要把 `.main` 改成 `overflow: visible`**。会导致聊天溢出且无法滚动。
7. **npm 命令必须在 `tauri-app/` 目录运行**。仓库根目录没有 `package.json`。
8. **教程过滤不要加 userMessage 空检查**。Pi 会把教程作为对首条消息的回复输出。
9. **Pilot 身份用 `--append-system-prompt` CLI 参数**，不要只靠 APPEND_SYSTEM.md 自动加载。
10. **Tauri v2 签名环境变量是 `TAURI_SIGNING_PRIVATE_KEY`**（不是 `TAURI_PRIVATE_KEY`），写错名 `.sig` 不会生成。

---

## 8. 运行方式

### 首次安装（开发模式）

```powershell
# Python sidecar 依赖
cd python-sidecar
.\setup.ps1

# Pi extension 安装
cd ..\pi-extensions
.\install.ps1

# 前端依赖
cd ..\tauri-app
npm install
```

### 开发启动

```powershell
# 仓库根目录一键启动（sidecar + tauri dev）
.\dev.ps1
```

### 构建安装包（傻瓜包分发）

**Windows**:
```powershell
# 1. 生成 updater 签名密钥（一次性）
cd tauri-app
npm run tauri signer generate -- -w $HOME/.tauri/ht-logistic.key
# 记下输出的公钥，替换 tauri.conf.json 里的 plugins.updater.pubkey
# （本项目已替换，重新生成密钥时才需要再换）

# 2. 设置私钥环境变量（每次构建前）
#    注意：Tauri v2 官方变量名是 TAURI_SIGNING_PRIVATE_KEY，不是 TAURI_PRIVATE_KEY
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $HOME/.tauri/ht-logistic.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'your-password-if-set'  # 空密码可省略

# 3. 一键打包
cd ..
.\scripts\build-installer.ps1
```

**macOS/Linux**:
```bash
export TAURI_SIGNING_PRIVATE_KEY=$(cat $HOME/.tauri/ht-logistic.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='your-password-if-set'  # 空密码可省略
bash scripts/build-installer.sh
```

构建产物（Windows）：
```
tauri-app\src-tauri\target\release\bundle\nsis\
  ├─ HT Logistic Agent_0.1.5_x64-setup.exe      # 安装包
  ├─ HT Logistic Agent_0.1.5_x64-setup.exe.sig  # updater 签名
  └─ latest.json                                # updater manifest
```

### 发布新版本（一键脚本）

```powershell
# 推荐：一键 bump 版本 + 构建 + 创建 GitHub Release + 上传 3 文件 + push
.\scripts\build-and-release.ps1

# 可选参数：
#   -Version 0.1.6          指定版本号（默认自动 +0.0.1）
#   -SkipVersionBump        不 bump 版本，用当前
#   -KeyPath "..."          签名私钥路径（默认 $env:USERPROFILE\.tauri\ht-logistic.key）
```

脚本内部流程：
1. 自动 bump `tauri.conf.json` 的 version + commit
2. 设置签名环境变量
3. 调 `build-installer.ps1` 构建（先清 nsis bundle 目录防 stale）
4. 4e STRONG ASSERT 校验 latest.json url/signature 匹配当前版本
5. 用 gh CLI 创建 Release 并上传 3 文件（setup.exe + .sig + latest.json）
6. 自动 push version bump commit 到远程
7. 客户端设置页"检查更新"即可拉到新版

### 测试

```powershell
cd tauri-app
npm run test       # 前端测试
npm run build      # 前端构建验证
```

---

## 9. 常见问题排查

### sidecar 不在线

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```
检查 `python-sidecar/.venv` 是否创建、8000 端口是否占用、`python-sidecar/.sidecar.err` 日志。

### Pi 找不到

`find_pi()` 优先查打包内嵌的 `pi-runtime/`，再查 PATH 和 Windows npm 全局目录。开发模式需确认已安装 Pi CLI。

### 打包失败：NSIS "failed opening file"

当前已用 7z 压缩方案彻底绕过：pi-runtime 压成单文件 `pi-runtime.7z` 打包，不再有超长路径。如果仍报此错，检查 `tauri.conf.json` 的 `bundle.resources` 是否还是 `"pi-runtime/"`（旧配置），应改为 `"pi-runtime.7z": "./pi-runtime.7z"`。

### 打包失败：PyInstaller "Unable to find tools/templates"

`tools/templates/` 目录不存在（用户没放 Excel 模板）。spec 文件已改为只打包存在的目录，缺失时跳过。运行时 invoice_packing.py 会报 FileNotFoundError 友好提示。

### 打包失败：PowerShell NativeCommandError

pyinstaller/npm 把 INFO 日志写到 stderr，PowerShell 当错误。脚本已用 `cmd /c "... > log.txt 2>&1"` 重定向，失败时打印日志末尾 50 行。

### 更新检查失败

- 确认 `tauri.conf.json` 的 `pubkey` 已替换为真实公钥（不是占位符）
- 确认 GitHub Release 已上传 `latest.json` + `setup.exe.sig` + `setup.exe`
- 确认 Release 的 tag 版本号与 `latest.json` 里的 `version` 一致
- 确认 `TAURI_SIGNING_PRIVATE_KEY` 构建时已设置（否则 .sig 为空）

### 聊天区无法滚动 / composer 被顶出屏幕

检查 `.main` 是否 `overflow: hidden`。若被改成 `visible`，改回来。

### 历史会话无法续聊

不要用 `switch_session` RPC。用 `restart_pi(cwd, sessionPath)` 重启 pi 进程。

### Pi 自称是"Pi 编程助手" / 输出教程欢迎语

- 确认 `--append-system-prompt` 参数传了 Pilot 身份提示词
- 确认 `isTutorialWelcome` 签名列表覆盖了 Pi 输出的教程文本
- 确认 `agent_end` 处理器和 `rebuildTurnsFromMessages` 都调用了过滤

---

## 10. 后续建议（按优先级）

### P0：完善自动更新
- 加启动后 5 秒自动检查（只提示，不自动安装）
- latest.json 的 notes 字段从 git commit log 或 CHANGELOG.md 读取，而非硬编码
- 考虑增量更新 pi-runtime（当前每次更新重下 80MB+ 整包）

### P0：让工具更像真正物流工作流
- `invoice-packing` 增加字段校验报告：缺失万邑通单号 / SKU / 品名 / 数量 / 单价
- 输出前展示预检结果，用户确认后再生成
- 执行结果返回结构化摘要，让助手能说明生成了哪些单、哪些失败

### P0：增强数据分析
- 前端直接渲染图表（数值列直方图、分类 Top N、时间趋势、相关性热力图）
- 让助手读取分析 JSON 生成业务建议

### P1：文件侧栏和聊天联动增强
- 文件右键：用当前选中文件执行工具
- 聊天框引用当前选中文件路径
- 工具执行结果自动出现在文件侧栏

### P1：会话体验
- 项目工作区切换
- 左侧显示「当前项目」下最近会话
- 新建会话继承当前项目目录

---

## 11. 给 Codex 的修改提示词

可以直接把下面这段给 Codex：

```text
你在维护 HT Logistic Workspace。它是 Tauri v2 + React + Python FastAPI sidecar + Pi extension 的本地物流 AI 工作台，已支持傻瓜包分发（内嵌 Python sidecar + 便携 Node.js + pi 包）和手动检查更新（Tauri updater + GitHub Release）。

产品方向：
- 助手、物流工具区、文件侧栏必须同屏。
- 高频业务是单据制作和 Excel 数据分析。
- 报关工具保留但不是主界面重点。
- UI 接近 Codex/轻客户端风格：浅色、少分隔线、留白、轻边框、支持主题切换。

关键约束：
- .main 必须 overflow: hidden，否则聊天溢出且无法滚动。
- 下拉框用 createPortal + position: fixed，不要靠改父容器 overflow。
- Pi 由 Rust 主进程管理，不由 Python sidecar 启动。
- Pi 启动必须带 --append-system-prompt 参数注入 Pilot 身份。
- 续聊历史会话用 restart_pi(cwd, sessionPath)，不要用 switch_session RPC。
- 工作目录切换后必须 await loadHistory() 同步界面。
- npm 命令必须在 tauri-app/ 目录运行。
- 教程过滤（isTutorialWelcome）不要加 userMessage 空检查。
- 打包时 pi-runtime 压成 pi-runtime.7z 单文件作为 resource，首启解压到 %LOCALAPPDATA%，绕过 NSIS MAX_PATH。

关键文件：
- tauri-app/src/App.tsx：主界面（含设置页"关于与更新"区块）
- tauri-app/src/updater.ts：自动更新封装（checkUpdate / downloadAndInstallUpdate）
- tauri-app/src/utils.ts：isTutorialWelcome 教程过滤
- tauri-app/src/styles.css：双主题 + 布局 + 组件
- tauri-app/src/FileBrowser.tsx：文件浏览器
- tauri-app/src/ToolsPanel.tsx：物流工具区
- tauri-app/src-tauri/src/main.rs：Pi RPC + sidecar + 文件命令 + find_pi（pi-runtime 优先）
- tauri-app/src-tauri/tauri.conf.json：含 plugins.updater + bundle.resources + createUpdaterArtifacts
- tauri-app/src-tauri/capabilities/default.json：含 updater:default + process:default 权限
- python-sidecar/main.py 和 python-sidecar/tools/：物流工具 API
- python-sidecar/ht-sidecar.spec：PyInstaller 配置（datas 只打包存在的目录）
- pi-extensions/all-in-one.ts：AI agent 可调用工具
- scripts/build-installer.ps1：Windows 一键打包（含 latest.json 生成）

修改时请保持：
- Python sidecar 只做工具 API，不启动 Pi。
- 工具函数尽量输入 bytes、输出 bytes/JSON。
- 前端工具区默认只展示 invoice-packing 和 data-analysis。
- 构建验证至少运行：cd tauri-app && npm run build。
- 修改 .main 的 overflow 前必须确认不会破坏聊天滚动。
- 改 tauri.conf.json 的 resources 后要确认跨平台 glob 不会因路径不存在失败。
- 改 updater 配置后要确认 pubkey 已替换为真实公钥（不是占位符）。
```

---

## 12. 当前仓库状态

- 主分支：`main`
- 远程：`https://github.com/jameszeng222/ht-logistic-workspace.git`
- 当前版本：0.1.5（tauri.conf.json 与 tauri-app/package.json 已同步）
- 近期工作：7z 压缩方案 + installer-hooks + 模型配置更新 + 发布链路加固（4e ASSERT / stale bundle 清理 / Manifest 描述统一 / PS 5.x 编码兼容）
- 总代码量：约 7000 行（App.tsx + styles.css + FileBrowser + ToolsPanel + main.rs + updater.ts）

后续最值得投入的方向：完善自动更新（启动时检查 + 增量更新）、把「工具执行结果」变成结构化业务反馈、让 AI 能基于这些反馈给出可执行建议。
