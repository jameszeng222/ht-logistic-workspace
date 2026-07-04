# HT Logistic Workspace — 阶段总结（给 Codex 接力）

本文档面向接力的 AI 编程助手（Codex 等）。它总结了项目当前形态、最近迭代的成果、架构关键点、已知约束和后续建议。读完这一份就能继续开发，不需要回溯历史对话。

---

## 1. 项目一句话

HT Logistic Workspace 是一个**本地桌面物流 AI 工作台**：Tauri v2 + React 做客户端，Rust 管 Pi RPC 子进程和本地文件/会话，Python FastAPI sidecar 承载 Excel/PDF 物流工具，Pi extension 把工具暴露给 AI agent 调用。

**产品方向（用户明确强调）**：不要做成泛 AI 聊天页面，要做成「物流工具 + AI 助手 + 文件侧栏」同屏工作台。高频业务是**单据制作**和**数据分析**，报关处理不是当前重点。

---

## 2. 当前产品形态

主页面三栏布局：

- **左侧（300px）**：会话管理，按项目名分组（不按完整目录）。已删除会话分支/Fork 入口。
- **中间**：AI 助手聊天区。空状态有 📦 图标 + 3 个示例 prompt chip。聊天框居中偏上，composer 拆分为两组 pill（左：附件/模型/权限，右：单据制作/数据分析/工具调用）。
- **中间下方**：物流工具区。透明背景与主区融合，优先展示 `invoice-packing` 和 `data-analysis`，工具执行结果可一键发给助手解读。
- **右侧（326px）**：文件浏览器。支持目录浏览、双 tab（工作目录/会话目录）、文件拖拽到聊天框、"分析"按钮加入附件。

**视觉风格**：Codex/轻客户端调性，浅色默认，少分隔线，多用留白、圆角、hover 状态和轻阴影。支持深色/浅色主题切换（顶栏 ☀️/🌙 按钮）。

---

## 3. 技术栈

### 桌面客户端
- Tauri v2（Rust 后端命令 + React 前端）
- React 18 + Vite 5 + TypeScript
- `@tauri-apps/plugin-dialog`（原生文件/目录选择）
- `@tauri-apps/plugin-fs`（读本地文件为字节数组）
- `react-markdown` + `remark-gfm` + `chart.js` + `react-chartjs-2`

### 工具 sidecar
- Python 3.10+（推荐 3.11/3.12，3.13+ 在 Windows 可能缺预编译 wheel）
- FastAPI on `127.0.0.1:8000`
- pandas / openpyxl / pdfplumber / pytesseract（OCR 可选）

### Agent / Pi
- Pi 以 `pi --mode rpc` 由 Tauri Rust 主进程启动
- `pi --session <path>` 用于续聊历史会话（restart_pi 命令）
- Pi extension: `~/.pi/agent/extensions/all-in-one.ts`
- Agent 配置: `~/.pi/agent/SYSTEM.md` + `~/.pi/agent/skills/`

---

## 4. 关键目录与文件

```
ht-logistic-workspace/
├── tauri-app/
│   ├── src/
│   │   ├── App.tsx              # 主界面（1891 行）：会话/chat/工具区/文件侧栏/设置
│   │   ├── styles.css           # 全局样式（2428 行）：双主题 + 布局 + 组件
│   │   ├── FileBrowser.tsx      # 文件浏览器（396 行）：双 tab + 拖拽 + 分析按钮
│   │   ├── ToolsPanel.tsx       # 物流工具区（355 行）：选文件→调 sidecar→保存→解读
│   │   ├── Markdown.tsx         # Markdown 渲染（含 GFM、代码高亮）
│   │   ├── Chart.tsx            # chart.js 图表渲染
│   │   ├── CommandPalette.tsx   # 斜杠命令面板
│   │   ├── ExtensionManager.tsx # Pi 扩展管理
│   │   ├── pi-client.ts         # Pi 事件类型定义
│   │   ├── types.ts             # 共享类型
│   │   └── utils.ts             # rebuildTurnsFromMessages 等工具
│   ├── src-tauri/src/main.rs    # Rust 后端（1382 行）：Pi RPC + sidecar + 文件命令
│   ├── package.json             # 注意：npm 命令必须在此目录运行
│   └── vite.config.ts
├── python-sidecar/
│   ├── main.py                  # FastAPI 入口
│   ├── tools/                   # 工具实现（纯函数：输入 bytes，输出 bytes/JSON）
│   │   ├── invoice_packing.py
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
├── PROJECT_HANDOFF.md           # 原始交接文档（产品方向 + 约束）
├── CODEX_SUMMARY.md             # 本文件
├── dev.ps1                      # 一键启动（sidecar + tauri dev）
└── deploy.ps1
```

