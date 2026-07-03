"""HT Logistic Workspace — 工具层 HTTP 入口

只负责工具（发票/箱单/报关单）调用，不碰 Pi。
Pi 由 Tauri 主进程直接管理（src-tauri/src/main.rs 的 start_pi），
避免两个进程同时拉起 Pi 造成会话/状态冲突。

启动（开发）：
    cd python-sidecar
    uvicorn main:app --reload --port 8000

启动（生产，PyInstaller 打包后）：
    ht-sidecar.exe   # 监听 127.0.0.1:8000
"""

from __future__ import annotations

import io
import zipfile

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from tools import invoice_packing, customs_generator, customs_extractor


app = FastAPI(title="HT Logistic Workspace — Tools")

# Tauri 前端跑在 http://tauri.localhost，开发态跑在 http://localhost:5173，
# 都需要能调本服务。允许所有 origin 简化开发，生产部署仅本机访问无安全风险。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ 工具发现 ============

@app.get("/api/tools")
async def list_tools():
    """列出所有可用工具（前端工具区渲染 + Pi 扩展发现都用这个）。"""
    return {"tools": [
        {
            "id": "invoice-packing",
            "name": "发票/箱单生成",
            "description": "上传数据源.xlsx，按万邑通单号生成发票+箱单（德速/联宇模板）",
            "endpoint": "/api/tools/invoice-packing",
            "input": "excel",
            "output": "zip",
        },
        {
            "id": "customs-generator",
            "name": "报关箱单生成",
            "description": "上传数据源.xlsx，按 FBA/WI/合并报关 三种情况生成报关箱单",
            "endpoint": "/api/tools/customs-generator",
            "input": "excel",
            "output": "zip",
        },
        {
            "id": "customs-extractor",
            "name": "报关单信息提取",
            "description": "上传报关单 PDF，OCR+正则提取关键字段（发货人/申报号/HS编码等）",
            "endpoint": "/api/tools/customs-extractor",
            "input": "pdf",
            "output": "excel",
        },
    ]}


@app.get("/api/health")
async def health():
    """健康检查，Tauri 启动 sidecar 后轮询此接口确认服务就绪。"""
    return {"ok": True}


# ============ 工具实现 ============

def _make_zip(files: dict[str, bytes]) -> bytes:
    """把 {文件名: bytes} 打包成 zip bytes。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


@app.post("/api/tools/invoice-packing")
async def gen_invoice_packing(file: UploadFile = File(...)):
    """发票/箱单生成：上传数据源.xlsx → 返回 zip（含多个 Excel）。"""
    content = await file.read()
    try:
        files = invoice_packing.generate_invoice_packing(content)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"模板文件缺失：{e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败：{e}")
    if not files:
        raise HTTPException(status_code=400, detail="未从数据源提取到任何单号")
    zip_bytes = _make_zip(files)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=invoice-packing.zip"},
    )


@app.post("/api/tools/customs-generator")
async def gen_customs_files(file: UploadFile = File(...)):
    """报关箱单生成：上传数据源.xlsx → 返回 zip。"""
    content = await file.read()
    try:
        files = customs_generator.generate_customs_files(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败：{e}")
    if not files:
        raise HTTPException(status_code=400, detail="未从数据源提取到任何单号")
    zip_bytes = _make_zip(files)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=customs-files.zip"},
    )


@app.post("/api/tools/customs-extractor")
async def extract_customs(file: UploadFile = File(...)):
    """报关单提取：上传 PDF → 返回 Excel。"""
    content = await file.read()
    try:
        result = customs_extractor.extract_customs_data(content, file.filename or "upload.pdf")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败：{e}")
    if not result["excel"]:
        raise HTTPException(status_code=400, detail="未从 PDF 提取到任何报关单数据")
    return Response(
        content=result["excel"],
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=customs-extracted.xlsx"},
    )


if __name__ == "__main__":
    # PyInstaller 打包后用 python main.py 直接跑（无 uvicorn CLI 时）。
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
