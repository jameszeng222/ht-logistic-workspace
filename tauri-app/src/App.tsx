// 完整版 Pi Assistant GUI
// 7 大能力：会话管理 / 模型切换 / 设置 / 主题 / 上下文用量 / 状态刷新 / 斜杠命令
//
// Bug 修复：
// 1. 文字 double —— 不用 StrictMode + listener ref 保证只注册一次
// 2. 会话无法新增 —— new_session RPC + scan_sessions 扫描历史
// 3. 输入框无法发送 —— StrictMode 副作用消除

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PiEvent } from "./pi-client";
import { Markdown } from "./Markdown";
import { CommandPalette } from "./CommandPalette";
import { ExtensionManager } from "./ExtensionManager";
import { rebuildTurnsFromMessages } from "./utils";
import { ChartView, extractChartConfig } from "./Chart";
import { ToolsPanel } from "./ToolsPanel";
import { FileBrowser } from "./FileBrowser";
import type { ToolCall, AssistantMsg, Turn } from "./types";
import "./styles.css";

// ============ 类型 ============
interface Toast { id: number; msg: string; type: "info"|"error"|"success"; }
interface SessionInfo { path: string; name: string; mtime: number; size: number; title?: string; cwd?: string; }
interface ModelInfo { id: string; name: string; provider: string; contextWindow?: number; reasoning?: boolean; }
interface PiState { model: ModelInfo | null; thinkingLevel: string; isStreaming: boolean; sessionFile?: string; sessionName?: string; messageCount: number; }
interface SessionStats { contextUsage?: { percent: number; tokens: number; contextWindow: number }; cost?: number; }
interface ModelProvider {
  id: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
  models: string[];
  defaultModel?: string;
  enabled: boolean;
}

let toastId = 0;

// ============ 主题 Hook ============
function useTheme() {
  const [theme, setTheme] = useState<"dark"|"light"|"system">(() => {
    return (localStorage.getItem("pi-theme") as any) || "light";
  });
  useEffect(() => {
    const resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem("pi-theme", theme);
  }, [theme]);
  // 跟随系统变化
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);
  return { theme, setTheme };
}

