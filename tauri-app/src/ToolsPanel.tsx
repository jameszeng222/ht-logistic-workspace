// 工具区面板：拖拽上传文件 → 调 FastAPI → 下载结果。
// 与 AI 助手区平级，由 App.tsx 顶部 tab 切换。
//
// 后端是 python-sidecar/main.py（FastAPI on 127.0.0.1:8000）。
// Tauri setup 时拉起 sidecar，ready 状态通过 sidecar-status 事件 + sidecar_status 命令获取。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface ToolDef {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  input: "excel" | "pdf";
  output: "zip" | "excel";
}

interface SidecarStatus {
  running: boolean;
  ready: boolean;
  url: string;
  error?: string;
}

const INPUT_ACCEPT: Record<ToolDef["input"], string> = {
  excel: ".xlsx,.xls",
  pdf: ".pdf",
};

export function ToolsPanel() {
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [sidecarUrl, setSidecarUrl] = useState("http://127.0.0.1:8000");
  const [sidecarReady, setSidecarReady] = useState(false);
  const [sidecarError, setSidecarError] = useState<string | null>(null);

  const [activeTool, setActiveTool] = useState<ToolDef | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultName, setResultName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ============ 加载工具列表 + 监听 sidecar 状态 ============
  const refreshTools = useCallback(async () => {
    if (!sidecarReady) return;
    try {
      const resp = await fetch(`${sidecarUrl}/api/tools`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setTools(data.tools || []);
      if (!activeTool && data.tools?.length) setActiveTool(data.tools[0]);
    } catch (e) {
      setError(`拉取工具列表失败：${e}`);
    }
  }, [sidecarUrl, sidecarReady, activeTool]);

  const checkStatus = useCallback(async () => {
    try {
      const st = await invoke<SidecarStatus>("sidecar_status");
      setSidecarReady(st.ready);
      if (st.url) setSidecarUrl(st.url);
    } catch (e) {
      setSidecarError(String(e));
    }
  }, []);

  useEffect(() => {
    checkStatus();
    let unlisten: UnlistenFn | undefined;
    (async () => {
      unlisten = await listen<SidecarStatus>("sidecar-status", (e) => {
        setSidecarReady(e.payload.ready);
        if (e.payload.url) setSidecarUrl(e.payload.url);
        if (e.payload.error) setSidecarError(e.payload.error);
        else setSidecarError(null);
      });
    })();
    return () => { unlisten?.(); };
  }, [checkStatus]);

  useEffect(() => { refreshTools(); }, [refreshTools]);

  // ============ 文件选择 ============
  const onSelectFile = (f: File | null) => {
    setFile(f);
    setResultUrl(null);
    setResultName("");
    setError(null);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onSelectFile(f);
  }, []);

  // ============ 调用工具 ============
  const runTool = useCallback(async () => {
    if (!activeTool || !file || !sidecarReady) return;
    setRunning(true);
    setError(null);
    setResultUrl(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(`${sidecarUrl}${activeTool.endpoint}`, {
        method: "POST",
        body: fd,
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const errBody = await resp.json();
          if (errBody.detail) msg = errBody.detail;
        } catch {}
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const cd = resp.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^"]+)"?/);
      const name = m?.[1]
        || (activeTool.output === "zip" ? `${activeTool.id}.zip` : `${activeTool.id}.xlsx`);
      setResultUrl(url);
      setResultName(name);
    } catch (e) {
      setError(`工具执行失败：${e}`);
    } finally {
      setRunning(false);
    }
  }, [activeTool, file, sidecarUrl, sidecarReady]);

  return (
    <div className="tools-panel">
      <div className="tools-header">
        <div className="tools-title">工具区</div>
        <div className={`sidecar-status ${sidecarReady ? "ready" : "error"}`}>
          <span className="dot" />
          {sidecarReady ? "Sidecar 在线" : sidecarError ? "Sidecar 异常" : "Sidecar 启动中…"}
        </div>
      </div>
      {sidecarError && (
        <div className="tools-banner error">{sidecarError}</div>
      )}

      <div className="tools-body">
        <div className="tools-list">
          <div className="tools-list-title">可用工具</div>
          {tools.length === 0 ? (
            <div className="tools-empty">
              {sidecarReady ? "未拉到工具列表" : "等待 sidecar 就绪…"}
            </div>
          ) : tools.map((t) => (
            <button
              key={t.id}
              className={`tool-card ${activeTool?.id === t.id ? "active" : ""}`}
              onClick={() => { setActiveTool(t); onSelectFile(null); }}
            >
              <div className="tool-card-name">{t.name}</div>
              <div className="tool-card-desc">{t.description}</div>
              <div className="tool-card-meta">
                <span>{t.input.toUpperCase()}</span>
                <span>→</span>
                <span>{t.output.toUpperCase()}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="tools-detail">
          {activeTool ? (
            <>
              <div className="tool-detail-title">{activeTool.name}</div>
              <div className="tool-detail-desc">{activeTool.description}</div>

              <div
                className={`drop-zone ${dragOver ? "drag" : ""} ${file ? "has-file" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={INPUT_ACCEPT[activeTool.input]}
                  style={{ display: "none" }}
                  onChange={(e) => onSelectFile(e.target.files?.[0] || null)}
                />
                {file ? (
                  <div className="drop-file-info">
                    <div className="drop-file-name">{file.name}</div>
                    <div className="drop-file-size">{formatBytes(file.size)}</div>
                  </div>
                ) : (
                  <div className="drop-hint">
                    <div className="drop-icon">⬆</div>
                    <div>拖拽文件到此处，或点击选择</div>
                    <div className="drop-accept">支持：{INPUT_ACCEPT[activeTool.input]}</div>
                  </div>
                )}
              </div>

              <div className="tool-actions">
                <button
                  className="btn-primary"
                  onClick={runTool}
                  disabled={!file || running || !sidecarReady}
                >
                  {running ? "执行中…" : "执行工具"}
                </button>
                {file && (
                  <button className="btn-secondary" onClick={() => onSelectFile(null)}>清除</button>
                )}
              </div>

              {error && <div className="tool-error">{error}</div>}

              {resultUrl && (
                <div className="tool-result">
                  <div className="tool-result-label">完成 — 下载结果：</div>
                  <a className="tool-download" href={resultUrl} download={resultName}>
                    ⬇ {resultName}
                  </a>
                </div>
              )}
            </>
          ) : (
            <div className="tools-empty">请从左侧选择一个工具</div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
