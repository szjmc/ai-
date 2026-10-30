# 07 · Text2SQL 智能问数与增量训练测试用例集

本文档提供 **可直接复制粘贴** 的完整测试用例，涵盖：
1. **MySQL 样本测试数据初始化**（15 条 NRS2002 测评记录 + 6 条营养干预关联记录）
2. **「增加训练」功能测试用例**（前端表单 / JSON 批量导入 / Postman 接口报文）
3. **「自然语言智能问数」测试用例**（基础查询、复合统计、增量训练前后效果对比、边界异常）
4. **语料库维护与表结构接口测试用例**（`curl` / Swagger）
5. **自动化单元测试矩阵与运行命令**

---

## 0. 前置：一键导入 MySQL 样本测试数据

若本地 `test_db` 中尚无测评样本数据，可直接运行仓库提供的测试数据脚本（也可在 Navicat / DBeaver 中整段粘贴执行）：

```bash
mysql -uroot -p123456 test_db < backend/sql/seed_health_risk_test_data.sql
```

导入后包含：
- `user_health_risk_assessment`：**15 条记录**（覆盖 `无风险 / 低风险 / 中风险 / 高风险`、`age >= 70` 老年患者、`bmi < 18.5` 低体重患者、`USER001` 的 3 次动态复测记录、最近 7 天每日测评记录）。
- `user_nutrition_intervention`：**6 条记录**（用于验证「增量训练新表 DDL + 跨表关联问数」）。

---

## 1. 增量训练（`/api/v1/text2sql/train/add` & 前端「增加训练」Tab）测试用例

### 用例 T-ADD-01：新增单条「业务文档 + 问答 SQL 对」（分项表单模式）
- **测试入口**：前端右上角「Text2SQL 问数」→「增加训练」Tab →「分项表单录入」，勾选「保存后立即增量训练到 Vanna」
- **输入内容**：
  - **DDL**：留空
  - **Document（业务文档说明）**：
    ```text
    临床低体重与高龄营养筛查口径说明：
    1. 低体重/消瘦患者定义为 bmi < 18.5。
    2. 高龄老年患者定义为 age >= 70（对应 age_score = 1）。
    3. 存在营养风险定义为 total_score >= 3（包含风险等级为“中风险”或“高风险”的记录）。
    ```
  - **SQL 示例 #1 - 自然语言问题（可选）**：
    ```text
    查询70岁及以上且BMI低于18.5的高龄低体重患者姓名、年龄、BMI、总分和风险等级
    ```
  - **SQL 示例 #1 - 示例 SQL**：
    ```sql
    SELECT user_name, age, bmi, total_score, risk_level FROM user_health_risk_assessment WHERE age >= 70 AND bmi < 18.5 ORDER BY total_score DESC
    ```
- **预期结果**：
  1. 页面提示「新增训练完成：语料已写入 JSON 文件并同步至 Vanna 模型」。
  2. `added` 返回 `{"ddl": 0, "document": 1, "sql": 1}`，`trained: true`。
  3. 切换到「JSON 语料库」Tab 可看到 `Document` 与 `SQL` 计数各 `+1`，且磁盘文件 `backend/app/data/vanna_training_data.json` 同步更新。

---

