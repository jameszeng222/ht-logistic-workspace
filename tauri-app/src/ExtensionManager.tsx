// src/ExtensionManager.tsx
// 扩展管理：调 get_commands 拉命令列表，按 source 分组展示
// extension / prompt / skill 三类，skill 可查看 md 内容

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Markdown } from "./Markdown";

interface PiCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: string;
  path?: string;
}

export function ExtensionManager({ onClose }: { onClose: () => void }) {
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [viewingContent, setViewingContent] = useState<string>("");
  const [viewingName, setViewingName] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const data = await invoke<any>("send_request", { command: { type: "get_commands" } });
        const list = Array.isArray(data) ? data : (data?.commands || data?.list || []);
        setCommands(list.map((c: any) => ({
          name: c.name || c.command || c.id || String(c),
          description: c.description || c.desc || c.help,
          source: c.source || "extension",
          location: c.location,
          path: c.path,
        })));
      } catch (e) { setError(String(e)); }
      setLoading(false);
    })();
  }, []);

  const viewFile = async (path: string, name: string) => {
    setViewingPath(path); setViewingName(name); setViewingContent("");
    try {
      const content = await invoke<string>("read_text_file", { path });
      setViewingContent(content);
    } catch (e) { setViewingContent(`读取失败：${e}`); }
  };

  const extensions = commands.filter((c) => c.source === "extension");
  const prompts = commands.filter((c) => c.source === "prompt");
  const skills = commands.filter((c) => c.source === "skill");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal ext-mgr-modal" onClick={(e) => e.stopPropagation()}>
        {viewingPath ? (
          // ====== 查看文件内容 ======
          <>
            <div className="modal-title">
              <button className="icon-btn ext-back-btn" onClick={() => setViewingPath(null)}>← 返回</button>
              {viewingName}
            </div>
            <div className="ext-viewer">
              <Markdown content={viewingContent || "加载中…"} />
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setViewingPath(null)}>关闭</button>
            </div>
          </>
        ) : (
          // ====== 列表视图 ======
          <>
            <div className="modal-title">
              扩展管理
              <span className="ext-mgr-stats">
                {extensions.length} 扩展 · {prompts.length} 模板 · {skills.length} Skill
              </span>
            </div>
            {loading ? (
              <div className="ext-loading">加载中…</div>
            ) : error ? (
              <div className="ext-error">加载失败：{error}</div>
            ) : commands.length === 0 ? (
              <div className="ext-empty">没有已加载的命令。请在 ~/.pi/agent/ 或 ./.pi/agent/ 下配置扩展与技能。</div>
            ) : (
              <div className="ext-mgr-body">
                {skills.length > 0 && (
                  <div className="ext-group">
                    <div className="ext-group-title">技能 (Skills)</div>
                    {skills.map((c) => (
                      <div key={c.name} className="ext-item" onClick={() => c.path && viewFile(c.path, c.name)}>
                        <div className="ext-item-main">
                          <span className="ext-item-name">{c.name}</span>
                          {c.description && <span className="ext-item-desc">{c.description}</span>}
                        </div>
                        {c.path && <span className="ext-item-view">查看</span>}
                        {c.location && <span className="ext-item-loc">{c.location}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {extensions.length > 0 && (
                  <div className="ext-group">
                    <div className="ext-group-title">扩展命令 (Extensions)</div>
                    {extensions.map((c) => (
                      <div key={c.name} className="ext-item" onClick={() => c.path && viewFile(c.path, c.name)}>
                        <div className="ext-item-main">
                          <span className="ext-item-name">/{c.name}</span>
                          {c.description && <span className="ext-item-desc">{c.description}</span>}
                        </div>
                        {c.path && <span className="ext-item-view">查看</span>}
                      </div>
                    ))}
                  </div>
                )}
                {prompts.length > 0 && (
                  <div className="ext-group">
                    <div className="ext-group-title">Prompt 模板</div>
                    {prompts.map((c) => (
                      <div key={c.name} className="ext-item" onClick={() => c.path && viewFile(c.path, c.name)}>
                        <div className="ext-item-main">
                          <span className="ext-item-name">/{c.name}</span>
                          {c.description && <span className="ext-item-desc">{c.description}</span>}
                        </div>
                        {c.path && <span className="ext-item-view">查看</span>}
                        {c.location && <span className="ext-item-loc">{c.location}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn-primary" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
