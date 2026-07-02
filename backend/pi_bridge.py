"""Pi RPC 桥（Python 版）

把之前 Rust main.rs 的 Pi 桥逻辑移植成 Python：
  - 启动 `pi --mode rpc` 子进程
  - stdin/stdout JSONL 通信
  - 请求带 id，按 id 路由响应
  - 事件流通过 async queue 暴露给前端（SSE/WebSocket）

这样 FastAPI 后端能把 AI 能力（聊天、解释报告、检查字段）
暴露给前端，也能让 Pi 扩展通过 HTTP 调用工具层。
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator, Optional


class PiBridge:
    """Pi RPC 子进程的异步封装。

    用法：
        bridge = PiBridge()
        await bridge.start()
        resp = await bridge.request({"type": "get_state"})
        async for event in bridge.events():
            ...
    """

    def __init__(self) -> None:
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._event_queue: asyncio.Queue[dict] = asyncio.Queue()
        self._reader_task: Optional[asyncio.Task] = None

    @staticmethod
    def _find_pi() -> Optional[str]:
        """在 PATH 中查找 pi 可执行文件。"""
        # Windows 下 npm 全局包通常是 pi.cmd
        candidates = ["pi", "pi.cmd", "pi.bat"] if os.name == "nt" else ["pi"]
        for dir_name in os.environ.get("PATH", "").split(os.pathsep):
            for cand in candidates:
                full = os.path.join(dir_name, cand)
                if os.path.isfile(full):
                    return full
        return None

    async def start(self) -> None:
        """启动 pi 子进程并开始读取 stdout。"""
        pi_path = self._find_pi()
        if not pi_path:
            raise RuntimeError("未找到 pi，请先 npm i -g @earendil-works/pi-coding-agent")

        # CREATE_NO_WINDOW（Windows）：不弹黑窗，后台运行
        creationflags = 0x08000000 if os.name == "nt" else 0
        self._proc = await asyncio.create_subprocess_exec(
            pi_path, "--mode", "rpc",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=creationflags,
        )
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        """逐行读 stdout：response 按 id 路由到 future，event 放入队列。"""
        assert self._proc and self._proc.stdout
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            # 带 id 的是 response（对应某个 request）
            if msg.get("type") == "response" and "id" in msg:
                fut = self._pending.pop(msg["id"], None)
                if fut and not fut.done():
                    fut.set_result(msg)
            else:
                # event 流（agent_start / message_update 等）
                await self._event_queue.put(msg)

    async def request(self, command: dict, timeout: float = 30.0) -> dict:
        """发一个 RPC 请求并等响应。自动加 id 用于路由。"""
        assert self._proc and self._proc.stdin
        req_id = self._next_id
        self._next_id += 1
        command = {**command, "id": req_id}
        fut: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        self._proc.stdin.write((json.dumps(command) + "\n").encode())
        await self._proc.stdin.drain()
        return await asyncio.wait_for(fut, timeout)

    async def send(self, command: dict) -> None:
        """发一个通知类命令（不等响应），如 prompt / new_session。"""
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps(command) + "\n").encode())
        await self._proc.stdin.drain()

    async def events(self) -> AsyncIterator[dict]:
        """订阅 Pi 事件流。"""
        while True:
            yield await self._event_queue.get()

    async def stop(self) -> None:
        """停止 pi 子进程。"""
        if self._reader_task:
            self._reader_task.cancel()
        if self._proc:
            try:
                self._proc.terminate()
                await self._proc.wait()
            except ProcessLookupError:
                pass
        self._proc = None
