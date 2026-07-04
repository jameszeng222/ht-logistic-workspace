# HT Logistic Workspace

HT Logistic Workspace 是一个面向物流日常工作的本地 AI 工作台。当前重点是把「单据制作」「Excel 数据分析」「AI 助手」「本地文件查看」放在同一个客户端页面里，减少在工具、文件和会话之间来回切换。

## 当前定位

- 日常单据制作：发票/箱单生成，基于 Excel 数据源和模板批量输出文件。
- 物流数据分析：上传 Excel/CSV，自动生成统计、分布、Top 频次、相关性等 JSON 报告，并可交给助手解读。
- AI 助手：Tauri 主进程启动 Pi RPC，前端提供会话、模型、权限、工具调用入口。
- 本地文件侧栏：在同一页面查看当前项目/会话目录文件，方便助手和工具围绕文件工作。

报关相关工具代码仍保留在 Python sidecar 和 Pi 扩展中，但当前客户端工具区优先展示日常高频流程：单据制作和数据分析。

## 技术架构

```text
Tauri v2 desktop app
  ├─ React + Vite frontend
  │   ├─ AI chat / session list / composer
  │   ├─ logistics tools panel
  │   └─ file browser sidebar
  ├─ Rust main process
  │   ├─ starts Pi in RPC mode
  │   ├─ scans Pi session files
  │   ├─ manages model config and agent files
  │   └─ starts Python sidecar
  ├─ Python sidecar (FastAPI on 127.0.0.1:8000)
  │   ├─ invoice / packing generation
  │   ├─ customs tools
  │   └─ Excel data analysis
  └─ Pi extension
      └─ registers logistic_* tools that call the sidecar
```

## 目录结构

```text
tauri-app/          Tauri + React 客户端
python-sidecar/     FastAPI 工具服务和物流工具实现
pi-extensions/      Pi all-in-one extension 和安装脚本
pi-agent-config/    Pi SYSTEM.md 与 skills 配置
scripts/            辅助脚本
dev.ps1             一键开发启动脚本
deploy.ps1          安装/部署/验证脚本
PROJECT_HANDOFF.md  给后续代码模型接手的详细上下文
```

## 开发启动

首次准备 Python sidecar：

```powershell
cd python-sidecar
.\setup.ps1
```

安装 Pi 扩展和 agent 配置：

```powershell
cd pi-extensions
.\install.ps1
```

启动开发环境：

```powershell
.\dev.ps1
```

也可以分别启动：

```powershell
cd python-sidecar
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000

cd ..\tauri-app
npm install
npm run tauri dev
```

## 常用命令

```powershell
cd tauri-app
npm run build
npm run test
```

验证 sidecar：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
Invoke-RestMethod http://127.0.0.1:8000/api/tools
```

一键部署与验证：

```powershell
.\deploy.ps1
```

## 当前可用工具

Python sidecar 暴露 4 个接口：

| ID | 名称 | 输入 | 输出 | 前端展示 |
|---|---|---|---|---|
| `invoice-packing` | 发票/箱单生成 | Excel | ZIP | 是 |
| `data-analysis` | Excel 数据分析 | Excel/CSV | JSON | 是 |
| `customs-generator` | 报关箱单生成 | Excel | ZIP | 暂不优先展示 |
| `customs-extractor` | 报关单信息提取 | PDF | Excel | 暂不优先展示 |

Pi 扩展中对应注册：

- `logistic_invoice_packing`
- `logistic_data_analysis`
- `logistic_customs_generator`
- `logistic_customs_extractor`
- `logistic_list_tools`

## UI 方向

当前主界面按 Codex 风格调整为：

- 左侧：会话列表，按项目名分组。
- 中间：`Logistic Workspace` 空状态、居中聊天框、模型/权限/工具快捷入口。
- 下方：物流工具区，优先单据制作和数据分析。
- 右侧：文件浏览器侧栏。

后续 UI 优先继续围绕「物流工作台」而不是通用聊天机器人扩展。

## 重要说明

- Python sidecar 默认端口固定为 `127.0.0.1:8000`。
- Pi 由 Tauri 主进程启动，Python sidecar 不负责启动 Pi，避免多进程抢会话。
- 本地模型/API Key 配置写入 `~/.pi/agent/model-config.json`，启动时注入进程环境变量。
- 模板文件依赖在 `python-sidecar/tools/` 内部逻辑中，新增模板时优先保持工具函数纯输入/输出。

更多接手细节见 [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md)。