// ============ 主应用 ============
export default function App() {
  const { theme, setTheme } = useTheme();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // 会话管理
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionPath, setCurrentSessionPath] = useState<string | null>(null);
  // 预览模式：浏览历史会话不切换 Pi 活动会话，不打断当前输出。
  // previewPath !== currentSessionPath 时表示正在预览某个历史会话。
  // 发送新消息时若处于预览，先 switch_session 真正切换再发送。
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const previewPathRef = useRef<string | null>(null);
  previewPathRef.current = previewPath;

  // 模型
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelInfo | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // 状态 & 统计
  const [piState, setPiState] = useState<PiState | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<string>("medium");

  // 设置面板
  const [showSettings, setShowSettings] = useState(false);
  const [autoCompaction, setAutoCompaction] = useState(true);
  const [autoRetry, setAutoRetry] = useState(true);
  const [envKeys, setEnvKeys] = useState<{provider: string; env: string; configured: boolean}[]>([]);
  // 权限模式：cautious（审慎）/ workspace（工作台）/ trust（全信任）
  // - cautious:   所有 confirm 都弹窗（生成文件前确认，删除/外部请求必须确认）
  // - workspace:  只对"删除"等关键字弹窗，其余自动放行
  // - trust:      所有 confirm 自动放行
  const [permissionMode, setPermissionMode] = useState<"cautious" | "workspace" | "trust">(() => {
    const saved = localStorage.getItem("pi-permission-mode");
    if (saved === "workspace" || saved === "trust" || saved === "cautious") return saved;
    // 兼容旧 autoConfirm=true → trust；默认工作台模式（推荐，弹窗最少且安全）
    return localStorage.getItem("pi-auto-confirm") === "true" ? "trust" : "workspace";
  });
  const permissionModeLabel = permissionMode === "cautious" ? "审慎模式" : permissionMode === "workspace" ? "工作台模式" : "全信任模式";
  const cyclePermissionMode = useCallback(() => {
    setPermissionMode((prev) => {
      const next = prev === "cautious" ? "workspace" : prev === "workspace" ? "trust" : "cautious";
      localStorage.setItem("pi-permission-mode", next);
      return next;
    });
  }, []);
  const [showExtManager, setShowExtManager] = useState(false);
  // 会话分组折叠状态（key=项目名，value=是否展开）
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("pi-collapsed-projects") || "[]")); }
    catch { return new Set(); }
  });

  // 模型配置
  const [modelConfig, setModelConfig] = useState<{
    providers: ModelProvider[];
    defaultProvider?: string;
    defaultModel?: string;
  } | null>(null);
  const [modelConfigDirty, setModelConfigDirty] = useState(false);
  const [modelConfigSaving, setModelConfigSaving] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);

  // 系统提示词编辑器（读写 ~/.pi/agent/SYSTEM.md）
  const [systemPrompt, setSystemPrompt] = useState("");
  const [systemPromptPath, setSystemPromptPath] = useState("SYSTEM.md");
  const [systemPromptDirty, setSystemPromptDirty] = useState(false);
  const [systemPromptSaving, setSystemPromptSaving] = useState(false);
  const systemPromptPathHint = "~/.pi/agent/SYSTEM.md（替换默认系统提示词） / APPEND_SYSTEM.md（追加到默认提示词）";

  // 日志查看器（Track 5 观测调试）
  const [showLogViewer, setShowLogViewer] = useState(false);
  const [logs, setLogs] = useState<{ type: "stderr" | "event"; text: string; time: number }[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "stderr" | "event">("all");
  const [logSearch, setLogSearch] = useState("");
  const logListRef = useRef<HTMLDivElement>(null);
  const logAutoFollow = useRef(true);
  const addLog = useCallback((type: "stderr" | "event", text: string) => {
    setLogs((prev) => {
      const next = [...prev, { type, text, time: Date.now() }];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  // 斜杠命令面板
  const [showCmdPalette, setShowCmdPalette] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);

  // 会话管理补全：搜索 / 重命名
  const [sessionSearch, setSessionSearch] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");

  // 引用
  const messagesRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const currentTurnId = useRef<string | null>(null);
  const currentMsgId = useRef<string | null>(null);
  // 跟踪 Pi 当前 sessionFile 的最新值，供 scan_sessions 作为权威路径提示反推会话根目录。
  const sessionFileRef = useRef<string | undefined>(undefined);

  // 流式节流
  const pendingTextRef = useRef<Map<string, string>>(new Map());
  const pendingThinkingRef = useRef<Map<string, string>>(new Map());
  const rafRef = useRef<number | null>(null);

  const toast = useCallback((msg: string, type: Toast["type"] = "info") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // ====== RPC 请求封装 ======
  const rpc = useCallback(async (command: any) => {
    return invoke<any>("send_request", { command });
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_state" });
      const state = data as PiState;
      setPiState(state);
      setCurrentModel(state.model);
      setThinkingLevel(state.thinkingLevel);
      if (state.sessionFile) {
        sessionFileRef.current = state.sessionFile;
        setCurrentSessionPath(state.sessionFile);
      }
    } catch (e) { /* 静默 */ }
  }, [rpc]);

  const refreshStats = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_session_stats" });
      setSessionStats(data as SessionStats);
    } catch (e) { /* 静默 */ }
  }, [rpc]);

  const refreshModels = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_available_models" });
      setModels((data?.models || []) as ModelInfo[]);
    } catch (e) { /* 静默 */ }
  }, [rpc]);

  // 跟踪 Pi 当前 sessionFile 的最新值，供 scan_sessions 作为权威路径提示反推会话根目录。
  // 用 ref 避免 refreshSessions 依赖 piState 导致频繁重建。
  const refreshSessions = useCallback(async () => {
    try {
      // 传入 Pi 自己的当前会话路径，Rust 端据此反推真实会话根目录扫描，
      // 避免因 Pi 实际存储路径与硬编码 ~/.pi/agent/sessions 不一致而扫空、清空侧边栏。
      const list = await invoke<SessionInfo[]>("scan_sessions", {
        sessionFileHint: sessionFileRef.current ?? null,
      });
      setSessions(list);
    } catch (e) {
      // 不再静默吞掉：扫不到历史会话正是"新建会话后旧会话消失"的根因，必须可见。
      toast(`扫描历史会话失败: ${e}`, "error");
    }
  }, [toast]);

  const refreshEnvKeys = useCallback(async () => {
    try {
      const list = await invoke<{provider: string; env: string; configured: boolean}[]>("check_env_keys");
      setEnvKeys(list);
    } catch { /* 静默 */ }
  }, []);

  // 模型配置加载/保存/应用
  const loadModelConfig = useCallback(async () => {
    try {
      const data = await invoke<any>("get_model_config");
      // 字段名转换（snake_case -> camelCase）
      const providers: ModelProvider[] = (data?.providers || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        apiKey: p.api_key || p.apiKey || "",
        baseUrl: p.base_url || p.baseUrl,
        models: p.models || [],
        defaultModel: p.default_model || p.defaultModel,
        enabled: !!p.enabled,
      }));
      setModelConfig({
        providers,
        defaultProvider: data.default_provider || data.defaultProvider,
        defaultModel: data.default_model || data.defaultModel,
      });
      setModelConfigDirty(false);
    } catch (e) {
      toast(`加载模型配置失败: ${e}`, "error");
    }
  }, [toast]);

  const saveModelConfig = useCallback(async () => {
    if (!modelConfig) return;
    setModelConfigSaving(true);
    try {
      // 转换为 snake_case
      const data = {
        providers: modelConfig.providers.map((p) => ({
          id: p.id,
          name: p.name,
          api_key: p.apiKey,
          base_url: p.baseUrl || null,
          models: p.models,
          default_model: p.defaultModel || null,
          enabled: p.enabled,
        })),
        default_provider: modelConfig.defaultProvider || null,
        default_model: modelConfig.defaultModel || null,
      };
      await invoke("save_model_config", { config: data });
      // 应用到环境变量
      const result = await invoke<string>("apply_model_config");
      setModelConfigDirty(false);
      toast(`模型配置已保存。${result}`, "success");
      // 刷新可用模型列表
      refreshModels();
    } catch (e) {
      toast(`保存失败: ${e}`, "error");
    } finally {
      setModelConfigSaving(false);
    }
  }, [modelConfig, toast, refreshModels]);

  const updateProvider = useCallback((providerId: string, updates: Partial<ModelProvider>) => {
    setModelConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        providers: prev.providers.map((p) =>
          p.id === providerId ? { ...p, ...updates } : p
        ),
      };
    });
    setModelConfigDirty(true);
  }, []);

  // ====== 历史恢复：get_messages → 重建 turns ======
  const loadHistory = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_messages" });
      const msgs = data?.messages || [];
      if (msgs.length === 0) { setTurns([]); return; }
      const rebuilt = rebuildTurnsFromMessages(msgs);
      setTurns(rebuilt);
      setAutoFollow(true);
    } catch { /* 静默 */ }
  }, [rpc]);

  // ====== 系统提示词编辑器：加载/保存 ======
  const loadSystemPrompt = useCallback(async (filename: string) => {
    try {
      const content = await invoke<string>("read_text_file", { path: filename });
      setSystemPrompt(content);
      setSystemPromptDirty(false);
    } catch (e) {
      // 文件不存在时返回错误，给空内容让用户新建
      setSystemPrompt("");
      setSystemPromptDirty(false);
      toast(`未读取到 ${filename}（可新建）：${e}`, "info");
    }
  }, [toast]);
  const saveSystemPrompt = useCallback(async () => {
    setSystemPromptSaving(true);
    try {
      await invoke("write_text_file", { path: systemPromptPath, content: systemPrompt });
      setSystemPromptDirty(false);
      toast("系统提示词已保存。新会话生效（当前会话不会热重载）。", "success");
    } catch (e) {
      toast(`保存失败: ${e}`, "error");
    } finally {
      setSystemPromptSaving(false);
    }
  }, [systemPrompt, systemPromptPath, toast]);

  // ====== 流式节流 ======
  const flushText = useCallback(() => {
    rafRef.current = null;
    const pending = pendingTextRef.current;
    const pendingThink = pendingThinkingRef.current;
    if (pending.size === 0 && pendingThink.size === 0) return;
    const textUpdates = Array.from(pending.entries());
    const thinkUpdates = Array.from(pendingThink.entries());
    pending.clear(); pendingThink.clear();
    setTurns((prev) => prev.map((t) => ({
      ...t,
      assistantMsgs: t.assistantMsgs.map((m) => {
        let next = m;
        const txt = textUpdates.find(([id]) => id === m.id);
        if (txt) next = { ...next, text: next.text + txt[1] };
        const think = thinkUpdates.find(([id]) => id === m.id);
        if (think) next = { ...next, thinking: (next.thinking || "") + think[1] };
        return next;
      }),
    })));
  }, []);

  const appendText = useCallback((msgId: string, delta: string) => {
    pendingTextRef.current.set(msgId, (pendingTextRef.current.get(msgId) || "") + delta);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushText);
  }, [flushText]);

  const appendThinking = useCallback((msgId: string, delta: string) => {
    pendingThinkingRef.current.set(msgId, (pendingThinkingRef.current.get(msgId) || "") + delta);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushText);
  }, [flushText]);

  // ====== 自动命名会话 ======
  // Pi 默认会话显示名是"首条用户消息"。但若用户没主动 set_session_name，
  // 侧边栏列表只能从 .jsonl 文件解析首条 user 文本作标题。
  // 在 agent_end 后，若会话尚无 sessionName，取首条 user 消息文本调
  // set_session_name 让 Pi 持久化，使侧边栏标题即时更新且跨重启稳定。
  // 这只是把"首条消息"正式登记为会话名，不消耗额外 LLM 调用。
  const autoNameSession = useCallback(async () => {
    try {
      // 已有 sessionName 则不覆盖（用户手动命名优先）
      if (piState?.sessionName) return;
      // 取首条 user 消息文本（turns[0].userMessage）
      const firstUser = turns[0]?.userMessage?.trim();
      if (!firstUser) return;
      // 截断到 40 字符（与 scan_sessions 标题逻辑一致）
      const title = firstUser.length > 40 ? firstUser.slice(0, 40) + "…" : firstUser;
      await rpc({ type: "set_session_name", name: title } as any);
    } catch { /* 静默：命名失败不影响主流程 */ }
  }, [piState?.sessionName, turns, rpc]);

  // ====== 事件处理 ======
  const handleEvent = useCallback((ev: PiEvent) => {
    switch (ev.type) {
      case "agent_start":
        setBusy(true);
        // 预览模式下若当前活动会话开始新输出，自动退出预览回到实时视图。
        // 否则流式事件会覆盖预览的 turns，且用户看不到新输出。
        if (previewPathRef.current && previewPathRef.current !== sessionFileRef.current) {
          setPreviewPath(null);
          loadHistoryRef.current();
        }
        addLog("event", "agent_start · 开始推理");
        break;
      case "agent_end":
        setBusy(false);
        setTurns((prev) => prev.map((t) => t.status === "streaming" ? { ...t, status: "done" } : t));
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; flushText(); }
        currentTurnId.current = null; currentMsgId.current = null;
        // agent_end 后刷新状态 & 统计 & 自动命名 & 刷新会话列表
        refreshState(); refreshStats();
        autoNameSession();
        refreshSessions();
        addLog("event", "agent_end · 推理结束");
        break;
      case "message_start": {
        const msg = (ev as any).message;
        if (msg?.role !== "assistant") break;
        const msgId = msg.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        currentMsgId.current = msgId;
        setTurns((prev) => prev.map((t) =>
          t.id === currentTurnId.current
            ? { ...t, assistantMsgs: [...t.assistantMsgs, { id: msgId, text: "", streaming: true, toolCallIds: [] }] }
            : t
        ));
        break;
      }
      case "message_update": {
        const d = (ev as any).assistantMessageEvent;
        if (d?.type === "text_delta" && typeof d.delta === "string") {
          if (currentMsgId.current) appendText(currentMsgId.current, d.delta);
        } else if (d?.type === "thinking_delta" && typeof d.delta === "string") {
          if (currentMsgId.current) appendThinking(currentMsgId.current, d.delta);
        }
        break;
      }
      case "message_end":
        const mid = currentMsgId.current;
        setTurns((prev) => prev.map((t) => ({
          ...t, assistantMsgs: t.assistantMsgs.map((m) => m.id === mid ? { ...m, streaming: false } : m),
        })));
        break;
      case "tool_execution_start":
        const tc: ToolCall = { id: ev.toolCallId, name: ev.toolName, args: ev.args, status: "running" };
        setTurns((prev) => prev.map((t) =>
          t.id === currentTurnId.current
            ? { ...t, toolCalls: { ...t.toolCalls, [tc.id]: tc },
                assistantMsgs: t.assistantMsgs.map((m, i) =>
                  i === t.assistantMsgs.length - 1 ? { ...m, toolCallIds: [...m.toolCallIds, tc.id] } : m) }
            : t
        ));
        addLog("event", `tool_start · ${ev.toolName}`);
        break;
      case "tool_execution_end":
        setTurns((prev) => prev.map((t) =>
          t.toolCalls[ev.toolCallId]
            ? { ...t, toolCalls: { ...t.toolCalls, [ev.toolCallId]: { ...t.toolCalls[ev.toolCallId], result: ev.result, status: ev.isError ? "error" : "done" } } }
            : t
        ));
        addLog("event", `tool_end · ${ev.toolCallId.slice(0, 8)} ${ev.isError ? "❌" : "✓"}`);
        break;
      case "extension_ui_request":
        handleUiRequest(ev as any);
        addLog("event", `ui_request · ${(ev as any).method}`);
        break;
      case "compaction_end":
        refreshState(); refreshStats();
        addLog("event", "compaction_end · 上下文已压缩");
        break;
      case "pi_process_exit":
        setReady(false); setBusy(false);
        toast("Pi 进程退出", "error");
        addLog("event", "pi_process_exit · 进程退出");
        break;
    }
  }, [appendText, appendThinking, flushText, toast, refreshState, refreshStats, addLog, autoNameSession, refreshSessions]);

  // ====== Extension UI Modal ======
  const [uiRequest, setUiRequest] = useState<any>(null);
  const handleUiRequest = useCallback((ev: any) => {
    const fireAndForget = ["notify","setStatus","setWidget","setTitle","setWorkingMessage","setWorkingVisible","setWorkingIndicator","setFooter","setTheme","setEditorText","setEditorComponent","pasteToEditor","setToolsExpanded"];
    if (fireAndForget.includes(ev.method)) return;
    // 权限模式处理 confirm 类型请求（Pi 的 "Permission Required" / "Current agent requested" 等）
    if (ev.method === "confirm") {
      const mode = localStorage.getItem("pi-permission-mode") || "workspace";
      // 拼接 title + message 做关键字判断（中文 + 英文）
      const text = `${ev.title || ""} ${ev.message || ""}`.toLowerCase();
      // 破坏性操作关键字：删除/移除/清空/卸载/格式化/覆盖 + delete/remove/rm/drop/truncate/uninstall/overwrite
      const destructiveKeywords = ["删除", "移除", "清空", "卸载", "格式化", "覆盖", "delete", "remove", "rm ", "drop ", "truncate", "uninstall", "overwrite", "rmdir", "del "];
      const isDestructive = destructiveKeywords.some((k) => text.includes(k));
      // 安全只读操作关键字：读取/查看/列表/查询/搜索/检查 + read/list/search/view/get/show/check/glob/grep
      const safeKeywords = ["读取", "查看", "列表", "查询", "搜索", "检查", "显示", "获取", "read", "list", "search", "view", "show", "check", "glob", "grep", "ls ", "cat ", "head ", "tail ", "find ", "stat"];
      const isSafe = safeKeywords.some((k) => text.includes(k));
      if (mode === "trust") {
        // 全信任：所有 confirm 自动放行
        invoke("send_command", { command: { type: "extension_ui_response", id: ev.id, confirmed: true, cancelled: false } });
        return;
      }
      if (mode === "workspace" && !isDestructive) {
        // 工作台：非破坏性操作自动放行，破坏性操作仍弹窗
        invoke("send_command", { command: { type: "extension_ui_response", id: ev.id, confirmed: true, cancelled: false } });
        return;
      }
      if (mode === "cautious" && isSafe && !isDestructive) {
        // 审慎：安全的只读操作也自动放行，只有写/修改/破坏性操作弹窗
        invoke("send_command", { command: { type: "extension_ui_response", id: ev.id, confirmed: true, cancelled: false } });
        return;
      }
    }
    setUiRequest({ ev, inputValue: "", selectIndex: 0 });
  }, []);
  const respondUiRequest = useCallback((payload: any) => {
    if (!uiRequest) return;
    const finalPayload = { type: "extension_ui_response", id: uiRequest.ev.id, ...payload };
    setUiRequest(null);
    invoke("send_command", { command: finalPayload }).catch((e) => toast(`UI 响应失败: ${e}`, "error"));
  }, [uiRequest, toast]);

  // ====== 初始化：注册 listener + 启动 pi ======
  // 只在挂载时执行一次（空依赖数组）。handler 用 ref 持有最新引用，
  // 避免 handler 重建触发 effect 重跑 → 重复 start_pi → 死循环。
  // 之前的 bug：依赖数组含 handleEvent（它依赖 autoNameSession→turns），
  // 每次 turns 变化 handleEvent 重建 → init effect 重跑 → start_pi 再调 → 循环。
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;
  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const refreshStateRef = useRef(refreshState); refreshStateRef.current = refreshState;
  const refreshModelsRef = useRef(refreshModels); refreshModelsRef.current = refreshModels;
  const refreshSessionsRef = useRef(refreshSessions); refreshSessionsRef.current = refreshSessions;
  const refreshEnvKeysRef = useRef(refreshEnvKeys); refreshEnvKeysRef.current = refreshEnvKeys;
  const loadHistoryRef = useRef(loadHistory); loadHistoryRef.current = loadHistory;
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let unlistenStderr: UnlistenFn | undefined;
    (async () => {
      try {
        const fn1 = await listen<PiEvent>("pi-event", (e) => handleEventRef.current(e.payload));
        const fn2 = await listen<{ line: string }>("pi-stderr", (e) => addLogRef.current("stderr", e.payload.line));
        if (cancelled) { fn1(); fn2(); return; }
        unlisten = fn1; unlistenStderr = fn2;
        addLogRef.current("event", "app_init · 正在启动 Pi 进程…");
        await invoke("start_pi");
        if (cancelled) return;
        setReady(true);
        toastRef.current("已连接 Pi", "success");
        addLogRef.current("event", "app_init · Pi 已连接");
        refreshStateRef.current(); refreshModelsRef.current(); refreshSessionsRef.current(); refreshEnvKeysRef.current();
        loadHistoryRef.current();
      } catch (e) {
        if (!cancelled) {
          toastRef.current(`启动失败: ${e}`, "error");
          addLogRef.current("event", `app_init · 启动失败: ${e}`);
        }
      }
    })();
    return () => { cancelled = true; unlisten?.(); unlistenStderr?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动滚动
  const handleScroll = useCallback(() => {
    const el = messagesRef.current; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoFollow(atBottom); setShowScrollBtn(!atBottom && turns.length > 0);
  }, [turns.length]);
  const scrollToBottom = useCallback((smooth = true) => {
    const el = messagesRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setAutoFollow(true); setShowScrollBtn(false);
  }, []);
  useEffect(() => { if (autoFollow) scrollToBottom(true); }, [turns, autoFollow, scrollToBottom]);

  // 日志查看器自动滚到底部
  useEffect(() => {
    if (!showLogViewer) return;
    const el = logListRef.current; if (!el) return;
    if (logAutoFollow.current) el.scrollTop = el.scrollHeight;
  }, [logs.length, showLogViewer]);

  // 全局 ESC：关闭命令面板 / 模型下拉（即使焦点不在 textarea 上也能生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showCmdPalette) { e.preventDefault(); setShowCmdPalette(false); return; }
      if (showModelDropdown) { e.preventDefault(); setShowModelDropdown(false); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCmdPalette, showModelDropdown]);

  // ====== 会话操作 ======
  const newSession = useCallback(async () => {
    if (busy) { toast("请等待当前任务完成", "info"); return; }
    try {
      await invoke("send_command", { command: { type: "new_session" } });
      setTurns([]); currentTurnId.current = null; currentMsgId.current = null;
      pendingTextRef.current.clear(); pendingThinkingRef.current.clear();
      setAutoFollow(true);
      setPreviewPath(null);
      await refreshState(); await refreshSessions();
      toast("已新建会话", "success");
    } catch (e) { toast(`新建失败: ${e}`, "error"); }
  }, [busy, toast, refreshState, refreshSessions]);

  const switchSession = useCallback(async (path: string) => {
    // 预览模式：不调 switch_session RPC，直接读会话文件历史显示。
    // 这样不打断当前会话的 agent 输出（Pi 单进程单活动会话，
    // switch_session 会切走活动会话导致原会话输出丢失）。
    // 真正的 switch_session 推迟到用户发新消息时（见 send）。
    try {
      const data = await invoke<{ messages: any[] }>("read_session_history", { path });
      const msgs = data?.messages || [];
      const rebuilt = rebuildTurnsFromMessages(msgs);
      setTurns(rebuilt);
      currentTurnId.current = null; currentMsgId.current = null;
      pendingTextRef.current.clear(); pendingThinkingRef.current.clear();
      setAutoFollow(true);
      setPreviewPath(path);
    } catch (e) {
      toast(`读取会话历史失败: ${e}`, "error");
    }
  }, [toast]);

  const deleteSession = useCallback(async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定删除这个会话？")) return;
    try {
      await invoke("delete_session", { path });
      await refreshSessions();
      toast("已删除", "success");
    } catch (err) { toast(`删除失败: ${err}`, "error"); }
  }, [refreshSessions, toast]);

  // 重命名当前会话
  const startRename = useCallback(async () => {
    // set_session_name 只能操作当前会话；用 piState 拿当前名
    setRenameInput(piState?.sessionName || currentSessionName || "");
    setRenamingPath(currentSessionPath);
  }, [piState, currentSessionPath]);

  const confirmRename = useCallback(async () => {
    if (!renamingPath) return;
    const name = renameInput.trim();
    if (!name) { setRenamingPath(null); return; }
    try {
      await rpc({ type: "set_session_name", name });
      await refreshState(); await refreshSessions();
      toast("已重命名", "success");
    } catch (e) { toast(`重命名失败: ${e}`, "error"); }
    setRenamingPath(null);
  }, [renamingPath, renameInput, rpc, refreshState, refreshSessions, toast]);

  // clone 当前会话
  const cloneSession = useCallback(async () => {
    if (busy) { toast("请等待当前任务完成", "info"); return; }
    try {
      const data = await rpc({ type: "clone" });
      if (data?.cancelled) { toast("clone 被取消", "info"); }
      else { toast("已克隆会话", "success"); }
      await refreshState(); await refreshSessions();
    } catch (e) { toast(`克隆失败: ${e}`, "error"); }
  }, [busy, rpc, toast, refreshState, refreshSessions]);

  // ====== 模型切换 ======
  const setModel = useCallback(async (provider: string, modelId: string) => {
    try {
      await rpc({ type: "set_model", provider, modelId });
      await refreshState();
      toast("已切换模型", "success");
    } catch (e) { toast(`切换失败: ${e}`, "error"); }
  }, [rpc, refreshState, toast]);

  // ====== 设置操作 ======
  const setThinking = useCallback(async (level: string) => {
    try {
      await rpc({ type: "set_thinking_level", level });
      setThinkingLevel(level);
    } catch (e) { toast(`设置失败: ${e}`, "error"); }
  }, [rpc, toast]);

  const toggleAutoCompaction = useCallback(async (on: boolean) => {
    setAutoCompaction(on);
    try { await rpc({ type: "set_auto_compaction", enabled: on }); } catch {}
  }, [rpc]);

  const toggleAutoRetry = useCallback(async (on: boolean) => {
    setAutoRetry(on);
    try { await rpc({ type: "set_auto_retry", enabled: on }); } catch {}
  }, [rpc]);

  const setPermissionModePersist = useCallback((mode: "cautious" | "workspace" | "trust") => {
    setPermissionMode(mode);
    localStorage.setItem("pi-permission-mode", mode);
  }, []);

  // 切换项目分组折叠
  const toggleProjectCollapse = useCallback((projectName: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName);
      else next.add(projectName);
      localStorage.setItem("pi-collapsed-projects", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const compactNow = useCallback(async () => {
    try {
      await rpc({ type: "compact" });
      toast("已压缩会话", "success");
      await refreshState(); await refreshStats();
    } catch (e) { toast(`压缩失败: ${e}`, "error"); }
  }, [rpc, toast, refreshState, refreshStats]);

  // ====== 发送 ======
  const abort = useCallback(async () => {
    try { await invoke("send_command", { command: { type: "abort" } }); }
    catch (e) { toast(`中断失败: ${e}`, "error"); }
  }, [toast]);

  // ====== 命令面板补全 ======
  const onCmdSelect = useCallback((text: string) => {
    setInput(text);
    setShowCmdPalette(false);
    setTimeout(() => {
      const ta = document.querySelector(".composer-inner textarea") as HTMLTextAreaElement;
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 0);
  }, []);

  const send = async (text?: string) => {
    const rawMsg = (text ?? input).trim();
    if (!rawMsg || busy || !ready) return;
    // 若处于预览模式（浏览的历史会话 != 当前活动会话），发消息前先真正切换。
    // 这是 switch_session 推迟切换的兑现点：浏览不打断，发消息才切换。
    if (previewPath && previewPath !== sessionFileRef.current) {
      try {
        const data = await rpc({ type: "switch_session", sessionPath: previewPath } as any);
        if (data?.cancelled) { toast("切换已被取消", "info"); return; }
        setPreviewPath(null); // 切换成功后退出预览模式
        await refreshState();
      } catch (e) {
        toast(`切换会话失败: ${e}`, "error"); return;
      }
    }
    if (rawMsg.startsWith("/")) {
      const cmd = rawMsg.toLowerCase();
      // /new 新建会话；其它斜杠命令透传给 pi（由 pi 处理，如 /compact /name /model 等）
      if (cmd === "/new") { setInput(""); newSession(); return; }
      if (cmd === "/help") {
        setInput("");
        toast("/new 新建会话 · /compact 压缩上下文 · 其它 / 命令透传给 Pi（如 /name、/model）", "info");
        return;
      }
      if (cmd === "/compact") { setInput(""); compactNow(); return; }
      // 注意：Pi 没有 /clear 命令（会话为 append-only，无法清空），曾把 /clear 当作新建会话，
      //       语义混淆，已移除。如需清空请用 /new 新建会话。
    }
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    currentTurnId.current = turnId; currentMsgId.current = null;
    pendingTextRef.current.clear(); pendingThinkingRef.current.clear();
    setTurns((prev) => [...prev, { id: turnId, userMessage: rawMsg, assistantMsgs: [], toolCalls: {}, status: "streaming" }]);
    setInput(""); setAutoFollow(true);
    try {
      await invoke("send_command", { command: { type: "prompt", message: rawMsg } });
    } catch (e) {
      toast(`发送失败: ${e}`, "error");
      setTurns((prev) => prev.map((t) => t.id === turnId ? { ...t, status: "done" } : t));
    }
  };

  const toggleTool = (turnId: string, toolId: string) => {
    setTurns((prev) => prev.map((t) => t.id === turnId
      ? { ...t, toolCalls: { ...t.toolCalls, [toolId]: { ...t.toolCalls[toolId], expanded: !t.toolCalls[toolId].expanded } } }
      : t));
  };

  // ====== 派生数据 ======
  const contextPercent = sessionStats?.contextUsage?.percent ?? 0;
  const contextClass = contextPercent > 80 ? "high" : contextPercent > 50 ? "mid" : "low";
  const inputCanSend = ready && !busy && input.trim().length > 0;
  const modelName = currentModel?.name || piState?.model?.name || "未设置";
  // 日志过滤
  const filteredLogs = logs.filter((l) => {
    if (logFilter !== "all" && l.type !== logFilter) return false;
    if (logSearch.trim() && !l.text.toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });
  const stderrCount = logs.filter((l) => l.type === "stderr").length;
  const currentSessionName = piState?.sessionName || "";
  // 会话搜索过滤（匹配文件名 / 首条消息标题 / 工作目录）
  const filteredSessions = sessionSearch.trim()
    ? sessions.filter((s) => {
        const q = sessionSearch.toLowerCase();
        return (s.name || "").toLowerCase().includes(q)
          || (s.title || "").toLowerCase().includes(q)
          || (s.cwd || "").toLowerCase().includes(q);
      })
    : sessions;

  // 当前会话的 cwd（用于文件浏览器初始定位）
  const currentSessionCwd = useMemo(() => {
    if (!currentSessionPath) return undefined;
    const match = sessions.find((s) => s.path === currentSessionPath);
    return match?.cwd;
  }, [currentSessionPath, sessions]);

  const projectSessions = useMemo(() => {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of filteredSessions) {
      const cwd = s.cwd?.trim();
      const normalized = cwd ? cwd.replace(/[\\/]+$/, "") : "";
      // 项目名只取最后一段目录名（缩写），避免显示完整路径
      const projectName = normalized
        ? (normalized.split(/[\\/]/).pop() || normalized)
        : "Logistic Workspace";
      if (!groups.has(projectName)) groups.set(projectName, []);
      groups.get(projectName)!.push(s);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredSessions]);

  return (
    <div className="app">
      {/* ============ 顶栏 ============ */}
      <header className="header">
        <button className="icon-btn" onClick={() => { refreshEnvKeys(); loadSystemPrompt(systemPromptPath); loadModelConfig(); setShowSettings(true); }} title="设置">☰</button>
        <div className="app-brand">
          <span className="app-brand-mark">HT</span>
          <span>Logistic Workspace</span>
        </div>
        <span className={`header-status ${ready ? (busy ? "busy" : "ready") : "error"}`}>
          <span className="dot" />
          {ready ? (busy ? "思考中" : "就绪") : "未连接"}
        </span>
        <div className="header-spacer" />
        {/* 调试日志 */}
        <button className={`icon-btn log-toggle ${stderrCount > 0 ? "has-warn" : ""}`} onClick={() => setShowLogViewer(true)} title="调试日志">
          📋
          {logs.length > 0 && <span className="badge">{logs.length}</span>}
        </button>
        {/* 窗口控制（自定义标题栏） */}
        <div className="window-controls">
          <button className="win-btn" onClick={() => getCurrentWindow().minimize()} title="最小化">&#8211;</button>
          <button className="win-btn" onClick={() => getCurrentWindow().toggleMaximize()} title="最大化">&#9633;</button>
          <button className="win-btn close" onClick={() => getCurrentWindow().close()} title="关闭">&#10005;</button>
        </div>
      </header>

      {/* ============ 主体 ============ */}
      <div className="body workspace-mode">
        {/* 左侧栏 */}
        <aside className="sidebar">
          {/* 扩展管理 */}
          <div className="sidebar-section sidebar-ext-section">
            <div className="sidebar-section-header">
              <span className="sidebar-title">扩展与技能</span>
              <button className="sidebar-new-btn" onClick={() => setShowExtManager(true)} title="管理扩展和技能">管理</button>
            </div>
          </div>
          {/* 会话列表 */}
          <div className="sidebar-section" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div className="sidebar-section-header">
              <span className="sidebar-title">历史会话</span>
              <button className="sidebar-new-btn" onClick={newSession} disabled={busy}>+ 新建</button>
            </div>
            {/* 搜索框 */}
            {sessions.length > 0 && (
              <div className="session-search-wrap">
                <input
                  className="session-search"
                  type="text"
                  placeholder="搜索会话…"
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                />
              </div>
            )}
            <div className="session-list">
              {filteredSessions.length === 0 ? (
                <div style={{ padding: "12px 8px", fontSize: 12, color: "var(--fg-muted)" }}>
                  {sessions.length === 0 ? "暂无历史会话" : "无匹配会话"}
                </div>
              ) : projectSessions.map(([projectName, groupSessions]) => {
                const collapsed = collapsedProjects.has(projectName);
                return (
                <div key={projectName} className="session-group">
                  <div className="session-group-header" onClick={() => toggleProjectCollapse(projectName)} style={{ cursor: "pointer" }}>
                    <span className="session-group-icon">{collapsed ? "▸" : "▾"}</span>
                    <span className="session-group-title" title={projectName}>
                      {projectName}
                    </span>
                    <span className="session-group-count">{groupSessions.length}</span>
                  </div>
                  {!collapsed && (
                  <div className="session-group-items">
                    {groupSessions.map((s) => {
                      const isActive = currentSessionPath === s.path;
                      const isPreviewing = previewPath === s.path && !isActive;
                      const isRenaming = renamingPath === s.path;
                      return (
                        <div
                          key={s.path}
                          className={`session-item ${isActive ? "active" : ""} ${isPreviewing ? "previewing" : ""}`}
                          onClick={() => !isRenaming && switchSession(s.path)}
                        >
                          <span className="session-icon">💬</span>
                          <div className="session-info">
                            {isRenaming ? (
                              <input
                                className="session-rename-input"
                                autoFocus
                                value={renameInput}
                                onChange={(e) => setRenameInput(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); confirmRename(); }
                                  if (e.key === "Escape") { e.preventDefault(); setRenamingPath(null); }
                                }}
                                onBlur={() => confirmRename()}
                              />
                            ) : (
                              <div className="session-name">{s.title || "未命名会话"}</div>
                            )}
                            {!isRenaming && (
                              <div className="session-meta">
                                {formatTime(s.mtime)}
                              </div>
                            )}
                          </div>
                          {isActive && !isRenaming && (
                            <div className="session-actions">
                              <button className="session-action-btn" onClick={(e) => { e.stopPropagation(); startRename(); }} title="重命名">✎</button>
                            </div>
                          )}
                          <button className="session-delete" onClick={(e) => deleteSession(s.path, e)} title="删除">✕</button>
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>

          {/* 统计 */}
          <div className="sidebar-section">
            <div className="sidebar-section-header"><span className="sidebar-title">当前会话</span></div>
            <div className="sidebar-stats">
              <div className="stat-row">
                <span className="stat-label">状态</span>
                <span className={`stat-value ${ready ? (busy ? "busy" : "ready") : "error"}`}>
                  {ready ? (busy ? "思考中" : "空闲") : "未连接"}
                </span>
              </div>
              {sessionStats?.cost != null && (
                <div className="stat-row"><span className="stat-label">费用</span><span className="stat-value">${sessionStats.cost.toFixed(4)}</span></div>
              )}
            </div>
          </div>

          {/* 上下文用量 */}
          <div className="sidebar-section">
            <div className="context-bar-wrap">
              <div className="context-bar-label">
                <span>上下文用量</span>
                <span>{contextPercent > 0 ? `${contextPercent.toFixed(0)}%` : "—"}</span>
              </div>
              <div className="context-bar">
                <div className={`context-bar-fill ${contextClass}`} style={{ width: `${Math.min(contextPercent, 100)}%` }} />
              </div>
            </div>
          </div>
        </aside>

        {/* 主区 */}
        <main className={`main ${turns.length === 0 ? "main-empty" : ""}`}>
          <div className="messages" ref={messagesRef} onScroll={handleScroll}>
            <div className="messages-inner">
              {turns.length === 0 ? (
                <div className="empty-state">
                  <h3>Logistic Workspace</h3>
                  <p>面向日常单据制作和物流数据分析的本地 AI 工作台。选择下方工具处理 Excel/PDF，或直接描述你要完成的任务。</p>
                </div>
              ) : turns.map((turn) => (
                <div key={turn.id} className="turn">
                  {turn.userMessage && (
                    <div className="msg user">
                      <div className="msg-content"><div className="msg-bubble user-bubble">{turn.userMessage}</div></div>
                    </div>
                  )}
                  {turn.assistantMsgs.length === 0 && turn.status === "streaming" ? (
                    <div className="msg assistant">
                      <div className="msg-content">
                        <div className="msg-bubble assistant-bubble">
                          <span className="thinking-dots"><span className="dot-pulse" /><span className="dot-pulse" /><span className="dot-pulse" /></span>
                        </div>
                      </div>
                    </div>
                  ) : turn.assistantMsgs.map((msg) => (
                    <div key={msg.id} className={`msg assistant ${msg.streaming ? "streaming" : ""}`}>
                      <div className="msg-content">
                        {msg.thinking && (
                          <details className="reasoning">
                            <summary>思维链 ({msg.thinking.length} 字)</summary>
                            <div className="reasoning-body">{msg.thinking}</div>
                          </details>
                        )}
                        <div className="msg-bubble assistant-bubble">
                          <Markdown content={msg.text} streaming={msg.streaming} />
                        </div>
                        {msg.toolCallIds.length > 0 && (
                          <div className="tool-list">
                            {msg.toolCallIds.map((tcId) => {
                              const tc = turn.toolCalls[tcId];
                              return tc ? <ToolCard key={tcId} tool={tc} onToggle={() => toggleTool(turn.id, tcId)} /> : null;
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <button className={`scroll-btn ${showScrollBtn ? "visible" : ""}`} onClick={() => scrollToBottom(true)} title="回到底部">↓</button>

          {/* 输入框 */}
          <div className="composer">
            {showCmdPalette && (
              <CommandPalette input={input} index={cmdIndex} setIndex={setCmdIndex} onSelect={onCmdSelect} />
            )}
            <div className="composer-shell">
              <div className="composer-inner">
                <textarea
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setShowCmdPalette(e.target.value.startsWith("/")); }}
                  onKeyDown={(e) => {
                    if (showCmdPalette) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setCmdIndex((i) => Math.min(i + 1, 7)); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setCmdIndex((i) => Math.max(i - 1, 0)); return; }
                      if (e.key === "Escape") { e.preventDefault(); setShowCmdPalette(false); return; }
                      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                        const cmdEl = document.querySelector(".cmd-item.active") as HTMLElement;
                        if (cmdEl) { e.preventDefault(); cmdEl.click(); return; }
                      }
                    }
                    if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                  }}
                  onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 200) + "px"; }}
                  placeholder={ready ? "输入单据制作、数据分析或物流问题…" : "正在连接 Pi…"}
                  rows={1}
                  disabled={!ready}
                />
                {busy ? (
                  <button className="abort-btn" onClick={abort} title="中断">中断</button>
                ) : (
                  <button className="send-btn" onClick={() => send()} disabled={!inputCanSend} title="发送">发送</button>
                )}
              </div>
              {/* 工具栏移到输入框下方 */}
              <div className="composer-toolbar">
                <div className="model-dropdown-wrap">
                  <button
                    className="composer-pill"
                    onClick={() => { refreshModels(); setShowModelDropdown((v) => !v); }}
                    title="切换模型"
                  >
                    {modelName} ▾
                  </button>
                  {showModelDropdown && (
                    <>
                      <div className="dropdown-overlay" onClick={() => setShowModelDropdown(false)} />
                      <div className="model-dropdown">
                        {models.length === 0 ? (
                          <div className="model-dropdown-empty">未找到可用模型，请先配置 API Key</div>
                        ) : models.map((m) => (
                          <button
                            key={`${m.provider}/${m.id}`}
                            className={`model-dropdown-item ${currentModel?.id === m.id ? "active" : ""}`}
                            onClick={() => { setModel(m.provider, m.id); setShowModelDropdown(false); }}
                          >
                            <span className="model-dropdown-name">{m.name}</span>
                            <span className="model-dropdown-meta">
                              {m.provider}{m.contextWindow ? ` · ${(m.contextWindow/1000).toFixed(0)}K` : ""}{m.reasoning ? " · 推理" : ""}
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <button
                  className="composer-pill"
                  onClick={() => cyclePermissionMode()}
                  title="切换工具权限模式"
                >
                  {permissionModeLabel}
                </button>
                <button className="composer-pill" onClick={() => setInput("帮我根据选中的物流文件制作发票和箱单，并检查缺失字段。")}>
                  单据制作
                </button>
                <button className="composer-pill" onClick={() => setInput("帮我分析这个物流 Excel，输出异常、趋势和下一步建议。")}>
                  数据分析
                </button>
                <button className="composer-pill" onClick={() => { setInput("/"); setShowCmdPalette(true); }}>
                  工具调用
                </button>
              </div>
            </div>
            <div className="composer-hint">
              <span className="kbd">Enter</span> 发送 · <span className="kbd">Shift+Enter</span> 换行 · <span className="kbd">Esc</span> 清空 · 物流工具在下方执行，结果可交给助手解读
              {busy && <span className="hint-busy"> · Pi 思考中…</span>}
            </div>
          </div>
          <section className="tool-workbench">
            <ToolsPanel onSendToAssistant={(message) => send(message)} />
          </section>
        </main>
        <aside className="workspace-files">
          <FileBrowser currentCwd={currentSessionCwd} compact />
        </aside>
      </div>

      {/* ============ Toast ============ */}
      <div className="toast-container">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
      </div>


      {/* ============ 扩展管理 Modal ============ */}
      {showExtManager && <ExtensionManager onClose={() => setShowExtManager(false)} />}

      {/* ============ 日志查看器 Modal ============ */}
      {showLogViewer && (
        <div className="modal-overlay" onClick={() => setShowLogViewer(false)}>
          <div className="modal log-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="log-header">
              <div className="modal-title">调试日志</div>
              <span className="log-count">共 {logs.length} 条{stderrCount > 0 && ` · stderr ${stderrCount}`}</span>
            </div>
            <div className="log-toolbar">
              <input
                className="log-search-input"
                type="text"
                placeholder="搜索日志内容…"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
              />
              <div className="log-filter-group">
                <button className={logFilter === "all" ? "active" : ""} onClick={() => setLogFilter("all")}>全部</button>
                <button className={logFilter === "stderr" ? "active" : ""} onClick={() => setLogFilter("stderr")}>stderr</button>
                <button className={logFilter === "event" ? "active" : ""} onClick={() => setLogFilter("event")}>事件</button>
              </div>
              <button className="btn-secondary log-clear-btn" onClick={() => setLogs([])} title="清空所有日志">清空</button>
            </div>
            <div
              className="log-list"
              ref={logListRef}
              onScroll={() => {
                const el = logListRef.current; if (!el) return;
                logAutoFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
            >
              {filteredLogs.length === 0 ? (
                <div className="log-empty">{logs.length === 0 ? "暂无日志记录" : "无匹配日志"}</div>
              ) : filteredLogs.map((log, i) => (
                <div key={i} className={`log-entry ${log.type}`}>
                  <span className="log-time">{new Date(log.time).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                  <span className="log-type-tag">{log.type === "stderr" ? "ERR" : "EVT"}</span>
                  <span className="log-text">{log.text}</span>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setLogs([]); }}>清空</button>
              <button className="btn-primary" onClick={() => setShowLogViewer(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 设置面板 Modal ============ */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="modal-title">设置</div>

            {/* 模型配置（含 API Key 管理）*/}
            <div className="settings-section">
              <div className="settings-section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>模型配置</span>
                {modelConfigDirty && (
                  <span style={{ color: "var(--warning)", fontSize: 11, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
                    有未保存改动
                  </span>
                )}
              </div>
              {!modelConfig ? (
                <div style={{ padding: "var(--space-4) 0", textAlign: "center", color: "var(--fg-muted)", fontSize: 13 }}>
                  加载中…
                </div>
              ) : (
                <>
                  <div className="model-config-list">
                    {modelConfig.providers.map((provider) => (
                      <div
                        key={provider.id}
                        className={`model-provider-card ${provider.enabled ? "enabled" : ""} ${editingProvider === provider.id ? "editing" : ""}`}
                      >
                        <div
                          className="model-provider-head"
                          onClick={() => setEditingProvider(editingProvider === provider.id ? null : provider.id)}
                        >
                          <div className="model-provider-left">
                            <div className={`toggle ${provider.enabled ? "on" : ""}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                updateProvider(provider.id, { enabled: !provider.enabled });
                              }}
                            />
                            <span className="model-provider-name">{provider.name}</span>
                            {provider.apiKey && provider.enabled && (
                              <span className="model-provider-status ok">已配置</span>
                            )}
                            {!provider.apiKey && (
                              <span className="model-provider-status missing">未配置</span>
                            )}
                          </div>
                          <span className="model-provider-chevron">
                            {editingProvider === provider.id ? "▴" : "▾"}
                          </span>
                        </div>
                        {editingProvider === provider.id && (
                          <div className="model-provider-body">
                            <div className="model-config-field">
                              <label className="model-config-label">API Key</label>
                              <input
                                type="password"
                                className="model-config-input"
                                value={provider.apiKey}
                                placeholder={`输入 ${provider.name} API Key`}
                                onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                              />
                            </div>
                            <div className="model-config-field">
                              <label className="model-config-label">Base URL（可选）</label>
                              <input
                                type="text"
                                className="model-config-input"
                                value={provider.baseUrl || ""}
                                placeholder="自定义 API 地址"
                                onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
                              />
                            </div>
                            <div className="model-config-field">
                              <label className="model-config-label">默认模型</label>
                              <select
                                className="model-config-select"
                                value={provider.defaultModel || ""}
                                onChange={(e) => updateProvider(provider.id, { defaultModel: e.target.value })}
                              >
                                {provider.models.map((m) => (
                                  <option key={m} value={m}>{m}</option>
                                ))}
                              </select>
                            </div>
                            <div className="model-config-field">
                              <label className="model-config-label">可用模型（每行一个）</label>
                              <textarea
                                className="model-config-textarea"
                                value={provider.models.join("\n")}
                                rows={3}
                                onChange={(e) => updateProvider(provider.id, { models: e.target.value.split("\n").filter((s) => s.trim()) })}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="model-config-actions">
                    <button
                      className="btn-primary"
                      onClick={saveModelConfig}
                      disabled={modelConfigSaving || !modelConfigDirty}
                    >
                      {modelConfigSaving ? "保存中…" : "保存模型配置"}
                    </button>
                    <span className="model-config-hint">
                      配置 API Key 后保存即注入环境变量，新会话立即生效。配置文件：~/.pi/agent/model-config.json
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* 主题 */}
            <div className="settings-section">
              <div className="settings-section-title">外观</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">主题</div>
                  <div className="setting-desc">深色 / 浅色 / 跟随系统</div>
                </div>
                <div className="setting-control">
                  <div className="theme-switch">
                    <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>深色</button>
                    <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>浅色</button>
                    <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")}>系统</button>
                  </div>
                </div>
              </div>
            </div>

            {/* 思维链 */}
            <div className="settings-section">
              <div className="settings-section-title">推理</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">思维链强度</div>
                  <div className="setting-desc">越高推理越深，但更慢更费 token</div>
                </div>
                <select
                  className="setting-select"
                  value={thinkingLevel}
                  onChange={(e) => setThinking(e.target.value)}
                >
                  <option value="off">关闭</option>
                  <option value="minimal">极简</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="xhigh">极高</option>
                </select>
              </div>
            </div>

            {/* 上下文管理 */}
            <div className="settings-section">
              <div className="settings-section-title">上下文管理</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">自动压缩</div>
                  <div className="setting-desc">上下文将满时自动压缩会话</div>
                </div>
                <div className={`toggle ${autoCompaction ? "on" : ""}`} onClick={() => toggleAutoCompaction(!autoCompaction)} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">手动压缩</div>
                  <div className="setting-desc">立即压缩当前会话</div>
                </div>
                <button className="btn-primary" onClick={compactNow} disabled={busy}>压缩</button>
              </div>
            </div>

            {/* 错误处理 */}
            <div className="settings-section">
              <div className="settings-section-title">错误处理</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">自动重试</div>
                  <div className="setting-desc">瞬时错误（限流/5xx）自动重试</div>
                </div>
                <div className={`toggle ${autoRetry ? "on" : ""}`} onClick={() => toggleAutoRetry(!autoRetry)} />
              </div>
            </div>

            {/* 工具权限 */}
            <div className="settings-section">
              <div className="settings-section-title">工具权限模式</div>
              <div className="setting-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: "var(--space-2)" }}>
                <div>
                  <div className="setting-label">权限模式</div>
                  <div className="setting-desc">控制 AI 助手调用工具时的确认行为，减少不必要的权限弹窗。</div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <button
                    className={`btn-primary ${permissionMode === "cautious" ? "" : "btn-secondary"}`}
                    style={{ opacity: permissionMode === "cautious" ? 1 : 0.6 }}
                    onClick={() => setPermissionModePersist("cautious")}
                  >审慎模式</button>
                  <button
                    className={`btn-primary ${permissionMode === "workspace" ? "" : "btn-secondary"}`}
                    style={{ opacity: permissionMode === "workspace" ? 1 : 0.6 }}
                    onClick={() => setPermissionModePersist("workspace")}
                  >工作台模式</button>
                  <button
                    className={`btn-primary ${permissionMode === "trust" ? "" : "btn-secondary"}`}
                    style={{ opacity: permissionMode === "trust" ? 1 : 0.6 }}
                    onClick={() => setPermissionModePersist("trust")}
                  >全信任模式</button>
                </div>
                <div className="setting-desc" style={{ fontSize: "0.85em" }}>
                  {permissionMode === "cautious" && "✓ 审慎模式：生成文件前确认，删除/外部请求必须确认。最安全，弹窗较多。"}
                  {permissionMode === "workspace" && "✓ 工作台模式：本地生成和分析自动执行，除了删除等重要修改外都自动放行。推荐。"}
                  {permissionMode === "trust" && "✓ 全信任模式：所有已授权工具自动执行，零打断。最快但有风险。"}
                </div>
              </div>
            </div>

            {/* 系统提示词编辑器 */}
            <div className="settings-section">
              <div className="settings-section-title">Agent 人设 / 系统提示词</div>
              <div className="setting-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: "var(--space-2)" }}>
                <div>
                  <div className="setting-label">提示词文件</div>
                  <div className="setting-desc">{systemPromptPathHint}</div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)", width: "100%" }}>
                  <select
                    className="setting-select"
                    style={{ flex: "0 0 auto" }}
                    value={systemPromptPath}
                    onChange={(e) => { setSystemPromptPath(e.target.value); loadSystemPrompt(e.target.value); }}
                  >
                    <option value="SYSTEM.md">SYSTEM.md（替换默认）</option>
                    <option value="APPEND_SYSTEM.md">APPEND_SYSTEM.md（追加）</option>
                    <option value="AGENTS.md">AGENTS.md（上下文文件）</option>
                  </select>
                  <button
                    className="btn-primary"
                    onClick={saveSystemPrompt}
                    disabled={systemPromptSaving || !systemPromptDirty}
                    style={{ flex: "0 0 auto" }}
                  >
                    {systemPromptSaving ? "保存中…" : "保存"}
                  </button>
                </div>
                <textarea
                  className="setting-textarea"
                  value={systemPrompt}
                  onChange={(e) => { setSystemPrompt(e.target.value); setSystemPromptDirty(true); }}
                  placeholder={"在此编写 agent 的系统提示词 / 人设。\n例如：你是 HT 物流公司的智能助理，专注于物流单据处理、运输调度、库存查询…"}
                  rows={12}
                  style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }}
                />
                <div className="setting-desc">
                  保存后<strong>新建会话</strong>即生效；当前会话不会热重载。
                  {systemPromptDirty && <span style={{ color: "var(--warning)" }}> · 有未保存改动</span>}
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn-primary" onClick={() => setShowSettings(false)}>完成</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Extension UI Modal ============ */}
      {uiRequest && (
        <div className="modal-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="modal">
            <div className="modal-title">{uiRequest.ev.title || "Pi 需要你的输入"}</div>
            {uiRequest.ev.message && <div className="modal-message">{uiRequest.ev.message}</div>}
            {uiRequest.ev.method === "confirm" && (
              <div className="modal-actions">
                <button className="btn-secondary" onClick={() => respondUiRequest({ confirmed: false, cancelled: false })}>取消</button>
                <button className="btn-primary" onClick={() => respondUiRequest({ confirmed: true, cancelled: false })}>确认</button>
              </div>
            )}
            {uiRequest.ev.method === "select" && uiRequest.ev.options && (
              <>
                <div className="modal-options">
                  {uiRequest.ev.options.map((opt: string, i: number) => (
                    <label key={i} className={`modal-option ${uiRequest.selectIndex === i ? "active" : ""}`}>
                      <input type="radio" name="modal-select" checked={uiRequest.selectIndex === i}
                        onChange={() => setUiRequest((r: any) => r ? { ...r, selectIndex: i } : null)} />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
                <div className="modal-actions">
                  <button className="btn-secondary" onClick={() => respondUiRequest({ cancelled: true })}>取消</button>
                  <button className="btn-primary" onClick={() => respondUiRequest({ value: uiRequest.ev.options[uiRequest.selectIndex] })}>确定</button>
                </div>
              </>
            )}
            {(uiRequest.ev.method === "input" || (uiRequest.ev.method !== "confirm" && uiRequest.ev.method !== "select")) && (
              <>
                <input type="text" className="modal-input" value={uiRequest.inputValue}
                  onChange={(e) => setUiRequest((r: any) => r ? { ...r, inputValue: e.target.value } : null)}
                  onKeyDown={(e) => { if (e.key === "Enter") respondUiRequest({ value: uiRequest.inputValue }); }}
                  autoFocus />
                <div className="modal-actions">
                  <button className="btn-secondary" onClick={() => respondUiRequest({ cancelled: true })}>取消</button>
                  <button className="btn-primary" onClick={() => respondUiRequest({ value: uiRequest.inputValue })}>确定</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 工具卡片组件 ============
function ToolCard({ tool, onToggle }: { tool: ToolCall; onToggle: () => void }) {
  const summary = formatToolSummary(tool.name, tool.args);
  return (
    <div className={`tool-card ${tool.status} ${tool.expanded ? "expanded" : ""}`}>
      <div className="tool-head" onClick={onToggle}>
        <span className={`tool-status-dot ${tool.status}`} />
        <span className="tool-name">{tool.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-chevron">{tool.expanded ? "▾" : "▸"}</span>
      </div>
      {tool.expanded && (
        <div className="tool-body">
          <div className="tool-section-label">参数</div>
          <pre className="tool-pre">{JSON.stringify(tool.args, null, 2)}</pre>
          {tool.result && (
            <>
              <div className="tool-section-label">结果</div>
              {(() => {
                // chart_render 工具的 details.chartConfig 用 Chart.js 渲染
                const chartCfg = extractChartConfig(tool.result);
                if (chartCfg && tool.name === "chart_render") {
                  return <ChartView config={chartCfg} />;
                }
                return <pre className="tool-pre">{formatToolResult(tool.result)}</pre>;
              })()}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ============ 工具函数 ============
function formatTime(unix: number): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return d.toLocaleDateString();
}

function formatToolSummary(name: string, args: any): string {
  if (!args) return "";
  switch (name) {
    case "query_database": return args.sql ? args.sql.slice(0, 60).replace(/\s+/g, " ") : "";
    case "task_create": return args.title || "";
    case "task_list": return args.status ? `status=${args.status}` : "全部";
    case "task_update": return `#${args.id} → ${args.status || args.priority || ""}`;
    case "note_upsert": return args.title || "";
    case "note_search": return args.keyword || "";
    case "http_request": return `${args.method || "GET"} ${args.url || ""}`;
    case "run_script": return args.script || "";
    case "parse_pdf": return args.path || "";
    case "vector_search": return args.query || "";
    default: return JSON.stringify(args).slice(0, 60);
  }
}

function formatToolResult(result: any): string {
  if (!result) return "";
  if (result.content && Array.isArray(result.content)) {
    const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const details = result.details ? `\n\n[details]\n${JSON.stringify(result.details, null, 2)}` : "";
    return text + details;
  }
  return JSON.stringify(result, null, 2);
}

// rebuildTurnsFromMessages / extractTextFromContent 已抽出到 ./utils.ts（便于单元测试）