---

## 5. 最近迭代成果（按时间倒序）

最近 4 个 commit 是本轮工作的核心，已全部推送到 `origin/main`。

### commit `a962816` — 代码审查修复 + UI 美学升级（16 项）

**Bug 修复（4 项）**：
1. `applyWorkdir` 重启 pi 后追加 `await loadHistory()` 同步历史，避免工作目录切换后界面空白
2. `--header-h` 56→60px，与实际顶栏高度对齐（影响 `.app` grid 行高）
3. workdir 末尾分隔符 `replace(/[\\/]+$/, "")` 后再 split，修复 `C:\Users\` 返回空字符串
4. `send()` 对 busy/未连接/预览态给出友好 toast，避免用户不知道为何没反应

**UI 改进（12 项）**：
6. 用户气泡 `max-width: 75%`，避免长消息横占满屏
7. AI 消息加 🤖 头像 + "Pi" 名称标签（44px 列）
8. ToolCard 去白底，透明背景与主区融合
9. 思维链折叠重设计：左侧 2px 线 + 旋转 ▸ 箭头 + 字数提示
10. composer 阴影 `shadow-lg`→`shadow-sm` + `focus-within` 主色 ring
11. 工作目录按钮右移至 header-spacer 之后，与主题/日志按钮聚成右侧组
12. 滚动按钮移入 `.messages` 内部，`position: absolute; bottom: var(--space-4)`
13. 空状态加 📦 图标 + 3 个示例 prompt chip（分析 Excel / 装箱单 / 运费汇总）
14. 会话列表相对时间（已存在，无需改）
15. composer-pill 拆分为左右两组（左：附件/模型/权限；右：快捷 prompt）
16. 顶栏新增 ☀️/🌙 主题切换按钮

### commit `622b82f` — 侧栏 300px + 删提示行 + 工具区去白背景

- `--sidebar-w: 276px → 300px`
- 删除 composer 下方的 "Enter 发送 · Shift+Enter 换行 · Esc 清空 · 物流工具在下方执行…"
- 工具区重设计：去白色卡片背景，改用透明 + 顶部 1px 分隔线 + 表面 hover

### commit `70f882b` — 聊天区滚动 + 工作目录入口 + 侧栏加宽 + 顶栏留白

- `.main` 从 `overflow: visible` 改回 `overflow: hidden`（修复聊天溢出把 composer 顶出屏幕的 critical bug）
- 顶栏新增显眼的 `📁 工作目录` 按钮（primary-soft 背景），替代设置面板里的隐藏入口
- `--header-h: 56px → 60px`，顶栏 padding 上多下少
- 工作目录切换：`restart_pi(cwd, null)` 重启 pi + `loadHistory()` 同步

### commit `36c600f` — 文件管理区联动聊天 + 工作目录设定 + 历史会话续聊

- FileBrowser 文件项加 `draggable` + `onDragStart`，拖到聊天框作为附件
- FileBrowser 每个文件加"分析"按钮，点击加入聊天附件
- `applyWorkdir` 实现：trim 路径 → `restart_pi` → 重置 turns → `loadHistory()`
- 历史会话续聊：`switch_session` RPC 在 RPC 模式下不可靠，改用 `pi --session <path>` 重启 pi 进程
- Tauri `restart_pi` Rust 命令：`cwd` + `sessionPath` 双参数，`spawn_pi`/`stop_pi_inner` 提取复用

---

## 6. 架构关键点（容易踩坑的地方）

### 6.1 Pi 子进程管理

- **Pi 由 Rust 主进程启动**，不由 Python sidecar 启动。避免双进程同时启动 Pi 导致会话冲突。
- 启动方式：`pi --mode rpc`，通过 stdin/stdout JSON-RPC 通信。
- 续聊历史会话：用 `pi --session <path>` 重启 pi 进程（不要用 `switch_session` RPC，在 RPC 模式下不可靠）。
- `restart_pi(cwd, sessionPath)` 是统一入口：切换工作目录、续聊历史会话都走它。
- 前端通过 `listen("pi-event")` 和 `listen("pi-stderr")` 接收事件。

### 6.2 布局与滚动（critical）

- `.app` 用 CSS Grid：`grid-template-rows: var(--header-h) 1fr`。
- `.body` 用 CSS Grid：`grid-template-columns: var(--sidebar-w) 1fr` 或三栏。
- `.main` 必须是 `overflow: hidden` + `grid-template-rows: minmax(0, 1fr) auto auto`。
  - **绝对不能改成 `overflow: visible`**：会让 grid 行高约束失效，消息把 composer 顶出屏幕且无法滚动。
  - 历史上为修 dropdown 裁切改过 visible，后来用 Portal 解决了裁切，visible 必须改回 hidden。
- `.messages` 内部 `overflow-y: auto`，滚动按钮 `position: absolute` 放在 `.messages` 内部。

### 6.3 下拉框：Portal + fixed

- 模型/权限下拉用 `createPortal` 渲染到 `document.body`，`position: fixed`。
- 定位：按钮 `getBoundingClientRect()` → `setDropdownPos({ left, bottom, width })`。
- 这样彻底脱离所有父容器 `overflow` 裁切，不需要改 `.main` 的 overflow。

### 6.4 工作目录（workdir）

- localStorage key: `pi-workdir`。空字符串 = 不设定（沿用 Tauri 进程 cwd）。
- 切换工作目录会重启 pi 进程（`restart_pi(cwd, null)`），新建会话的 `--cwd` 也基于此路径。
- "输入和输出的文件都在工作目录"自然成立，文件浏览器默认定位到这里。
- workdir 显示在顶栏右侧按钮上，显示目录 basename（用 `replace(/[\\/]+$/, "").split(/[\\/]/).pop()` 取末段）。

### 6.5 权限模式（三档）

localStorage key: `pi-permission-mode`，值：`cautious` / `workspace` / `trust`。

- `cautious`：所有 confirm 都弹窗
- `workspace`（默认推荐）：只对"删除"等关键字弹窗，其余自动放行
- `trust`：所有 confirm 自动放行

Pi 事件 `extension_ui_request` 的 `method` 字段：`select` / `confirm` / `input` / `editor`。权限模式通过拦截 `confirm` 实现差异化放行。

### 6.6 文件浏览器 ↔ 聊天框联动

- 拖拽：FileBrowser 文件项 `draggable`，`onDragStart` 写 `text/plain` 和 `application/x-file-path`。聊天区 `onDrop` 读取路径加入附件。
- "分析"按钮：点击调用 `onPickFile(path)`，App 层把路径加入 `attachments`，发送时拼到消息里。

### 6.7 工具区 ↔ sidecar

- 前端用 Tauri `readFile` 读本地文件为字节数组，包成 `File` 再 `FormData` 上传。
- **不能用 `fetch('file://...')`**：Tauri webview 默认禁止 file:// 协议。
- 文件型结果：弹原生保存对话框 → `invoke("write_binary_file")` 写盘。
- JSON 型结果：直接展示，可一键"让助手解读"。
- "让助手解读"有 10 秒去重（同一工具+同一输入+同一结果）。

### 6.8 主题

- localStorage key: `pi-theme`，值：`dark` / `light` / `system`。
- 通过 `document.documentElement.setAttribute("data-theme", resolved)` 切换。
- 所有颜色用 CSS 变量 + `oklch()` + `color-mix(in oklch, ...)`，无硬编码颜色。

---

## 7. 重要设计约束（不要违反）

1. **不要把工具区做成单独页面**。助手和工具必须同屏，工具区在聊天框下面。
2. **不要恢复会话分支/Fork UI**。用户明确说对当前工作没用。
3. **不要让报关工具抢主界面**。保留在后端和 extension，前端工具区聚焦单据制作和数据分析。
4. **不要让 UI 回到重分隔线风格**。新增区域优先用背景层次、留白、轻边框、hover 状态。
5. **不要让 Python sidecar 启动 Pi**。Pi 由 Rust 主进程管理。
6. **不要把 `.main` 改成 `overflow: visible`**。会导致聊天溢出且无法滚动（已踩过坑）。
7. **npm 命令必须在 `tauri-app/` 目录运行**。仓库根目录没有 `package.json`。

---

## 8. 运行方式

### 首次安装

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

# 或手动分启
cd python-sidecar
.\..\dev.ps1   # 启动 sidecar

cd ..\tauri-app
npm run tauri dev
```

