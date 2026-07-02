# HT Logistic Workspace

物流工作台：工具区（箱单/发票生成、Excel数据分析、报关单提取、知识库查询）+ AI助手区。

## 架构

```
浏览器前端（三栏：工具 | 工作区 | AI助手）
        │ HTTP
FastAPI 后端（Python）
  ├─ 工具层（tools/*.py）：纯函数，输入→输出
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

## 待办

- [ ] 箱单/发票：按真实样例调整 Excel 解析和模板
- [ ] 货代发票生成
- [ ] Excel 数据分析报告
- [ ] 报关单信息提取
- [ ] 数据库/知识库查询
