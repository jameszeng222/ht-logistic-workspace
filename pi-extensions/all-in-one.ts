// ~/.pi/agent/extensions/all-in-one.ts
// 全场景助理 Extension：覆盖 数据分析 / 文档处理 / 自动化 / 任务管理 四域
//
// 依赖安装（在 ~/.pi/agent/extensions/ 目录下）：
//   cd ~/.pi/agent/extensions
//   npm init -y
//   npm install better-sqlite3 pdf-parse
//
// Pi 用 jiti 加载 TS，无需编译；npm 依赖放同目录即可

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ============ 安全配置（按需修改）============
// query_database 仅允许读这些库
const ALLOWED_DB_FILES = ["~/.pi/data.db"];
// http_request 仅允许这些域名
const HTTP_DOMAIN_WHITELIST = ["api.github.com", "api.weatherapi.com"];
// run_script 仅允许这些脚本
const SCRIPT_WHITELIST = ["~/.pi/scripts/sync.sh"];

const DB_PATH = "~/.pi/data.db"; // 任务/笔记库

function expandHome(p: string): string {
  return p.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
}

// HT 物流工具 sidecar 地址（FastAPI on 127.0.0.1:8000，由 Tauri 主进程拉起）
// 扩展调用工具时通过此 HTTP 接口与 Python 工具层交互，避免在 Node 端复刻 Excel/PDF 处理逻辑。
const SIDECAR_URL = process.env.HT_SIDECAR_URL || "http://127.0.0.1:8000";

/**
 * 调用 sidecar 工具接口的通用封装：读本地文件 → multipart 上传 → 保存返回的二进制结果到磁盘。
 * 返回保存路径供 LLM 告知用户。
 */
