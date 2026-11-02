# 06 · Text2SQL 智能问数与 JSON 增量训练

本模块在不改动既有后端业务代码的前提下，新增了基于 **Vanna + ChromaDB + Ollama + MySQL** 的健康风险测评记录问数与 **JSON 语料增量训练** 模块，以及配套的前端交互界面。

---

## 1. 新增模块文件清单

### 后端新增文件（未修改既有业务代码）

| 文件 | 作用 |
| --- | --- |
| `backend/app/data/vanna_training_data.json` | 统一存放 `ddl`、`document`、`sql` 三类训练语料的持久化 JSON 文件（内置 `user_health_risk_assessment` 初始语料） |
| `backend/app/utils/vanna_training_store.py` | 线程安全、原子落盘、自动去重的 JSON 训练文件读写工具 |
| `backend/app/utils/vanna_engine.py` | `HealthRiskVanna` 封装（MySQL 连接、SQL 执行、从 JSON 全量训练、向 JSON 追加并执行增量训练） |
| `backend/app/routers/text2sql_router.py` | `/api/v1/text2sql` 路由：自然语言问数、全量训练、**增加训练接口**、JSON 语料查询/删除、表结构查询 |
| `backend/sql/user_health_risk_assessment.sql` | `user_health_risk_assessment` MySQL 建表脚本 |
| `backend/text2sql_main.py` | 可选独立启动入口（当本机未启动 Milvus 时可直接运行 Text2SQL 服务） |

> `backend/main.py` 仅新增 2 行挂载 `/api/v1/text2sql` 路由，其余既有后端文件均未修改。

### 前端与代理层新增文件

| 文件 | 作用 |
| --- | --- |
| `src/components/text2sql-dialog.tsx` | Text2SQL 问数、增加训练（分项表单 + JSON 批量/文件导入）、JSON 语料浏览维护、表结构查看弹窗 |
| `src/lib/text2sql-proxy.ts` | Next.js → FastAPI `/api/v1/text2sql` 转发层与本地 JSON 语料回退读取 |
| `src/app/api/v1/text2sql/**/route.ts` | `/status`、`/query`、`/ask`、`/train`、`/train/add`、`/train/data`、`/tables` 路由代理 |

---

## 2. 训练语料 JSON 文件格式（`vanna_training_data.json`）

```json
{
  "ddl": [
    "CREATE TABLE IF NOT EXISTS user_health_risk_assessment (...);"
  ],
  "document": [
    "用户健康风险测评记录表包含NRS2002营养风险筛查的完整评分数据..."
  ],
  "sql": [
    "SELECT user_name, age, total_score, risk_level FROM user_health_risk_assessment WHERE risk_level = '高风险' ORDER BY total_score DESC LIMIT 10",
    {
      "question": "查询70岁及以上高龄风险患者",
      "sql": "SELECT user_name, age, total_score FROM user_health_risk_assessment WHERE age >= 70 AND total_score >= 3"
    }
  ]
}
```

- `ddl`：字符串数组，每项为一条 `CREATE TABLE` 建表语句，训练时调用 `vn.train(ddl=...)`。
- `document`：字符串数组，每项为业务规则/字段说明，训练时调用 `vn.train(documentation=...)`。
- `sql`：支持纯 SQL 字符串（调用 `vn.train(sql=...)`）或 `{"question": "...", "sql": "..."}` 问答对（调用 `vn.train(question=..., sql=...)`）。

---

## 3. 接口说明（前缀 `/api/v1/text2sql`）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/text2sql/train/add` | **新增接口：增加训练**。接收 `ddl`、`document`、`sql`（单条或数组），自动去重写入 `vanna_training_data.json`，并在 `auto_train=true` 时立即调用 Vanna 完成增量训练 |
| `GET /api/v1/text2sql/train/data` | 读取当前 `vanna_training_data.json` 中的全部 `ddl`、`document`、`sql` 及条数统计 |
| `DELETE /api/v1/text2sql/train/data` | 按 `category`（`ddl` \| `document` \| `sql`）与 `index` 移除单条 JSON 语料 |
| `POST /api/v1/text2sql/train` | 读取 `vanna_training_data.json` 全部内容执行全量训练 |
| `POST /api/v1/text2sql/query` | 自然语言问数（生成 SQL 并按 `auto_execute` 执行查询返回结果集） |
| `GET /api/v1/text2sql/ask` | GET 简化问数接口（`?question=...&limit=10&user_id=...`） |
| `GET /api/v1/text2sql/tables` | 查询 MySQL `information_schema.COLUMNS` 表字段与注释 |
| `GET /api/v1/text2sql/health` | 检查 MySQL 连接、Vanna 模型状态与训练语料数量 |

### `POST /api/v1/text2sql/train/add` 请求示例

```json
{
  "ddl": "CREATE TABLE IF NOT EXISTS user_diet_log (id BIGINT PRIMARY KEY, user_id VARCHAR(64), kcal INT);",
  "document": "user_diet_log 记录患者每日实际摄入热量（kcal）。",
  "sql": [
    {
      "question": "查询摄入热量低于1200千卡的患者记录",
      "sql": "SELECT user_id, kcal FROM user_diet_log WHERE kcal < 1200"
    }
  ],
  "auto_train": true
}
```

---

## 4. 启动与验证

```bash
# 1. 初始化健康风险测评表（首次）
mysql -uroot -p123456 test_db < backend/sql/user_health_risk_assessment.sql

# 2. 启动后端（完整服务或独立 Text2SQL 服务二选一）
cd backend
pip install -r requirements.txt
python main.py            # 完整后端（需 Milvus 就绪）
# 或：python text2sql_main.py  # 无需 Milvus，直接启动 Text2SQL 服务（8018 端口）

# 3. 启动前端
npm run dev               # 点击右上角「Text2SQL 问数」打开界面
```