### 构建与测试

```powershell
cd tauri-app
npm run build      # 前端构建
npm run test       # 前端测试
npm run tauri build # 完整打包
```

### 部署验证

```powershell
.\deploy.ps1
```

---

## 9. 常见问题排查

### sidecar 不在线

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

失败时检查：
- `python-sidecar/.venv` 是否创建
- 8000 端口是否被占用
- `python-sidecar/.sidecar.err` 错误日志

### Pi 找不到

Rust `find_pi()` 找 PATH 和 Windows npm 全局目录（`%APPDATA%\npm`、`%USERPROFILE%\AppData\Roaming\npm`）。需确认已安装 Pi CLI 且 `pi.cmd` 可执行。

### better-sqlite3 安装失败

可选依赖。安装失败时 SQLite 相关工具禁用，物流工具不受影响。

### 聊天区无法滚动 / composer 被顶出屏幕

检查 `.main` 是否 `overflow: hidden`。若被改成 `visible`，改回来。

### 工作目录切换后界面空白

`applyWorkdir` 必须在 `restart_pi` 后调用 `await loadHistory()`。已修复，但若有人改这个函数要注意。

### 历史会话无法续聊

不要用 `switch_session` RPC（RPC 模式下不可靠）。用 `restart_pi(cwd, sessionPath)` 重启 pi 进程。