### 用例 T-ADD-02：JSON 批量导入新表 `user_nutrition_intervention`（DDL + Document + 跨表 JOIN SQL）
- **测试入口**：「增加训练」Tab → 切换到「JSON 批量导入」（或直接调用 `POST /api/v1/text2sql/train/add`）
- **请求/粘贴 JSON**：
```json
{
  "ddl": [
    "CREATE TABLE IF NOT EXISTS user_nutrition_intervention (\n    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '干预记录ID',\n    user_id VARCHAR(64) NOT NULL COMMENT '关联用户唯一标识',\n    assessment_id BIGINT NOT NULL COMMENT '关联测评记录ID',\n    intervention_type ENUM('饮食指导', '口服营养补充', '肠内营养', '肠外营养') NOT NULL COMMENT '干预方式',\n    daily_target_kcal INT COMMENT '每日目标热量(kcal)',\n    follow_up_date DATE COMMENT '复评日期',\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户营养干预方案表';"
  ],
  "document": [
    "user_nutrition_intervention 表记录营养风险患者的临床营养干预方案，通过 user_id 与 user_health_risk_assessment.user_id 关联，或通过 assessment_id 与 user_health_risk_assessment.id 关联。intervention_type 取值包括：饮食指导、口服营养补充、肠内营养、肠外营养。"
  ],
  "sql": [
    {
      "question": "查询正在接受肠内营养干预的患者姓名、风险等级、每日目标热量和复评日期",
      "sql": "SELECT a.user_name, a.risk_level, i.intervention_type, i.daily_target_kcal, i.follow_up_date FROM user_nutrition_intervention i JOIN user_health_risk_assessment a ON i.assessment_id = a.id WHERE i.intervention_type = '肠内营养' ORDER BY i.follow_up_date ASC"
    },
    {
      "question": "统计每种营养干预方式对应的记录数和平均每日目标热量",
      "sql": "SELECT intervention_type, COUNT(*) AS intervention_count, ROUND(AVG(daily_target_kcal), 1) AS avg_target_kcal FROM user_nutrition_intervention GROUP BY intervention_type ORDER BY intervention_count DESC"
    }
  ],
  "auto_train": true
}
```
- **预期结果**：
  1. 返回 `status: 200`，`added: {"ddl": 1, "document": 1, "sql": 2}`，`trained: true`。
  2. 立即切换到「智能问数」Tab 提问跨表问题（见下方 `T-QUERY-07`、`T-QUERY-08`），模型能够正确生成 `JOIN user_nutrition_intervention` 查询并返回数据。

---

### 用例 T-ADD-03：重复语料幂等去重测试
- **操作步骤**：将 **用例 T-ADD-02** 中完全相同的 JSON 再次提交一次。
- **预期结果**：
  1. 返回 `status: 200`，`added: {"ddl": 0, "document": 0, "sql": 0}`，`skipped_duplicates: {"ddl": 1, "document": 1, "sql": 2}`。
  2. `vanna_training_data.json` 中不会产生重复条目，也不会重复向 ChromaDB 写入相同语料。

---

### 用例 T-ADD-04：仅落盘保存至 JSON、暂不触发 Vanna 训练（`auto_train = false`）
- **操作步骤**：取消勾选「保存后立即增量训练到 Vanna」（或接口传 `"auto_train": false`），提交：
```json
{
  "sql": [
    {
      "question": "查询测评次数大于等于2次的复测患者名单",
      "sql": "SELECT DISTINCT user_id, user_name, MAX(assessment_count) AS max_count FROM user_health_risk_assessment WHERE assessment_count >= 2 GROUP BY user_id, user_name"
    }
  ],
  "auto_train": false
}
```
- **预期结果**：
  1. 返回 `status: 200`，`trained: false`，提示「训练语料已保存至 JSON 文件（未执行立即训练）」。
  2. 随后点击右上角「全量重训 JSON」按钮（调用 `POST /api/v1/text2sql/train`），可将 JSON 中全部语料一次性同步到 Vanna。

---

### 用例 T-ADD-05：空参数与非法格式拦截测试（反向用例）
- **输入 1（空对象）**：`{}` 或全空白字符串 `{"ddl": "   ", "sql": []}`
  - **预期结果**：返回 `status: 400`，提示 `请至少提供 ddl、document 或 sql 中的一项有效训练内容`。
- **输入 2（前端 JSON 模式语法错误）**：输入缺少右括号的 JSON `{ "ddl": ["CREATE TABLE..." `
  - **预期结果**：前端实时校验提示 `JSON 语法有误`，提交按钮保持禁用状态。

---

## 2. 自然语言问数（`/api/v1/text2sql/query` & 前端「智能问数」Tab）测试用例

以下问题可直接复制到「智能问数」输入框测试：

