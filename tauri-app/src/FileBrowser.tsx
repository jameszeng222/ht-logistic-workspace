// 文件浏览器：浏览工作目录和会话目录
// - 工作目录：当前 Pi 会话的 cwd（项目文件）
// - 会话目录：~/.pi/agent/sessions/（历史会话文件）
//
// 通过 Rust 命令 list_dir 列目录、open_file 打开、open_in_explorer 定位

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

interface AgentPaths {
  home: string;
  agent: string;
  sessions: string;
  extensions: string;
  skills: string;
}

// 文件扩展名 → 图标
const FILE_ICONS: Record<string, string> = {
  json: "📋",
  jsonl: "📋",
  md: "📝",
  txt: "📄",
  rs: "🦀",
  ts: "🔷",
  tsx: "⚛️",
  js: "🟨",
  jsx: "🟨",
  py: "🐍",
  html: "🌐",
  css: "🎨",
  xlsx: "📊",
  xls: "📊",
  pdf: "📕",
  zip: "📦",
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  svg: "🖼️",
};

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || "📄";
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 将路径拆分为面包屑段
function splitPath(path: string): { name: string; path: string }[] {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const result: { name: string; path: string }[] = [];
  // Windows 盘符
  const isWindows = /^[A-Za-z]:/.test(parts[0] || "");
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    if (isWindows && i === 0) {
      acc = parts[0] + "\\";
    } else {
      acc = acc ? acc + "/" + parts[i] : "/" + parts[i];
    }
    result.push({ name: parts[i], path: acc });
  }
  return result;
}

interface FileBrowserProps {
  currentCwd?: string;
}

type BrowserTab = "workspace" | "sessions";