async function callSidecarTool(
  endpoint: string,
  filePath: string,
  outExt: "zip" | "xlsx",
  toolName: string
): Promise<{ content: any[]; details: any }> {
  const fs = require("node:fs");
  const path = require("node:path");
  if (!fs.existsSync(filePath)) {
    throw new Error(`输入文件不存在：${filePath}`);
  }
  const fileBytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append("file", new Blob([fileBytes]), fileName);

  let resp: Response;
  try {
    resp = await fetch(`${SIDECAR_URL}${endpoint}`, { method: "POST", body: form });
  } catch (e: any) {
    throw new Error(`无法连接 sidecar（${SIDECAR_URL}）：${e.message}。请确认 Tauri 已启动 Python sidecar。`);
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).detail || ""; } catch {}
    throw new Error(`工具执行失败 HTTP ${resp.status}：${detail || resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  // 输出到 ~/.pi/outputs/<toolName>-<timestamp>.<ext>
  const outDir = expandHome("~/.pi/outputs");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(outDir, `${toolName}-${ts}.${outExt}`);
  fs.writeFileSync(outPath, buf);
  const sizeKb = (buf.length / 1024).toFixed(1);
  return {
    content: [
      {
        type: "text",
        text: `已生成结果文件：${outPath}（${sizeKb} KB）。请告知用户该路径，用户可在文件管理器中打开。`,
      },
    ],
    details: { outPath, sizeBytes: buf.length },
  };
}

export default function (pi: ExtensionAPI) {
  // 启动时禁用危险默认工具（bash/edit/write 等），保留 read + 所有扩展注册的工具。
  // 注意：pi.setActiveTools 对内置工具与动态注册工具都生效（见 pi.dev extensions 文档），
  //       因此不能写成 setActiveTools(["read"])——那会把本扩展注册的 9 个工具也禁用掉。
  pi.on("session_start", async (_event, ctx) => {
    let keep: string[] = ["read"];
    try {
      const all = pi.getAllTools();
      // 保留 read + 所有非内置工具（即扩展注册的工具），剔除其它内置工具（bash/edit/write/apply_patch 等）
      keep = all
        .filter((t: any) => t?.sourceInfo?.source !== "builtin" || t?.name === "read")
        .map((t: any) => t.name);
      if (keep.length === 0) keep = ["read"];
    } catch {
      keep = ["read"];
    }
    pi.setActiveTools(keep);
    ctx.ui.notify("全场景助理已加载（4 域工具就绪）", "info");
  });

  // ==================== 数据分析域 ====================
  pi.registerTool({
    name: "query_database",
    description: "查询本地 SQLite 数据库（只读）。当用户要分析数据、查表、出报表时使用。",
    promptGuidelines: ["仅允许 SELECT；禁止 INSERT/UPDATE/DELETE/DROP"],
    parameters: Type.Object({
      dbPath: Type.String({ description: "数据库文件路径" }),
      sql: Type.String({ description: "SQL 查询语句，必须是 SELECT" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const expanded = expandHome(params.dbPath);
      if (!ALLOWED_DB_FILES.includes(params.dbPath)) {
        throw new Error(`数据库不在白名单：${params.dbPath}`);
      }
      if (!/^\s*select\b/i.test(params.sql)) {
        throw new Error("仅允许 SELECT 查询");
      }
      const Database = require("better-sqlite3");
      const db = new Database(expanded, { readonly: true, timeout: 30000 });
      try {
        const rows = db.prepare(params.sql).all();
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          details: { rowCount: rows.length },
        };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "chart_render",
    description: "生成图表配置（Chart.js 格式）。当需要可视化数据时使用。",
    parameters: Type.Object({
      type: StringEnum(["bar", "line", "pie", "doughnut"] as const),
      title: Type.String(),
      labels: Type.Array(Type.String()),
      datasets: Type.Array(
        Type.Object({ label: Type.String(), data: Type.Array(Type.Number()) })
      ),
    }),
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: `图表已生成：${params.title}` }],
        details: {
          chartConfig: {
            type: params.type,
            data: { labels: params.labels, datasets: params.datasets },
            options: { plugins: { title: { display: true, text: params.title } } },
          },
        },
      };
    },
  });

  // ==================== 文档处理域 ====================
  pi.registerTool({
    name: "parse_pdf",
    description: "解析 PDF 提取文本。当用户上传 PDF 要总结/问答时使用。",
    parameters: Type.Object({
      path: Type.String({ description: "PDF 文件绝对路径" }),
    }),
    async execute(_id, params) {
      const fs = require("node:fs");
      if (!fs.existsSync(params.path)) {
        throw new Error(`文件不存在：${params.path}`);
      }
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(fs.readFileSync(params.path));
      return {
        content: [{ type: "text", text: data.text.slice(0, 8000) }],
        // 不回传完整路径给 LLM（SYSTEM.md 安全边界：不向用户暴露完整文件路径）
        details: { pages: data.numpages },
      };
    },
  });

  pi.registerTool({
    // 注意：本工具实现为子串匹配（lowercased indexOf），并非真正的向量语义检索。
    // 故命名为 kb_search（知识库检索）以避免误导。如需语义检索可后续接入嵌入向量。
    name: "kb_search",
    description: "在本地知识库中检索相关片段（大小写不敏感的子串匹配，非向量语义检索）。当问知识库相关问题时使用。",
    parameters: Type.Object({
      query: Type.String(),
      kbDir: Type.Optional(Type.String({ description: "知识库目录，默认 ~/.pi/kb" })),
    }),
    async execute(_id, params) {
      const fs = require("node:fs");
      const path = require("node:path");
      const kbDir = expandHome(params.kbDir || "~/.pi/kb");
      if (!fs.existsSync(kbDir)) {
        throw new Error(`知识库目录不存在：${kbDir}`);
      }
      const q = params.query.toLowerCase();
      const results: any[] = [];
      for (const file of fs.readdirSync(kbDir)) {
        if (!file.endsWith(".md") && !file.endsWith(".txt")) continue;
        const content = fs.readFileSync(path.join(kbDir, file), "utf8");
        const lower = content.toLowerCase();
        let idx = lower.indexOf(q);
        while (idx >= 0 && results.length < 10) {
          const start = Math.max(0, idx - 100);
          results.push({
            file,
            snippet: content.slice(start, idx + q.length + 200),
          });
          idx = lower.indexOf(q, idx + 1);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: results.length
              ? JSON.stringify(results, null, 2)
              : "未找到匹配",
          },
        ],
        details: { matchCount: results.length },
      };
    },
  });

  // ==================== 自动化域 ====================
  pi.registerTool({
    name: "http_request",
    description: "发起 HTTP 请求（仅限白名单域名）。当需要调外部 API 时使用。",
    parameters: Type.Object({
      url: Type.String(),
      method: StringEnum(["GET", "POST", "PUT", "DELETE"] as const),
      body: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const u = new URL(params.url);
      if (!HTTP_DOMAIN_WHITELIST.includes(u.hostname)) {
        throw new Error(
          `域名不在白名单：${u.hostname}（白名单：${HTTP_DOMAIN_WHITELIST.join(", ")}）`
        );
      }
      if (params.method !== "GET") {
        const ok = await ctx.ui.confirm(
          `${params.method} ${params.url}`,
          "将发起写操作，确认？"
        );
        if (!ok) throw new Error("用户取消");
      }
      const res = await fetch(params.url, {
        method: params.method,
        body: params.body,
      });
      const text = await res.text();
      return {
        content: [{ type: "text", text: `HTTP ${res.status}\n${text.slice(0, 4000)}` }],
        details: { status: res.status, fullText: text },
      };
    },
  });

  pi.registerTool({
    name: "run_script",
    description: "执行白名单脚本。当需要跑本地脚本时使用。",
    parameters: Type.Object({
      script: Type.String({ description: "脚本路径（必须在白名单）" }),
      args: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!SCRIPT_WHITELIST.includes(params.script)) {
        throw new Error(`脚本不在白名单：${params.script}`);
      }
      const expanded = expandHome(params.script);
      const ok = await ctx.ui.confirm(
        "执行脚本",
        `${expanded} ${params.args?.join(" ") || ""}`
      );
      if (!ok) throw new Error("用户取消");
      const { execFile } = require("node:child_process");
      return new Promise((resolve) => {
        execFile(
          expanded,
          params.args || [],
          { timeout: 30000 },
          (err: any, stdout: string, stderr: string) => {
            resolve({
              content: [
                {
                  type: "text",
                  text: `exit ${err ? err.code || 1 : 0}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                },
              ],
              details: { error: err?.message },
            });
          }
        );
      });
    },
  });

  // ==================== 任务/笔记管理域 ====================
  function openDb() {
    const Database = require("better-sqlite3");
    const fs = require("node:fs");
    const path = require("node:path");
    const dbPath = expandHome(DB_PATH);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, title TEXT, status TEXT, priority INTEGER, due TEXT
      );
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY, title TEXT UNIQUE, body TEXT, tags TEXT, updated TEXT
      );
    `);
    return db;
  }

  pi.registerTool({
    name: "task_create",
    description: "创建任务。当用户要新增待办时使用。",
    parameters: Type.Object({
      title: Type.String(),
      priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      due: Type.Optional(Type.String({ description: "ISO 8601 日期" })),
    }),
    async execute(_id, params) {
      const db = openDb();
      try {
        const r = db
          .prepare(
            "INSERT INTO tasks (title, status, priority, due) VALUES (?, 'todo', ?, ?)"
          )
          .run(params.title, params.priority || 3, params.due || null);
        return {
          content: [{ type: "text", text: `已创建任务 #${r.lastInsertRowid}：${params.title}` }],
          details: { id: r.lastInsertRowid },
        };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "task_list",
    description: "列出任务。当用户要看待办列表时使用。",
    parameters: Type.Object({
      status: Type.Optional(StringEnum(["todo", "doing", "done", "all"] as const)),
    }),
    async execute(_id, params) {
      const db = openDb();
      try {
        const where = params.status && params.status !== "all" ? "WHERE status = ?" : "";
        const args = params.status && params.status !== "all" ? [params.status] : [];
        const rows = db
          .prepare(`SELECT * FROM tasks ${where} ORDER BY priority, due`)
          .all(...args);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          details: { count: rows.length },
        };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "task_update",
    description: "更新任务状态/优先级。删除任务用 status='deleted'。",
    parameters: Type.Object({
      id: Type.Integer(),
      status: Type.Optional(StringEnum(["todo", "doing", "done", "deleted"] as const)),
      priority: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = openDb();
      try {
        const cur: any = db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id);
        if (!cur) throw new Error(`任务不存在：${params.id}`);
        if (params.status === "deleted") {
          const ok = await ctx.ui.confirm("删除任务", `确认删除 #${params.id}：${cur.title}`);
          if (!ok) throw new Error("用户取消");
        }
        db.prepare(
          "UPDATE tasks SET status = COALESCE(?, status), priority = COALESCE(?, priority) WHERE id = ?"
        ).run(params.status || null, params.priority || null, params.id);
        return { content: [{ type: "text", text: `已更新任务 #${params.id}` }], details: {} };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "note_upsert",
    description: "新增/更新笔记（按 title 匹配，存在则覆盖）。",
    parameters: Type.Object({
      title: Type.String(),
      body: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      const db = openDb();
      try {
        db.prepare(
          `INSERT INTO notes (title, body, tags, updated) VALUES (?, ?, ?, ?)
           ON CONFLICT(title) DO UPDATE SET body=excluded.body, tags=excluded.tags, updated=excluded.updated`
        ).run(params.title, params.body, (params.tags || []).join(","), new Date().toISOString());
        return { content: [{ type: "text", text: `已保存笔记：${params.title}` }], details: {} };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "note_search",
    description: "搜索笔记（标题或正文匹配）。",
    parameters: Type.Object({ keyword: Type.String() }),
    async execute(_id, params) {
      const db = openDb();
      try {
        const rows = db
          .prepare(
            "SELECT id, title, tags, updated FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY updated DESC"
          )
          .all(`%${params.keyword}%`, `%${params.keyword}%`);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          details: { count: rows.length },
        };
      } finally {
        db.close();
      }
    },
  });

  // ==================== HT 物流工具域 ====================
  // 这三个工具通过 HTTP 调用 Python sidecar（FastAPI on 127.0.0.1:8000），
  // 让 AI 助手能直接处理发票/箱单/报关单，而无需把 Excel/PDF 处理逻辑搬进 Node。
  // 工具流：用户给文件路径 → 扩展读文件 → POST sidecar → 保存结果到 ~/.pi/outputs/ → 返回路径给 LLM。
  // 与前端「工具」tab 的区别：tab 是人工操作；这里是 AI 自主调用。
  pi.registerTool({
    name: "logistic_invoice_packing",
    description: "生成发票和箱单。上传数据源 Excel（含万邑通单号），按德速/联宇模板批量生成发票+箱单，输出 zip。当用户要做出库发票箱单时使用。",
    parameters: Type.Object({
      filePath: Type.String({ description: "数据源 Excel 文件绝对路径（.xlsx）" }),
    }),
    async execute(_id, params) {
      return callSidecarTool("/api/tools/invoice-packing", params.filePath, "zip", "invoice-packing");
    },
  });

  pi.registerTool({
    name: "logistic_customs_generator",
    description: "生成报关箱单。上传数据源 Excel，按 FBA/WI/合并报关三种情况生成报关箱单文件，输出 zip。当用户要做报关单据时使用。",
    parameters: Type.Object({
      filePath: Type.String({ description: "数据源 Excel 文件绝对路径（.xlsx）" }),
    }),
    async execute(_id, params) {
      return callSidecarTool("/api/tools/customs-generator", params.filePath, "zip", "customs-generator");
    },
  });

  pi.registerTool({
    name: "logistic_customs_extractor",
    description: "提取报关单信息。上传报关单 PDF，通过 OCR + 正则提取关键字段（发货人/申报号/HS编码/品名/数量/金额等），输出 Excel。当用户要从 PDF 报关单抽取结构化数据时使用。",
    parameters: Type.Object({
      filePath: Type.String({ description: "报关单 PDF 文件绝对路径" }),
    }),
    async execute(_id, params) {
      return callSidecarTool("/api/tools/customs-extractor", params.filePath, "xlsx", "customs-extracted");
    },
  });

  pi.registerTool({
    name: "logistic_list_tools",
    description: "列出 sidecar 当前可用的物流工具及其输入输出类型。当不确定有哪些工具时可先调用此查询。",
    parameters: Type.Object({}),
    async execute() {
      let resp: Response;
      try {
        resp = await fetch(`${SIDECAR_URL}/api/tools`);
      } catch (e: any) {
        throw new Error(`无法连接 sidecar：${e.message}`);
      }
      const data = await resp.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data.tools || [], null, 2) }],
        details: { count: data.tools?.length || 0 },
      };
    },
  });
}
