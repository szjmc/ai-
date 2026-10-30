"""
Comprehensive backend unit & integration test suite for Text2SQL and JSON incremental training.
Covers:
- Default repository JSON corpus structure & counts
- SQL output cleaning (<think>, ```sql fences) & row serialization (Decimal, datetime, date, bytes)
- Full compatibility with untouched original HealthRiskVanna (no custom methods/attributes)
- Incremental training (/train/add): DDL-only, Document/Documentation, SQL string + question, SQL pairs
- Automatic deduplication (skips duplicate JSON writes and skips redundant vn.train calls)
- auto_train=False (JSON-only save without invoking Vanna)
- Validation errors (400) and partial failure recovery (IncrementalTrainError -> 502 after JSON saved)
- Corpus deletion (DELETE /train/data) normal & out-of-bounds cases
- Natural language query (/query & /ask): auto_execute=False, user_id/limit, empty question, model/DB errors
- Table schema inspection (/tables): valid table, SQL injection rejection (400), DB offline (500)
- Thread-safe concurrent JSON writes under multi-threaded load
"""

import concurrent.futures
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app.routers.text2sql_router as router_module  # noqa: E402
from app.routers.text2sql_router import Text2SqlRouter  # noqa: E402
from app.services.vanna_training_service import (  # noqa: E402
    clean_generated_sql,
    serialize_sql_rows,
)
from app.utils.vanna_training_store import (  # noqa: E402
    append_training_corpus,
    load_training_corpus,
)


class StrictOriginalHealthRiskVanna:
    """
    Simulates the user's untouched original HealthRiskVanna(ChromaDB_VectorStore, Ollama):
    - ONLY exposes VannaBase.train / generate_sql and original connect_to_mysql / execute_sql(self, sql)
    - Deliberately DOES NOT define add_training_data, load_training_data, delete_training_data,
      vanna_ready, init_error, or 2-argument execute_sql(sql, params).
    """

    def __init__(self):
        self.train_calls = []
        self.generate_prompts = []
        self.executed_sqls = []
        self.db_online = True
        self.next_raw_sql = (
            "<think>检索表结构与风险等级过滤</think>\n"
            "```sql\n"
            "SELECT user_name, bmi, assessment_time FROM user_health_risk_assessment WHERE risk_level = '高风险' LIMIT 10\n"
            "```"
        )
        self.fail_on_train = False
        self.fail_on_execute = False

    def train(self, question=None, sql=None, ddl=None, documentation=None, plan=None):
        if self.fail_on_train:
            raise RuntimeError("Ollama embedding service unreachable (127.0.0.1:11434)")
        self.train_calls.append(
            {
                "question": question,
                "sql": sql,
                "ddl": ddl,
                "documentation": documentation,
            }
        )
        return "trained-id"

    def generate_sql(self, question: str) -> str:
        self.generate_prompts.append(question)
        return self.next_raw_sql

    def connect_to_mysql(self) -> bool:
        return self.db_online

    def execute_sql(self, sql: str):
        # Strictly 1 positional argument `sql` just like original HealthRiskVanna.execute_sql
        if self.fail_on_execute:
            raise RuntimeError("Table 'test_db.user_health_risk_assessment' doesn't exist")
        self.executed_sqls.append(sql)
        if "information_schema.COLUMNS" in sql:
            return [
                {
                    "TABLE_NAME": "user_health_risk_assessment",
                    "COLUMN_NAME": "total_score",
                    "DATA_TYPE": "tinyint",
                    "COLUMN_COMMENT": "总分",
                }
            ]
        return [
            {
                "user_name": "王芳",
                "bmi": Decimal("18.40"),
                "assessment_time": datetime(2026, 10, 30, 10, 15, 0),
            },
            {
                "user_name": "张建国",
                "bmi": Decimal("17.80"),
                "assessment_time": datetime(2026, 10, 29, 14, 0, 0),
            },
            {
                "user_name": "李秀英",
                "bmi": Decimal("21.00"),
                "assessment_time": datetime(2026, 10, 28, 9, 0, 0),
            },
        ]

    def train_health_risk_tables(self):
        pass


