# HT Logistic Workspace

物流工作台：工具区（发票/箱单生成、报关箱单生成、报关单提取）+ AI助手区。

## 架构

```
浏览器前端（三栏：工具 | 工作区 | AI助手）
        │ HTTP
FastAPI 后端（Python）
  ├─ 工具层（tools/*.py）：纯函数，输入→输出
  │   ├─ invoice_packing.py    发票/箱单生成（德速/联宇模板）
  │   ├─ customs_generator.py  报关箱单生成（FBA/WI/合并报关）
  │   └─ customs_extractor.py  报关单PDF提取（封装 extract_customs.py）
  └─ Pi 桥（pi_bridge.py）：连接 Pi 引擎，提供 AI 能力
        │ 子进程 RPC
Pi 引擎（pi --mode rpc）
```

## 启动

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 另开终端
cd frontend
python -m http.server 5173
```

浏览器打开 http://localhost:5173

## ⚠️ 模板文件（必须）

发票/箱单生成依赖以下模板，需放到 `backend/tools/templates/` 目录：

| 文件 | 用途 |
|---|---|
| `德速-模板.xlsx` | 德速渠道发票模板 |
| `联宇模板.xlsx` | 联宇渠道发票模板 |
| `商品尺寸申报清单.xlsx` | 商品申报单价/投保单价 |

报关单提取若遇图片型 PDF，需安装 [Tesseract-OCR](https://github.com/tesseract-ocr/tesseract)。

## 工具列表

| 工具 | 输入 | 输出 | 说明 |
|---|---|---|---|
| 发票/箱单生成 | 数据源.xlsx | zip(多Excel) | 按万邑通单号生成，自动选德速/联宇模板 |
| 报关箱单生成 | 数据源.xlsx | zip(多Excel) | FBA/WI/合并报关三种情况 |
| 报关单信息提取 | 报关单PDF | Excel | OCR+正则提取关键字段 |

## 待办

- [ ] Excel 数据分析报告（图表）
- [ ] 数据库/知识库查询
- [ ] Pi 扩展接入（让 AI 能调工具）
- [ ] 模板文件上传到仓库或提供下载说明