---

## 10. 后续建议（按优先级）

### P0：让工具更像真正物流工作流

- `invoice-packing` 增加字段校验报告：缺失万邑通单号 / SKU / 品名 / 数量 / 单价、单号重复、渠道识别失败
- 输出前展示预检结果，用户确认后再生成
- 执行结果返回结构化摘要，让助手能说明生成了哪些单、哪些失败、为什么

### P0：增强数据分析

- `data-analysis` 输出目前是 JSON，下一步前端直接渲染图表
- 优先图表：数值列直方图、分类 Top N 条形图、时间列趋势图、相关性热力图
- 让助手读取分析 JSON 生成业务建议

### P1：文件侧栏和聊天联动增强

- 文件右键：用当前选中文件执行工具
- 聊天框引用当前选中文件路径
- 工具执行结果自动出现在文件侧栏/最近结果列表

### P1：会话体验

- 项目工作区切换（不只靠历史会话 cwd）
- 左侧显示「当前项目」下最近会话
- 新建会话继承当前项目目录

### P2：打包与安装

- 完善 PyInstaller sidecar 打包流程
- Tauri 打包时把 `python-sidecar/ht-sidecar.exe` 放进 resources
- 首次运行检测 Python sidecar 是否就绪并给出修复按钮

---

## 11. 给 Codex 的修改提示词

可以直接把下面这段给 Codex：

```text
你在维护 HT Logistic Workspace。它是 Tauri v2 + React + Python FastAPI sidecar + Pi extension 的本地物流 AI 工作台。

产品方向：
- 助手、物流工具区、文件侧栏必须同屏。
- 高频业务是单据制作和 Excel 数据分析。
- 报关工具保留但不是主界面重点。
- UI 接近 Codex/轻客户端风格：浅色、少分隔线、留白、轻边框、支持主题切换。

关键约束：
- .main 必须 overflow: hidden，否则聊天溢出且无法滚动。
- 下拉框用 createPortal + position: fixed，不要靠改父容器 overflow。
- Pi 由 Rust 主进程管理，不由 Python sidecar 启动。
- 续聊历史会话用 restart_pi(cwd, sessionPath)，不要用 switch_session RPC。
- 工作目录切换后必须 await loadHistory() 同步界面。
- npm 命令必须在 tauri-app/ 目录运行。

关键文件：
- tauri-app/src/App.tsx：主界面（1891 行）
- tauri-app/src/styles.css：双主题 + 布局 + 组件（2428 行）
- tauri-app/src/FileBrowser.tsx：文件浏览器（396 行）
- tauri-app/src/ToolsPanel.tsx：物流工具区（355 行）
- tauri-app/src-tauri/src/main.rs：Pi RPC + sidecar + 文件命令（1382 行）
- python-sidecar/main.py 和 python-sidecar/tools/：物流工具 API
- pi-extensions/all-in-one.ts：AI agent 可调用工具

修改时请保持：
- Python sidecar 只做工具 API，不启动 Pi。
- 工具函数尽量输入 bytes、输出 bytes/JSON。
- 前端工具区默认只展示 invoice-packing 和 data-analysis。
- 构建验证至少运行：cd tauri-app && npm run build。
- 修改 .main 的 overflow 前必须确认不会破坏聊天滚动。
```

---

## 12. 当前仓库状态

- 主分支：`main`
- 最新 commit：`a962816 feat: 代码审查修复+UI美学升级（16项）`
- 工作树：clean，已推送到 `origin/main`
- 总代码量：约 6452 行（App.tsx + styles.css + FileBrowser + ToolsPanel + main.rs）

后续最值得投入的方向：把「工具执行结果」变成结构化业务反馈，再让 AI 能基于这些反馈给出可执行建议。