| 用例编号 | 自然语言提问（可直接复制） | 筛选参数 | 预期生成 SQL 关键特征 | 样本库预期结果 |
| --- | --- | --- | --- | --- |
| **T-QUERY-01** | `查询风险等级为高风险的患者姓名、年龄、BMI和总分，按总分从高到低排序` | 默认 (`limit=10`, 自动执行) | `WHERE risk_level = '高风险' ORDER BY total_score DESC` | 返回王淑芬(7分)、张建国(6分)、刘秀英(6分)、陈志强(5分)、赵德海(5分) |
| **T-QUERY-02** | `统计各个风险等级的测评记录数量，并按数量降序排列` | 默认 | `SELECT risk_level, COUNT(*) ... GROUP BY risk_level ORDER BY ... DESC` | 返回 高风险(5)、中风险(5)、低风险(3)、无风险(2) |
| **T-QUERY-03** | `查询用户 USER001 的历次测评时间、总分、BMI与体重变化，按测评时间升序排列` | 默认（或在 `user_id` 框填 `USER001`） | `WHERE user_id = 'USER001' ORDER BY assessment_time ASC` | 返回张建国 3 次测评记录（总分 6 → 4 → 3，BMI 17.20 → 17.65 → 18.10） |
| **T-QUERY-04** | `统计男性和女性患者的平均总分、平均年龄和平均BMI` | 默认 | `GROUP BY sex` + `AVG(total_score)`, `AVG(age)`, `AVG(bmi)` | 返回 男 / 女 两行聚合指标（数值已自动序列化为浮点数） |
| **T-QUERY-05** | `按日期统计最近7天每天的测评人数` | 默认 | `DATE(assessment_time)` + `GROUP BY` | 返回最近 7 天每日记录分布 |
| **T-QUERY-06** | `查询70岁及以上且BMI低于18.5的高龄低体重患者名单及疾病状况` | 完成 `T-ADD-01` 训练后 | `WHERE age >= 70 AND bmi < 18.5` | 返回王淑芬、张建国、刘秀英、赵德海、吴桂兰 |
| **T-QUERY-07** | `查询正在接受肠内营养干预的患者姓名、风险等级和每日目标热量` | 完成 `T-ADD-02` 训练后 | `JOIN user_nutrition_intervention` + `intervention_type = '肠内营养'` | 返回张建国(1800kcal)、王淑芬(1600kcal)、刘秀英(1750kcal) |
| **T-QUERY-08** | `统计每种营养干预方式的人数和平均目标热量` | 完成 `T-ADD-02` 训练后 | `FROM user_nutrition_intervention GROUP BY intervention_type` | 返回 肠内营养(3)、口服营养补充(1)、肠外营养(1)、饮食指导(1) |
| **T-QUERY-09** | `查询疾病严重度评分大于等于2分的患者姓名和评分依据` | **取消勾选**「生成后自动执行 SQL」(`auto_execute=false`) | 返回有效 `generated_sql`，但 `result` 为 `null`（不查询数据库） | 页面仅展示生成的 SQL 代码块，不渲染结果表格 |
| **T-QUERY-10** | 输入纯空格 `   ` | 默认 | 参数校验拦截 | 前端/后端拒绝空问题，提示输入有效问题 |

---

## 3. 接口级 `curl` 快速验证用例（后端 `8018` 或前端代理 `3000` 均可）

```bash
# 1) 健康检查（验证 MySQL 连通性、模型状态、JSON 语料条数）
curl -s http://127.0.0.1:8018/api/v1/text2sql/health | python3 -m json.tool

# 2) 查看当前 vanna_training_data.json 中的全部语料
curl -s http://127.0.0.1:8018/api/v1/text2sql/train/data | python3 -m json.tool

# 3) 增加训练（写入 JSON 并立即调用标准 vn.train 增量训练）
curl -s -X POST http://127.0.0.1:8018/api/v1/text2sql/train/add \
  -H "Content-Type: application/json" \
  -d '{
    "document": "高危营养不良预警：当 nutritional_impairment_score = 3 且 bmi < 18.0 时需24小时内启动营养会诊。",
    "sql": [
      {
        "question": "查询营养受损评分为3分且BMI低于18的重度营养受损患者",
        "sql": "SELECT user_id, user_name, age, bmi, nutritional_impairment_score, disease_condition FROM user_health_risk_assessment WHERE nutritional_impairment_score = 3 AND bmi < 18.0"
      }
    ],
    "auto_train": true
  }' | python3 -m json.tool

# 4) POST 自然语言问数
curl -s -X POST http://127.0.0.1:8018/api/v1/text2sql/query \
  -H "Content-Type: application/json" \
  -d '{
    "question": "查询营养受损评分为3分且BMI低于18的重度营养受损患者",
    "limit": 10,
    "auto_execute": true
  }' | python3 -m json.tool

# 5) GET 简化问数接口（带 user_id 过滤）
curl -sG http://127.0.0.1:8018/api/v1/text2sql/ask \
  --data-urlencode "question=查询历次测评时间和总分" \
  --data-urlencode "user_id=USER001" \
  --data-urlencode "limit=5" | python3 -m json.tool

# 6) 查看数据库表结构（默认主表 / 指定营养干预扩展表）
curl -s "http://127.0.0.1:8018/api/v1/text2sql/tables?table_name=user_health_risk_assessment" | python3 -m json.tool
curl -s "http://127.0.0.1:8018/api/v1/text2sql/tables?table_name=user_nutrition_intervention" | python3 -m json.tool

# 7) 删除最后一条新增的 SQL 语料（假设下标为 5）并测试越界保护
curl -s -X DELETE "http://127.0.0.1:8018/api/v1/text2sql/train/data?category=sql&index=999" | python3 -m json.tool

# 8) 从 JSON 文件执行全量重训
curl -s -X POST http://127.0.0.1:8018/api/v1/text2sql/train | python3 -m json.tool
```