export function FileBrowser({ currentCwd }: FileBrowserProps) {
  const [tab, setTab] = useState<BrowserTab>("workspace");
  const [agentPaths, setAgentPaths] = useState<AgentPaths | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<DirEntry | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  // 加载 agent 路径
  useEffect(() => {
    (async () => {
      try {
        const paths = await invoke<AgentPaths>("get_agent_paths");
        setAgentPaths(paths);
      } catch (e) {
        setError(`获取路径信息失败：${e}`);
      }
    })();
  }, []);

  // 切换 tab 时设置初始路径
  useEffect(() => {
    if (!agentPaths) return;
    let target: string;
    if (tab === "workspace") {
      target = currentCwd || agentPaths.home;
    } else {
      target = agentPaths.sessions;
    }
    navigateTo(target, true);
  }, [tab, agentPaths, currentCwd]);

  const navigateTo = useCallback(async (path: string, reset: boolean = false) => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    try {
      const list = await invoke<DirEntry[]>("list_dir", { path });
      setEntries(list);
      setCurrentPath(path);
      if (reset) {
        setHistory([path]);
        setHistoryIdx(0);
      } else {
        // 截断历史（如果在中间后退过）
        const newHistory = history.slice(0, historyIdx + 1);
        newHistory.push(path);
        setHistory(newHistory);
        setHistoryIdx(newHistory.length - 1);
      }
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [history, historyIdx]);

  const goBack = useCallback(() => {
    if (historyIdx <= 0) return;
    const newIdx = historyIdx - 1;
    setHistoryIdx(newIdx);
    const path = history[newIdx];
    setLoading(true);
    invoke<DirEntry[]>("list_dir", { path })
      .then((list) => { setEntries(list); setCurrentPath(path); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [history, historyIdx]);

  const goForward = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    const newIdx = historyIdx + 1;
    setHistoryIdx(newIdx);
    const path = history[newIdx];
    setLoading(true);
    invoke<DirEntry[]>("list_dir", { path })
      .then((list) => { setEntries(list); setCurrentPath(path); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [history, historyIdx]);

  const goUp = useCallback(() => {
    if (!currentPath) return;
    const parts = currentPath.split(/[\\/]/);
    if (parts.length <= 1) return;
    // Windows 盘符根目录
    if (parts.length === 2 && /^[A-Za-z]:$/.test(parts[0])) {
      navigateTo(parts[0] + "\\");
      return;
    }
    parts.pop();
    const parent = parts.join("/") || "/";
    navigateTo(parent);
  }, [currentPath, navigateTo]);

  const handleEntryClick = useCallback((entry: DirEntry) => {
    setSelectedEntry(entry);
    if (entry.is_dir) {
      navigateTo(entry.path);
    }
  }, [navigateTo]);

  const handleOpenFile = useCallback(async (entry: DirEntry) => {
    try {
      await invoke("open_file", { path: entry.path });
    } catch (e) {
      setError(`打开文件失败：${e}`);
    }
  }, []);

  const handleShowInExplorer = useCallback(async (entry: DirEntry) => {
    try {
      await invoke("open_in_explorer", { path: entry.path });
    } catch (e) {
      setError(`定位失败：${e}`);
    }
  }, []);

  const handlePathSubmit = useCallback(() => {
    const input = pathInputRef.current;
    if (!input) return;
    const path = input.value.trim();
    if (path && path !== currentPath) {
      navigateTo(path);
    }
  }, [currentPath, navigateTo]);

  const breadcrumbs = currentPath ? splitPath(currentPath) : [];

  return (
    <div className="file-browser">
      {/* 标签页切换 */}
      <div className="fb-tabs">
        <button
          className={`fb-tab ${tab === "workspace" ? "active" : ""}`}
          onClick={() => setTab("workspace")}
        >📁 工作目录</button>
        <button
          className={`fb-tab ${tab === "sessions" ? "active" : ""}`}
          onClick={() => setTab("sessions")}
        >💬 会话目录</button>
      </div>

      {/* 工具栏：后退/前进/上级 + 地址栏 */}
      <div className="fb-toolbar">
        <div className="fb-nav-btns">
          <button
            className="fb-nav-btn"
            onClick={goBack}
            disabled={historyIdx <= 0}
            title="后退"
          >‹</button>
          <button
            className="fb-nav-btn"
            onClick={goForward}
            disabled={historyIdx >= history.length - 1}
            title="前进"
          >›</button>
          <button
            className="fb-nav-btn"
            onClick={goUp}
            disabled={!currentPath}
            title="上一级"
          >↑</button>
          <button
            className="fb-nav-btn"
            onClick={() => navigateTo(currentPath, true)}
            disabled={loading}
            title="刷新"
          >↻</button>
        </div>
        <input
          ref={pathInputRef}
          className="fb-path-input"
          defaultValue={currentPath}
          key={currentPath}
          onKeyDown={(e) => { if (e.key === "Enter") handlePathSubmit(); }}
          placeholder="输入路径..."
        />
      </div>

      {/* 面包屑 */}
      {breadcrumbs.length > 0 && (
        <div className="fb-breadcrumbs">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="fb-crumb-wrap">
              {i > 0 && <span className="fb-crumb-sep">/</span>}
              <button
                className="fb-crumb"
                onClick={() => navigateTo(crumb.path)}
              >{crumb.name}</button>
            </span>
          ))}
        </div>
      )}

      {/* 文件列表 */}
      <div className="fb-file-list">
        {loading ? (
          <div className="fb-empty">加载中…</div>
        ) : error ? (
          <div className="fb-error">
            <div className="fb-error-msg">❌ {error}</div>
            <button className="btn-secondary" onClick={goUp}>返回上级</button>
          </div>
        ) : entries.length === 0 ? (
          <div className="fb-empty">空目录</div>
        ) : (
          <>
            {/* 表头 */}
            <div className="fb-list-header">
              <span className="fb-col-name">名称</span>
              <span className="fb-col-size">大小</span>
              <span className="fb-col-modified">修改时间</span>
              <span className="fb-col-actions">操作</span>
            </div>
            {/* 条目 */}
            {entries.map((entry) => (
              <div
                key={entry.path}
                className={`fb-entry ${entry.is_dir ? "dir" : "file"} ${selectedEntry?.path === entry.path ? "selected" : ""}`}
                onClick={() => handleEntryClick(entry)}
              >
                <span className="fb-col-name">
                  <span className="fb-entry-icon">{entry.is_dir ? "📁" : getFileIcon(entry.name)}</span>
                  <span className="fb-entry-name">{entry.name}</span>
                </span>
                <span className="fb-col-size">{formatSize(entry.size)}</span>
                <span className="fb-col-modified">{formatDate(entry.modified)}</span>
                <span className="fb-col-actions" onClick={(e) => e.stopPropagation()}>
                  {!entry.is_dir && (
                    <button
                      className="fb-action-btn"
                      onClick={() => handleOpenFile(entry)}
                      title="用系统默认程序打开"
                    >打开</button>
                  )}
                  <button
                    className="fb-action-btn"
                    onClick={() => handleShowInExplorer(entry)}
                    title="在文件管理器中显示"
                  >定位</button>
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* 状态栏 */}
      <div className="fb-statusbar">
        <span>{entries.length} 项</span>
        {entries.filter((e) => !e.is_dir).length > 0 && (
          <span>· {entries.filter((e) => !e.is_dir).length} 个文件</span>
        )}
        {entries.filter((e) => e.is_dir).length > 0 && (
          <span>· {entries.filter((e) => e.is_dir).length} 个文件夹</span>
        )}
        {selectedEntry && (
          <span className="fb-status-selected">· 已选：{selectedEntry.name}</span>
        )}
      </div>
    </div>
  );
}