class Text2SqlBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="vanna_json_test_")
        self.temp_json = os.path.join(self.temp_dir, "vanna_training_data.json")
        self.prev_env = os.environ.get("VANNA_TRAINING_FILE")
        os.environ["VANNA_TRAINING_FILE"] = self.temp_json

        app = FastAPI()
        app.include_router(Text2SqlRouter()._register_routes(), prefix="/api/v1/text2sql")
        self.client = TestClient(app)

    def tearDown(self):
        if self.prev_env is None:
            os.environ.pop("VANNA_TRAINING_FILE", None)
        else:
            os.environ["VANNA_TRAINING_FILE"] = self.prev_env
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_01_default_repository_json_corpus(self):
        repo_json = BACKEND_DIR / "app" / "data" / "vanna_training_data.json"
        self.assertTrue(repo_json.exists(), "vanna_training_data.json 应存在")
        corpus = load_training_corpus(repo_json)
        self.assertEqual(corpus["counts"], {"ddl": 1, "document": 1, "sql": 5, "total": 7})
        self.assertIn("user_health_risk_assessment", corpus["ddl"][0])

    def test_02_clean_generated_sql_variants(self):
        # <think> + ```sql fence
        raw_with_think = "<think>先找风险等级字段\n再排序</think>\n```sql\nSELECT * FROM user_health_risk_assessment;\n```"
        self.assertEqual(
            clean_generated_sql(raw_with_think),
            "SELECT * FROM user_health_risk_assessment;",
        )
        # Plain ``` fence without sql tag
        raw_plain_fence = "```\nSELECT COUNT(*) FROM user_health_risk_assessment\n```"
        self.assertEqual(
            clean_generated_sql(raw_plain_fence),
            "SELECT COUNT(*) FROM user_health_risk_assessment",
        )
        # Direct SQL string
        self.assertEqual(clean_generated_sql("  SELECT 1  "), "SELECT 1")
        # None / blank / think-only
        self.assertEqual(clean_generated_sql(None), "")
        self.assertEqual(clean_generated_sql("   "), "")
        self.assertEqual(clean_generated_sql("<think>无法生成</think>"), "")

    def test_03_serialize_sql_rows_types(self):
        rows = [
            {
                "id": Decimal("42"),
                "bmi": Decimal("19.25"),
                "assessment_time": datetime(2026, 10, 30, 9, 30, 0),
                "follow_up_date": date(2026, 11, 6),
                "raw_note": "营养不良".encode("utf-8"),
                "remark": None,
            }
        ]
        serialized = serialize_sql_rows(rows)
        self.assertEqual(serialized[0]["id"], 42)
        self.assertIsInstance(serialized[0]["id"], int)
        self.assertEqual(serialized[0]["bmi"], 19.25)
        self.assertEqual(serialized[0]["assessment_time"], "2026-10-30 09:30:00")
        self.assertEqual(serialized[0]["follow_up_date"], "2026-11-06")
        self.assertEqual(serialized[0]["raw_note"], "营养不良")
        self.assertIsNone(serialized[0]["remark"])
        self.assertEqual(serialize_sql_rows(None), [])

    def test_04_strict_original_health_risk_vanna_all_endpoints(self):
        """
        Regression test for: 'HealthRiskVanna' object has no attribute 'add_training_data'
        """
        strict_vn = StrictOriginalHealthRiskVanna()
        self.assertFalse(hasattr(strict_vn, "add_training_data"))
        self.assertFalse(hasattr(strict_vn, "load_training_data"))
        self.assertFalse(hasattr(strict_vn, "vanna_ready"))

        with patch.object(router_module, "vn", strict_vn):
            res_health = self.client.get("/api/v1/text2sql/health")
            self.assertEqual(res_health.status_code, 200)
            self.assertTrue(res_health.json()["data"]["model_loaded"])
            self.assertTrue(res_health.json()["data"]["database_connected"])

            res_data = self.client.get("/api/v1/text2sql/train/data")
            self.assertEqual(res_data.status_code, 200)
            self.assertEqual(res_data.json()["data"]["counts"]["total"], 7)

            res_add = self.client.post(
                "/api/v1/text2sql/train/add",
                json={
                    "ddl": "CREATE TABLE user_diet_log (id BIGINT PRIMARY KEY, kcal INT);",
                    "document": "user_diet_log 记录患者每日摄入热量。",
                    "sql": [
                        {
                            "question": "查询热量低于1000的记录",
                            "sql": "SELECT * FROM user_diet_log WHERE kcal < 1000",
                        },
                        "SELECT AVG(kcal) FROM user_diet_log",
                    ],
                    "auto_train": True,
                },
            )
            self.assertEqual(res_add.status_code, 200)
            self.assertEqual(res_add.json()["status"], 200)
            self.assertEqual(len(strict_vn.train_calls), 4)

            strict_vn.train_calls.clear()
            res_full = self.client.post("/api/v1/text2sql/train")
            self.assertEqual(res_full.status_code, 200)
            self.assertEqual(len(strict_vn.train_calls), 11)

    def test_05_incremental_train_ddl_only_and_documentation_alias(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            # DDL only
            r1 = self.client.post(
                "/api/v1/text2sql/train/add",
                json={"ddl": ["CREATE TABLE t_a (id INT);", "CREATE TABLE t_b (id INT);"]},
            )
            self.assertEqual(r1.json()["status"], 200)
            self.assertEqual(r1.json()["data"]["added"], {"ddl": 2, "document": 0, "sql": 0})
            self.assertEqual(len(strict_vn.train_calls), 2)
            self.assertEqual(strict_vn.train_calls[0]["ddl"], "CREATE TABLE t_a (id INT);")

            # `documentation` alias compatibility
            strict_vn.train_calls.clear()
            r2 = self.client.post(
                "/api/v1/text2sql/train/add",
                json={"documentation": "BMI < 18.5 判定为消瘦/低体重状态。"},
            )
            self.assertEqual(r2.json()["status"], 200)
            self.assertEqual(r2.json()["data"]["added"], {"ddl": 0, "document": 1, "sql": 0})
            self.assertEqual(
                strict_vn.train_calls[0]["documentation"],
                "BMI < 18.5 判定为消瘦/低体重状态。",
            )

    def test_06_incremental_train_single_sql_with_top_level_question(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            res = self.client.post(
                "/api/v1/text2sql/train/add",
                json={
                    "question": "查询BMI低于18.5的低体重高风险患者",
                    "sql": "SELECT user_name, bmi, total_score FROM user_health_risk_assessment WHERE bmi < 18.5 AND risk_level = '高风险'",
                },
            )
            self.assertEqual(res.json()["status"], 200)
            self.assertEqual(len(strict_vn.train_calls), 1)
            self.assertEqual(
                strict_vn.train_calls[0]["question"],
                "查询BMI低于18.5的低体重高风险患者",
            )
            disk_json = json.loads(Path(self.temp_json).read_text(encoding="utf-8"))
            self.assertEqual(
                disk_json["sql"][-1],
                {
                    "question": "查询BMI低于18.5的低体重高风险患者",
                    "sql": "SELECT user_name, bmi, total_score FROM user_health_risk_assessment WHERE bmi < 18.5 AND risk_level = '高风险'",
                },
            )

    def test_07_deduplication_skips_duplicate_json_and_vanna_calls(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            payload = {
                "ddl": "CREATE TABLE dup_demo (id INT);",
                "document": "重复语料去重测试文档",
                "sql": "SELECT * FROM dup_demo",
                "auto_train": True,
            }
            first = self.client.post("/api/v1/text2sql/train/add", json=payload).json()
            self.assertEqual(first["data"]["added"], {"ddl": 1, "document": 1, "sql": 1})
            self.assertEqual(len(strict_vn.train_calls), 3)

            # Submit identical items with extra surrounding whitespace
            strict_vn.train_calls.clear()
            second = self.client.post(
                "/api/v1/text2sql/train/add",
                json={
                    "ddl": "  CREATE TABLE dup_demo (id INT);  \n",
                    "document": "  重复语料去重测试文档 ",
                    "sql": " SELECT * FROM dup_demo ",
                    "auto_train": True,
                },
            ).json()
            self.assertEqual(second["status"], 200)
            self.assertEqual(second["data"]["added"], {"ddl": 0, "document": 0, "sql": 0})
            self.assertEqual(
                second["data"]["skipped_duplicates"],
                {"ddl": 1, "document": 1, "sql": 1},
            )
            self.assertFalse(second["data"]["trained"])
            self.assertEqual(len(strict_vn.train_calls), 0)

    def test_08_auto_train_false_persists_json_without_calling_vanna(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            res = self.client.post(
                "/api/v1/text2sql/train/add",
                json={
                    "sql": "SELECT user_id, MAX(total_score) FROM user_health_risk_assessment GROUP BY user_id",
                    "auto_train": False,
                },
            ).json()
            self.assertEqual(res["status"], 200)
            self.assertFalse(res["data"]["trained"])
            self.assertEqual(res["data"]["added"]["sql"], 1)
            self.assertEqual(len(strict_vn.train_calls), 0)

    def test_09_add_training_validation_rejects_empty_or_blank_payload(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            res_empty = self.client.post("/api/v1/text2sql/train/add", json={}).json()
            self.assertEqual(res_empty["status"], 400)
            self.assertIn("请至少提供", res_empty["message"])

            res_blank = self.client.post(
                "/api/v1/text2sql/train/add",
                json={"ddl": "   ", "document": [""], "sql": []},
            ).json()
            self.assertEqual(res_blank["status"], 400)

    def test_10_incremental_train_failure_preserves_json_and_returns_502(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        strict_vn.fail_on_train = True
        with patch.object(router_module, "vn", strict_vn):
            res = self.client.post(
                "/api/v1/text2sql/train/add",
                json={
                    "document": "即使 Ollama 离线，此条规则也必须已写入 JSON 文件。",
                    "auto_train": True,
                },
            ).json()
            self.assertEqual(res["status"], 502)
            self.assertTrue(res["data"]["saved_to_json"])
            self.assertFalse(res["data"]["trained"])
            # Confirm disk persistence succeeded before Vanna failed
            disk_json = json.loads(Path(self.temp_json).read_text(encoding="utf-8"))
            self.assertIn("即使 Ollama 离线，此条规则也必须已写入 JSON 文件。", disk_json["document"])

    def test_11_delete_training_item_valid_and_out_of_bounds(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            # Valid delete
            ok = self.client.delete("/api/v1/text2sql/train/data?category=sql&index=0").json()
            self.assertEqual(ok["status"], 200)
            self.assertEqual(ok["data"]["counts"]["sql"], 4)

            # Out-of-bounds index -> status 400
            oob = self.client.delete("/api/v1/text2sql/train/data?category=sql&index=999").json()
            self.assertEqual(oob["status"], 400)

            # Invalid category -> FastAPI 422 validation
            bad_cat = self.client.delete("/api/v1/text2sql/train/data?category=invalid&index=0")
            self.assertEqual(bad_cat.status_code, 422)

    def test_12_natural_language_query_modes_and_edge_cases(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            # 1) Blank question
            blank = self.client.post("/api/v1/text2sql/query", json={"question": "   "}).json()
            self.assertFalse(blank["success"])
            self.assertEqual(blank["error"], "问题不能为空")

            # 2) auto_execute=False -> generates SQL only, result is None, execute_sql not called
            sql_only = self.client.post(
                "/api/v1/text2sql/query",
                json={"question": "查询高风险患者", "auto_execute": False},
            ).json()
            self.assertTrue(sql_only["success"])
            self.assertIn("SELECT", sql_only["generated_sql"])
            self.assertIsNone(sql_only["result"])
            self.assertEqual(len(strict_vn.executed_sqls), 0)

            # 3) user_id + limit prompt enrichment and row truncation (mock returns 3 rows, limit=2 slices to 2)
            filtered = self.client.post(
                "/api/v1/text2sql/query",
                json={"question": "查询历次测评记录", "user_id": "USER001", "limit": 2, "auto_execute": True},
            ).json()
            self.assertTrue(filtered["success"])
            self.assertEqual(len(filtered["result"]), 2)
            self.assertIn("USER001", strict_vn.generate_prompts[-1])
            self.assertIn("最多返回 2 条", strict_vn.generate_prompts[-1])

            # 4) Empty generated SQL
            strict_vn.next_raw_sql = "<think>无匹配表</think>"
            no_sql = self.client.post(
                "/api/v1/text2sql/query",
                json={"question": "随便问一个无关问题"},
            ).json()
            self.assertFalse(no_sql["success"])
            self.assertIn("未能生成有效的 SQL", no_sql["error"])

            # 5) SQL execution raises DB error
            strict_vn.next_raw_sql = "SELECT * FROM user_health_risk_assessment"
            strict_vn.fail_on_execute = True
            db_err = self.client.post(
                "/api/v1/text2sql/query",
                json={"question": "查询全部"},
            ).json()
            self.assertFalse(db_err["success"])
            self.assertIn("doesn't exist", db_err["error"])

    def test_13_ask_get_endpoint_forwards_query_params(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            res = self.client.get(
                "/api/v1/text2sql/ask",
                params={"question": "查询高风险记录", "limit": 1, "user_id": "USER008"},
            )
            self.assertEqual(res.status_code, 200)
            body = res.json()
            self.assertTrue(body["success"])
            self.assertEqual(len(body["result"]), 1)
            self.assertIn("USER008", strict_vn.generate_prompts[-1])

    def test_14_tables_endpoint_sql_injection_guard_and_db_down(self):
        strict_vn = StrictOriginalHealthRiskVanna()
        with patch.object(router_module, "vn", strict_vn):
            ok = self.client.get("/api/v1/text2sql/tables?table_name=user_health_risk_assessment")
            self.assertEqual(ok.status_code, 200)
            self.assertEqual(ok.json()["data"][0]["COLUMN_NAME"], "total_score")

            # SQL injection attempt rejected with 400
            inj = self.client.get("/api/v1/text2sql/tables?table_name=users';DROP TABLE users;--")
            self.assertEqual(inj.status_code, 400)

            # MySQL offline -> 500
            strict_vn.db_online = False
            offline = self.client.get("/api/v1/text2sql/tables")
            self.assertEqual(offline.status_code, 500)

    def test_15_concurrent_append_training_corpus_thread_safety(self):
        def worker(i: int):
            return append_training_corpus(
                sql=[{"question": f"并发测试问题 {i}", "sql": f"SELECT {i} FROM user_health_risk_assessment"}],
                custom_path=self.temp_json,
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(worker, range(12)))

        corpus = load_training_corpus(self.temp_json)
        # Initial 5 SQL items + 12 concurrent additions = 17 SQL items without corruption or race loss
        self.assertEqual(corpus["counts"]["sql"], 17)


if __name__ == "__main__":
    unittest.main()