---

## 4. 自动化回归测试套件与运行命令

仓库内置了 **Python 后端单元测试（15 项）** 与 **TypeScript 代理层单元测试（7 项）**，均使用临时沙箱文件，**不会污染** `backend/app/data/vanna_training_data.json`：

```bash
# 运行后端 FastAPI + 原版 HealthRiskVanna 兼容性回归测试（15 项）
python3 -m unittest discover -s tests -p "test_text2sql_backend.py" -v

# 运行前端 Next.js Text2SQL 代理层单元测试（7 项）
node --import tsx --test tests/text2sql-proxy.test.ts
```

### 后端自动化用例覆盖清单（`tests/test_text2sql_backend.py`）
1. `test_01_default_repository_json_corpus`：校验默认 JSON 语料结构与初始计数（`1 DDL / 1 Document / 5 SQL`）。
2. `test_02_clean_generated_sql_variants`：校验 `<think>...</think>` 思维链剥离与 ```` ```sql ```` 代码围栏清洗。
3. `test_03_serialize_sql_rows_types`：校验 `Decimal`、`datetime`、`date`、`bytes`、`None` 序列化。
4. `test_04_strict_original_health_risk_vanna_all_endpoints`：模拟**完全未改动的原版 `HealthRiskVanna`**（不含 `add_training_data` 等自定义方法），回归全部接口。
5. `test_05_incremental_train_ddl_only_and_documentation_alias`：单传 `ddl` 列表与 `documentation` 兼容字段增量训练。
6. `test_06_incremental_train_single_sql_with_top_level_question`：顶层 `question + sql` 自动组装为问答对写入 JSON 并调用 `vn.train(question=..., sql=...)`。
7. `test_07_deduplication_skips_duplicate_json_and_vanna_calls`：首尾空白归一化与重复语料幂等跳过验证。
8. `test_08_auto_train_false_persists_json_without_calling_vanna`：`auto_train=false` 仅原子落盘 JSON、不调用模型训练。
9. `test_09_add_training_validation_rejects_empty_or_blank_payload`：空请求体与全空白字符串返回 `status=400`。
10. `test_10_incremental_train_failure_preserves_json_and_returns_502`：当 Ollama 离线导致 `vn.train` 抛错时，验证 JSON 已持久化且返回 `502` + `saved_to_json=True`。
11. `test_11_delete_training_item_valid_and_out_of_bounds`：按类别和下标删除语料、越界 `400` 与非法类别 `422` 校验。
12. `test_12_natural_language_query_modes_and_edge_cases`：`auto_execute=false`、`user_id` + `limit` 截断、空问题、模型无输出、SQL 执行异常全覆盖。
13. `test_13_ask_get_endpoint_forwards_query_params`：`GET /ask` 参数转发与查询执行。
14. `test_14_tables_endpoint_sql_injection_guard_and_db_down`：表名白名单正则防 SQL 注入（`400`）与数据库断连（`500`）校验。
15. `test_15_concurrent_append_training_corpus_thread_safety`：8 线程并发写入 12 条语料的线程安全与零丢失校验。
