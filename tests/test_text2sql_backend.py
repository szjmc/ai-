"""
Backend integration tests for Text2SqlRouter, HealthRiskVanna, and JSON training store.
Uses an isolated temporary JSON file via VANNA_TRAINING_FILE so repository data stays clean.
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

from app.routers.text2sql_router import Text2SqlRouter  # noqa: E402
from app.utils.vanna_engine import clean_generated_sql, vn, _serialize_rows  # noqa: E402
from app.utils.vanna_training_store import load_training_corpus  # noqa: E402


class FakeVannaRecorder:
    def __init__(self):
        self.calls = []

    def train(self, **kwargs):
        self.calls.append(kwargs)


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

    def test_clean_generated_sql_strips_think_and_fences(self):
        raw = "<think>先分析高风险患者过滤条件</think>\n```sql\nSELECT * FROM user_health_risk_assessment WHERE risk_level = '高风险';\n```"
        cleaned = clean_generated_sql(raw)
        self.assertEqual(
            cleaned,
            "SELECT * FROM user_health_risk_assessment WHERE risk_level = '高风险';",
        )

    def test_serialize_rows_handles_decimal_and_datetime(self):
        rows = [
            {
                "user_name": "张三",
                "bmi": Decimal("19.25"),
                "assessment_time": datetime(2026, 10, 30, 9, 30, 0),
            }
        ]
        serialized = _serialize_rows(rows)
        self.assertEqual(serialized[0]["bmi"], 19.25)
        self.assertEqual(serialized[0]["assessment_time"], "2026-10-30 09:30:00")

    def test_get_and_add_training_endpoint_writes_json_and_trains_vanna(self):
        # 1. Initial GET initializes default 7 items
        res_get = self.client.get("/api/v1/text2sql/train/data")
        self.assertEqual(res_get.status_code, 200)
        body_get = res_get.json()
        self.assertEqual(body_get["status"], 200)
        self.assertEqual(body_get["data"]["counts"]["total"], 7)

        # 2. POST /train/add appends ddl, document, sql to JSON AND triggers Vanna training
        recorder = FakeVannaRecorder()
        with patch.object(vn, "_ensure_vanna_ready", return_value=None), patch.object(
            vn, "train", side_effect=recorder.train, create=True
        ):
            res_add = self.client.post(
                "/api/v1/text2sql/train/add",
                json={
                    "ddl": "CREATE TABLE user_diet_log (id BIGINT PRIMARY KEY, kcal INT);",
                    "document": "user_diet_log 表记录患者每日摄入热量。",
                    "sql": [
                        {
                            "question": "查询摄入热量低于1000的记录",
                            "sql": "SELECT * FROM user_diet_log WHERE kcal < 1000",
                        }
                    ],
                    "auto_train": True,
                },
            )

        self.assertEqual(res_add.status_code, 200)
        body_add = res_add.json()
        self.assertEqual(body_add["status"], 200)
        self.assertTrue(body_add["data"]["trained"])
        self.assertEqual(body_add["data"]["added"], {"ddl": 1, "document": 1, "sql": 1})
        self.assertEqual(body_add["data"]["counts"], {"ddl": 2, "document": 2, "sql": 6, "total": 10})

        # Verify Vanna train() received ddl, documentation, and question+sql
        self.assertEqual(len(recorder.calls), 3)
        self.assertIn("ddl", recorder.calls[0])
        self.assertIn("documentation", recorder.calls[1])
        self.assertEqual(recorder.calls[2]["question"], "查询摄入热量低于1000的记录")
        self.assertEqual(recorder.calls[2]["sql"], "SELECT * FROM user_diet_log WHERE kcal < 1000")

        # Verify persisted JSON on disk has exact keys ddl, document, sql
        disk_json = json.loads(Path(self.temp_json).read_text(encoding="utf-8"))
        self.assertEqual(set(disk_json.keys()), {"ddl", "document", "sql"})
        self.assertEqual(len(disk_json["ddl"]), 2)
        self.assertEqual(len(disk_json["document"]), 2)
        self.assertEqual(len(disk_json["sql"]), 6)

        # 3. Duplicate submission is deduplicated in JSON
        with patch.object(vn, "_ensure_vanna_ready", return_value=None), patch.object(
            vn, "train", side_effect=recorder.train, create=True
        ):
            res_dup = self.client.post(
                "/api/v1/text2sql/train/add",
                json={"ddl": "CREATE TABLE user_diet_log (id BIGINT PRIMARY KEY, kcal INT);"},
            )
        self.assertEqual(res_dup.json()["data"]["added"]["ddl"], 0)
        self.assertEqual(res_dup.json()["data"]["skipped_duplicates"]["ddl"], 1)

        # 4. DELETE removes the newly added SQL item
        res_del = self.client.delete("/api/v1/text2sql/train/data?category=sql&index=5")
        self.assertEqual(res_del.status_code, 200)
        self.assertEqual(res_del.json()["data"]["counts"]["sql"], 5)

    def test_full_train_reads_all_items_from_json(self):
        recorder = FakeVannaRecorder()
        with patch.object(vn, "_ensure_vanna_ready", return_value=None), patch.object(
            vn, "train", side_effect=recorder.train, create=True
        ):
            res = self.client.post("/api/v1/text2sql/train")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], 200)
        self.assertEqual(body["data"]["trained_counts"], {"ddl": 1, "document": 1, "sql": 5})
        self.assertEqual(len(recorder.calls), 7)

    def test_query_and_tables_endpoints(self):
        with patch.object(
            vn,
            "generate_sql",
            return_value="SELECT user_name, total_score FROM user_health_risk_assessment WHERE risk_level = '高风险' LIMIT 10",
        ), patch.object(
            vn,
            "execute_sql",
            return_value=[{"user_name": "李四", "total_score": 5}],
        ):
            res_q = self.client.post(
                "/api/v1/text2sql/query",
                json={"question": "查询高风险患者", "limit": 10, "auto_execute": True},
            )
            self.assertEqual(res_q.status_code, 200)
            q_body = res_q.json()
            self.assertTrue(q_body["success"])
            self.assertIn("SELECT user_name", q_body["generated_sql"])
            self.assertEqual(q_body["result"], [{"user_name": "李四", "total_score": 5}])

        with patch.object(vn, "connect_to_mysql", return_value=True), patch.object(
            vn,
            "execute_sql",
            return_value=[
                {
                    "TABLE_NAME": "user_health_risk_assessment",
                    "COLUMN_NAME": "total_score",
                    "DATA_TYPE": "tinyint",
                    "COLUMN_COMMENT": "总分",
                }
            ],
        ) as mock_exec:
            res_t = self.client.get("/api/v1/text2sql/tables")
            self.assertEqual(res_t.status_code, 200)
            self.assertEqual(res_t.json()["data"][0]["COLUMN_NAME"], "total_score")
            # Verify parameterized tuple was passed to execute_sql
            self.assertEqual(len(mock_exec.call_args[0]), 2)


if __name__ == "__main__":
    unittest.main()
