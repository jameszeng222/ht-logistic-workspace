// HT Logistic Workspace 前端逻辑
// 三栏联动：选工具 → 拖文件 → 看结果 → 问 AI

const API = "http://localhost:8000";

// ===== 工具区：加载工具列表 =====
let currentTool = null;

async function loadTools() {
  const res = await fetch(`${API}/api/tools`);
  const data = await res.json();
  const list = document.getElementById("tool-list");
  list.innerHTML = "";
  for (const t of data.tools) {
    const li = document.createElement("li");
    li.textContent = t.name;
    li.dataset.id = t.id;
    li.onclick = () => selectTool(t);
    list.appendChild(li);
  }
}

function selectTool(tool) {
  currentTool = tool;
  document.querySelectorAll(".tool-list li").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === tool.id);
  });
  document.getElementById("current-tool").textContent = tool.name;
  // 重置工作区到输入态
  document.getElementById("work-input").hidden = false;
  document.getElementById("work-processing").hidden = true;
  document.getElementById("work-result").hidden = true;
}

// ===== 拖拽上传 =====
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");

dropzone.onclick = () => fileInput.click();
dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add("dragover"); };
dropzone.ondragleave = () => dropzone.classList.remove("dragover");
dropzone.ondrop = (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
};
fileInput.onchange = () => { if (fileInput.files.length) handleFile(fileInput.files[0]); };

async function handleFile(file) {
  if (!currentTool) { alert("请先选择左侧工具"); return; }
  // 切到处理中
  document.getElementById("work-input").hidden = true;
  document.getElementById("work-processing").hidden = false;

  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API}${currentTool.endpoint}`, { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());

    // 下载结果
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.getElementById("download-link");
    link.href = url;
    link.download = `result-${Date.now()}.xlsx`;

    document.getElementById("work-processing").hidden = true;
    document.getElementById("work-result").hidden = false;
  } catch (e) {
    alert("处理失败: " + e.message);
    document.getElementById("work-processing").hidden = true;
    document.getElementById("work-input").hidden = false;
  }
}

// ===== AI 助手 =====
const aiInput = document.getElementById("ai-input");
const aiSend = document.getElementById("ai-send");
const aiMessages = document.getElementById("ai-messages");

async function sendAI() {
  const text = aiInput.value.trim();
  if (!text) return;
  aiInput.value = "";
  appendMsg("user", text);

  // SSE 流式接收 Pi 事件
  const res = await fetch(`${API}/api/ai/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let assistantEl = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const ev = JSON.parse(line.slice(6));
      // 简化：把 text_delta 累加到一条 assistant 消息
      if (ev.type === "agent_start") {
        assistantEl = appendMsg("assistant", "");
      } else if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        if (assistantEl) assistantEl.textContent += ev.assistantMessageEvent.delta;
      }
    }
  }
}

function appendMsg(role, text) {
  const el = document.createElement("div");
  el.className = `ai-msg ${role}`;
  el.textContent = text;
  aiMessages.appendChild(el);
  aiMessages.scrollTop = aiMessages.scrollHeight;
  return el;
}

aiSend.onclick = sendAI;
aiInput.onkeydown = (e) => { if (e.key === "Enter") sendAI(); };

// ===== 初始化 =====
(async () => {
  await loadTools();
  // 检查 Pi 状态
  try {
    const res = await fetch(`${API}/api/ai/state`);
    const data = await res.json();
    const el = document.getElementById("pi-status");
    if (data.error) { el.textContent = "AI: 不可用"; el.className = "status err"; }
    else { el.textContent = "AI: 已连接"; el.className = "status ok"; }
  } catch {
    document.getElementById("pi-status").textContent = "AI: 后端未启动";
  }
})();
