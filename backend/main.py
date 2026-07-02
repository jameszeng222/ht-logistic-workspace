"""HT Logistic Workspace 后端入口

三层结构：
  1. 工具层（tools/*.py）：纯函数，输入→输出
  2. Pi 桥（pi_bridge.py）：连接 Pi 引擎，提供 AI 能力
  3. HTTP 层（本文件）：把工具和 AI 能力暴露给前端 + Pi 扩展

启动：uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from pi_bridge import PiBridge
from tools import packing_list


# 全局 Pi 桥实例（应用生命周期内单例）
pi = PiBridge()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时拉起 Pi，关闭时停止 Pi。"""
    try:
        await pi.start()
        print("[pi] 已连接")
    except RuntimeError as e:
        # Pi 未安装不阻断启动，工具区仍可用，AI 区会报错
        print(f"[pi] 启动失败（AI 功能不可用）: {e}")
    yield
    await pi.stop()


app = FastAPI(title="HT Logistic Workspace", lifespan=lifespan)

# 允许前端跨域（前端跑在 5173/任意端口）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ 工具接口 ============
# 每个工具一个端点。前端直接调（人用），Pi 扩展也调（AI 用）。

@app.post("/api/tools/packing-list")
async def gen_packing_list(file: UploadFile = File(...)):
    """箱单生成：上传订单 Excel → 返回箱单 Excel 下载。

    流程：读 Excel → 解析成 PackingList → 生成箱单 Excel
    """
    content = await file.read()
    data = packing_list.parse_orders_excel(content)
    out = packing_list.build_packing_list_excel(data)
    return Response(
        content=out,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=packing-list.xlsx"},
    )


@app.get("/api/tools")
async def list_tools():
    """列出所有可用工具（供前端工具区渲染 + Pi 扩展发现）。"""
    return {"tools": [
        {"id": "packing-list", "name": "箱单/发票生成", "endpoint": "/api/tools/packing-list", "input": "excel"},
        # 后续工具注册到这里
    ]}


# ============ AI 能力接口 ============
# 把 Pi 的能力暴露给前端。前端通过这些接口与 AI 交互。

@app.post("/api/ai/prompt")
async def ai_prompt(body: dict):
    """发一条消息给 Pi，返回（流式）。前端用 EventSource 接收。"""
    text = body.get("text", "").strip()
    if not text:
        return {"error": "空消息"}

    async def event_stream():
        # 先发 prompt（不等响应）
        await pi.send({"type": "prompt", "text": text})
        # 把 Pi 事件流转发给前端，直到 agent_end
        async for ev in pi.events():
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            if ev.get("type") == "agent_end":
                break

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/ai/state")
async def ai_state():
    """获取 Pi 当前状态（模型/会话/是否在输出）。"""
    try:
        resp = await pi.request({"type": "get_state"}, timeout=5)
        return resp.get("data", {})
    except Exception as e:
        return {"error": str(e)}
