// 历史重建工具（从 App.tsx 抽出，便于单元测试）
// 把 Pi get_messages 返回的消息列表重建为 UI 的 turns 结构。

import type { Turn, AssistantMsg, ToolCall } from "./types";

// Pi 在新建会话时会自发输出一段 "Welcome to Pi ... interactive tutorial" 教程欢迎语，
// 这不是用户发起的对话，且与物流工作台场景无关，这里统一过滤掉。
// 特征：无前置 user 消息 + 助手文本命中教程签名。
const TUTORIAL_SIGNATURES = ["Welcome to Pi", "interactive tutorial"];
function isTutorialWelcome(userMessage: string, assistantText: string): boolean {
  if (userMessage.trim()) return false;
  return TUTORIAL_SIGNATURES.some((s) => assistantText.includes(s));
}

/**
 * 从 Pi 的 get_messages 响应重建 turns。
 * messages 形如 [{role:"user",content:"..."/[{type:"text",text}],timestamp},
 *                {role:"assistant",content:[{type:"text"|"thinking"|"toolCall",...}],id,timestamp},
 *                {role:"toolResult",toolCallId,content,isError},
 *                {role:"bashExecution",command,output,exitCode,timestamp}]
 */
export function rebuildTurnsFromMessages(messages: any[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let currentAssistantMsg: AssistantMsg | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentTurn && currentAssistantMsg) currentAssistantMsg.streaming = false;
      const userText = typeof msg.content === "string"
        ? msg.content
        : extractTextFromContent(msg.content);
      currentTurn = {
        id: `turn-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userMessage: userText,
        assistantMsgs: [],
        toolCalls: {},
        status: "done",
      };
      turns.push(currentTurn);
      currentAssistantMsg = null;
    } else if (msg.role === "assistant") {
      if (!currentTurn) {
        currentTurn = {
          id: `turn-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          userMessage: "",
          assistantMsgs: [],
          toolCalls: {},
          status: "done",
        };
        turns.push(currentTurn);
      }
      const msgId = msg.id || `msg-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const am: AssistantMsg = { id: msgId, text: "", streaming: false, toolCallIds: [] };
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content || "") }];
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          am.text += block.text;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          am.thinking = (am.thinking || "") + block.thinking;
        } else if (block.type === "toolCall" && block.id) {
          const tc: ToolCall = {
            id: block.id,
            name: block.name || "unknown",
            args: block.arguments || {},
            status: "done",
          };
          currentTurn.toolCalls[block.id] = tc;
          am.toolCallIds.push(block.id);
        }
      }
      currentTurn.assistantMsgs.push(am);
      currentAssistantMsg = am;
    } else if (msg.role === "toolResult") {
      if (currentTurn && msg.toolCallId && currentTurn.toolCalls[msg.toolCallId]) {
        currentTurn.toolCalls[msg.toolCallId].result = msg.content;
        if (msg.isError) currentTurn.toolCalls[msg.toolCallId].status = "error";
      }
    } else if (msg.role === "bashExecution") {
      if (currentTurn) {
        const tcId = `bash-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const tc: ToolCall = {
          id: tcId,
          name: "bash",
          args: { command: msg.command || "" },
          result: msg.output || "",
          status: msg.exitCode === 0 ? "done" : "error",
        };
        currentTurn.toolCalls[tcId] = tc;
        if (currentAssistantMsg) currentAssistantMsg.toolCallIds.push(tcId);
      }
    }
  }
  // 过滤掉 Pi 自发输出的教程欢迎语（无 user 消息 + 命中教程签名）
  return turns.filter((t) => {
    const assistantText = t.assistantMsgs.map((m) => m.text).join("");
    return !isTutorialWelcome(t.userMessage, assistantText);
  });
}

/** 从 content 块数组提取纯文本（user message 用） */
export function extractTextFromContent(content: any): string {
  if (!Array.isArray(content)) return String(content || "");
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}
