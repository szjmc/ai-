"""
Backend integration tests for Text2SqlRouter, vanna_training_service, and JSON training store.
Includes explicit regression test against a strict original HealthRiskVanna instance
that has NO custom add_training_data / load_training_data / vanna_ready attributes.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime
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
from app.utils.vanna_training_store import load_training_corpus  # noqa: E402


class StrictOriginalHealthRiskVanna:
    """
    Simulates the user's untouched original HealthRiskVanna(ChromaDB_VectorStore, Ollama):
    - ONLY exposes VannaBase.train / generate_sql and original connect_to_mysql / execute_sql(self, sql)
    - Deliberately DOES NOT define add_training_data, load_training_data, delete_training_data,
      vanna_ready, init_error, or 2-argument execute_sql(sql, params)!
    """

    def __init__(self):
        self.train_calls = []
        self.executed_sqls = []

    def train(self, question=None, sql=None, ddl=None, documentation=None, plan=None):
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
        return (
            "<think>检索表结构与风险等级过滤</think>\n"
            "```sql\n"
            "SELECT user_name, bmi, assessment_time FROM user_health_risk_assessment WHERE risk_level = '高风险' LIMIT 10\n"
            "```"
        )

    def connect_to_mysql(self) -> bool:
        return True

    def execute_sql(self, sql: str):
        # Strictly 1 argument `sql` just like original HealthRiskVanna.execute_sql!
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
            }
        ]

    def train_health_risk_tables(self):
        # Strictly 0 arguments just like original HealthRiskVanna!
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

    def test_default_repository_json_has_ddl_document_sql(self):
        repo_json = BACKEND_DIR / "app" / "data" / "vanna_training_data.json"
        self.assertTrue(repo_json.exists(), "vanna_training_data.json 应存在")
        corpus = load_training_corpus(repo_json)
        self.assertEqual(corpus["counts"]["ddl"], 1)
        self.assertEqual(corpus["counts"]["document"], 1)
        self.assertEqual(corpus["counts"]["sql"], 5)
        self.assertIn("user_health_risk_assessment", corpus["ddl"][0])

    def test_clean_generated_sql_and_serialize_rows(self):
        raw = "<think>推理过程</think>\n```sql\nSELECT * FROM user_health_risk_assessment;\n```"
        self.assertEqual(clean_generated_sql(raw), "SELECT * FROM user_health_risk_assessment;")

        serialized = serialize_sql_rows(
            [{"bmi": Decimal("19.25"), "assessment_time": datetime(2026, 10, 30, 9, 30, 0)}]
        )
        self.assertEqual(serialized[0]["bmi"], 19.25)
        self.assertEqual(serialized[0]["assessment_time"], "2026-10-30 09:30:00")

    def test_all_endpoints_work_with_strict_original_health_risk_vanna_instance(self):
        """
        Regression test for:
        'HealthRiskVanna' object has no attribute 'add_training_data'
        Verifies every route works when `vn` is the user's untouched HealthRiskVanna class.
        """
        strict_vn = StrictOriginalHealthRiskVanna()
        self.assertFalse(hasattr(strict_vn, "add_training_data"))
        self.assertFalse(hasattr(strict_vn, "load_training_data"))
        self.assertFalse(hasattr(strict_vn, "vanna_ready"))

        with patch.object(router_module, "vn", strict_vn):
            # 1. GET /health
            res_health = self.client.get("/api/v1/text2sql/health")
            self.assertEqual(res_health.status_code, 200)
            self.assertEqual(res_health.json()["status"], 200)
            self.assertTrue(res_health.json()["data"]["model_loaded"])
            self.assertTrue(res_health.json()["data"]["database_connected"])
            self.assertEqual(res_health.json()["data"]["training_counts"]["total"], 7)

            # 2. GET /train/data
            res_data = self.client.get("/api/v1/text2sql/train/data")
            self.assertEqual(res_data.status_code, 200)
            self.assertEqual(res_data.json()["data"]["counts"]["total"], 7)

            # 3. POST /train/add -> writes to JSON AND calls standard strict_vn.train(...)
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
            body_add = res_add.json()
            self.assertEqual(body_add["status"], 200, body_add)
            self.assertTrue(body_add["data"]["trained"])
            self.assertEqual(body_add["data"]["added"], {"ddl": 1, "document": 1, "sql": 2})
            self.assertEqual(body_add["data"]["counts"], {"ddl": 2, "document": 2, "sql": 7, "total": 11})

            # Verify standard Vanna train() calls (1 ddl + 1 doc + 2 sql = 4 calls)
            self.assertEqual(len(strict_vn.train_calls), 4)
            self.assertEqual(
                strict_vn.train_calls[0]["ddl"],
                "CREATE TABLE user_diet_log (id BIGINT PRIMARY KEY, kcal INT);",
            )
            self.assertEqual(
                strict_vn.train_calls[1]["documentation"],
                "user_diet_log 记录患者每日摄入热量。",
            )
            self.assertEqual(strict_vn.train_calls[2]["question"], "查询热量低于1000的记录")
            self.assertEqual(
                strict_vn.train_calls[2]["sql"],
                "SELECT * FROM user_diet_log WHERE kcal < 1000",
            )
            self.assertIsNone(strict_vn.train_calls[3]["question"])
            self.assertEqual(strict_vn.train_calls[3]["sql"], "SELECT AVG(kcal) FROM user_diet_log")

            # Verify JSON on disk
            disk_json = json.loads(Path(self.temp_json).read_text(encoding="utf-8"))
            self.assertEqual(set(disk_json.keys()), {"ddl", "document", "sql"})
            self.assertEqual(len(disk_json["sql"]), 7)

            # 4. POST /train -> full train reads all 11 items from JSON via standard strict_vn.train(...)
            strict_vn.train_calls.clear()
            res_full = self.client.post("/api/v1/text2sql/train")
            self.assertEqual(res_full.status_code, 200)
            self.assertEqual(res_full.json()["status"], 200)
            self.assertEqual(len(strict_vn.train_calls), 11)

            # 5. POST /query & GET /ask -> cleans <think> & fences, calls 1-arg execute_sql, serializes Decimal/datetime
            res_q = self.client.post(
                "/api/v1/text2sql/query",
                json={"question": "查询高风险患者", "limit": 10, "auto_execute": True},
            )
            self.assertEqual(res_q.status_code, 200)
            q_body = res_q.json()
            self.assertTrue(q_body["success"])
            self.assertFalse("<think>" in q_body["generated_sql"])
            self.assertEqual(q_body["result"][0]["user_name"], "王芳")
            self.assertEqual(q_body["result"][0]["bmi"], 18.4)
            self.assertEqual(q_body["result"][0]["assessment_time"], "2026-10-30 10:15:00")

            # 6. GET /tables -> works with 1-arg execute_sql(sql)
            res_tables = self.client.get("/api/v1/text2sql/tables")
            self.assertEqual(res_tables.status_code, 200)
            self.assertEqual(res_tables.json()["data"][0]["COLUMN_NAME"], "total_score")

            # Reject SQL injection in table_name
            res_bad_table = self.client.get("/api/v1/text2sql/tables?table_name=bad';DROP--")
            self.assertEqual(res_bad_table.status_code, 400)

            # 7. DELETE /train/data
            res_del = self.client.delete("/api/v1/text2sql/train/data?category=sql&index=6")
            self.assertEqual(res_del.status_code, 200)
            self.assertEqual(res_del.json()["data"]["counts"]["sql"], 6)


if __name__ == "__main__":
    unittest.main()
