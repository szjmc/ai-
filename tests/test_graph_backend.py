"""健康数据分析智能体后端测试：输入解析、只读 SQL 校验、表格/总结/图表生成与 SSE 流式接口。"""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.routers.graph_router import GraphRouter  # noqa: E402
from app.utils.graph_supervisor import build_supervisor_graph  # noqa: E402
from app.utils.graph_workflow import (  # noqa: E402
    build_analysis_and_summary,
    build_graph_echarts_option,
    format_rows_for_display,
    is_safe_readonly_sql,
    parse_graph_input,
)
from app.utils.echarts_insight import build_table  # noqa: E402


SAMPLE_ROWS = [
    {"user_name": "张三", "age": 72, "total_score": 5, "risk_level": "高风险"},
    {"user_name": "李四", "age": 65, "total_score": 4, "risk_level": "高风险"},
    {"user_name": "王五", "age": 54, "total_score": 3, "risk_level": "中风险"},
    {"user_name": "赵六", "age": 41, "total_score": 1, "risk_level": "低风险"},
]

AGG_ROWS = [
    {"risk_level": "高风险", "count": 14},
    {"risk_level": "中风险", "count": 11},
    {"risk_level": "低风险", "count": 25},
]


class GraphWorkflowUnitTests(unittest.TestCase):
    def test_parse_graph_input_supports_parens_and_inference(self):
        self.assertEqual(parse_graph_input("查询高风险(饼图)"), ("查询高风险", "饼图"))
        self.assertEqual(parse_graph_input("统计人数（柱状图）"), ("统计人数", "柱状图"))
        self.assertEqual(parse_graph_input("最近7天测评趋势(line)"), ("最近7天测评趋势", "折线图"))
        # 非图表类型括号必须保留在问题中
        self.assertEqual(parse_graph_input("统计高龄患者(70岁以上)人数"), ("统计高龄患者(70岁以上)人数", "柱状图"))
        # 无括号时依据语义推断
        self.assertEqual(parse_graph_input("查询高风险"), ("查询高风险", "饼图"))
        self.assertEqual(parse_graph_input("最近7天每日人数变化趋势"), ("最近7天每日人数变化趋势", "折线图"))

        with self.assertRaises(ValueError):
            parse_graph_input("   ")
        with self.assertRaises(ValueError):
            parse_graph_input("查询高风险", explicit_chart_type="散点图")

    def test_is_safe_readonly_sql(self):
        self.assertTrue(is_safe_readonly_sql("SELECT user_name, total_score FROM user_health_risk_assessment"))
        self.assertTrue(is_safe_readonly_sql("WITH t AS (SELECT 1) SELECT * FROM t"))
        self.assertFalse(is_safe_readonly_sql("DROP TABLE user_health_risk_assessment"))
        self.assertFalse(is_safe_readonly_sql("DELETE FROM user_health_risk_assessment"))
        self.assertFalse(is_safe_readonly_sql("UPDATE user_health_risk_assessment SET age = 1"))
        self.assertFalse(is_safe_readonly_sql(""))

    def test_format_table_analysis_and_echarts(self):
        display_rows = format_rows_for_display(AGG_ROWS)
        self.assertEqual(list(display_rows[0].keys()), ["风险等级", "人数"])

        table = build_table(display_rows, None)
        self.assertEqual(table["columns"], ["风险等级", "人数", "占比"])
        self.assertEqual(table["row_count"], 3)

        analysis_md, summary, report = build_analysis_and_summary("各风险等级人数", display_rows, table, "饼图")
        self.assertIn("| 风险等级 | 人数 | 占比 |", analysis_md)
        self.assertIn("**总结**", analysis_md)
        self.assertTrue(summary)
        self.assertIsNotNone(report)

        pie_opt = build_graph_echarts_option(display_rows, table, "各风险等级人数", "饼图")
        self.assertEqual(pie_opt["series"][0]["type"], "pie")
        self.assertEqual(len(pie_opt["series"][0]["data"]), 3)

        bar_opt = build_graph_echarts_option(display_rows, table, "各风险等级人数", "柱状图")
        self.assertEqual(bar_opt["series"][0]["type"], "bar")
        self.assertEqual(bar_opt["xAxis"]["data"], ["高风险", "中风险", "低风险"])

        line_opt = build_graph_echarts_option(display_rows, table, "各风险等级人数", "折线图")
        self.assertEqual(line_opt["series"][0]["type"], "line")
        self.assertTrue(line_opt["series"][0]["smooth"])

    def test_detail_rows_pie_aggregates_meaningfully(self):
        display_rows = format_rows_for_display(SAMPLE_ROWS)
        table = build_table(display_rows, None)
        pie_opt = build_graph_echarts_option(display_rows, table, "查询高风险", "饼图")
        self.assertEqual(pie_opt["series"][0]["type"], "pie")
        names = {item["name"] for item in pie_opt["series"][0]["data"]}
        self.assertEqual(names, {"高风险", "中风险", "低风险"})


def parse_sse_events(body_text: str):
    events = []
    for block in body_text.replace("\r\n", "\n").split("\n\n"):
        if not block.strip():
            continue
        evt = "message"
        data_lines = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                evt = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
        if data_lines:
            events.append((evt, "\n".join(data_lines)))
    return events


class GraphRouterTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(GraphRouter()._register_routes(), prefix="/api/v1/graph")
        self.client = TestClient(app)

    def test_post_graph_generate_streams_steps_table_summary_and_chart(self):
        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT risk_level, COUNT(*) AS count FROM user_health_risk_assessment GROUP BY risk_level"), \
             patch("app.routers.graph_router.vn.execute_sql", return_value=list(AGG_ROWS)):
            response = self.client.post(
                "/api/v1/graph/graph_generate",
                json={"question": "查询高风险(饼图)"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["content-type"])

        events = parse_sse_events(response.text)
        step_messages = [
            json.loads(data)["message"]
            for evt, data in events
            if evt == "step" and data != "[DONE]"
        ]
        self.assertEqual(step_messages[0], "开始处理请求")
        self.assertIn("1. 正在生成 SQL...", step_messages)
        self.assertIn("4. SQL 执行完成，返回 3 行数据", step_messages)
        self.assertIn("10. 图表配置生成完成", step_messages)
        self.assertEqual(step_messages[-1], "所有步骤完成")

        result_payloads = [
            json.loads(data)
            for evt, data in events
            if evt == "result"
        ]
        self.assertEqual(len(result_payloads), 1)
        result = result_payloads[0]
        self.assertTrue(result["success"])
        self.assertEqual(result["orchestrator"], "langgraph_supervisor")
        self.assertEqual(
            result["supervisor_trace"],
            [
                "supervisor->sql_agent",
                "supervisor->data_agent",
                "supervisor->insight_agent",
                "supervisor->chart_agent",
                "supervisor->end",
            ],
        )
        self.assertEqual(result["chart_type"], "饼图")
        self.assertEqual(result["table"]["columns"], ["风险等级", "人数", "占比"])
        self.assertEqual(result["echarts_option"]["series"][0]["type"], "pie")
        self.assertIn("**总结**", result["analysis"])
        self.assertTrue(result["summary"])

        # 安全检查：不能向浏览器泄漏 SQL、表名或密钥
        for forbidden in ("SELECT", "user_health_risk_assessment", "DIFY_API_KEY", "test_db"):
            self.assertNotIn(forbidden, response.text)

    def test_supervisor_graph_nodes_and_explicit_chart_type_selection(self):
        compiled = build_supervisor_graph()
        self.assertEqual(
            set(compiled.nodes.keys()),
            {"__start__", "supervisor", "sql_agent", "data_agent", "insight_agent", "chart_agent"},
        )

        health_res = self.client.get("/api/v1/graph/health")
        self.assertEqual(health_res.status_code, 200)
        health_data = health_res.json()["data"]
        self.assertEqual(health_data["orchestrator"], "langgraph_supervisor")
        self.assertEqual(health_data["supported_chart_types"], ["柱状图", "折线图", "饼图"])

        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT risk_level, COUNT(*) AS count FROM user_health_risk_assessment GROUP BY risk_level"), \
             patch("app.routers.graph_router.vn.execute_sql", return_value=list(AGG_ROWS)):
            for chosen_type, expected_series in [("柱状图", "bar"), ("折线图", "line"), ("饼图", "pie")]:
                res = self.client.post(
                    "/api/v1/graph/graph_generate",
                    json={"question": "查询风险分布", "echarts_type": chosen_type, "stream": False},
                )
                self.assertEqual(res.status_code, 200)
                body = res.json()
                self.assertTrue(body["success"])
                self.assertEqual(body["chart_type"], chosen_type)
                self.assertEqual(body["echarts_option"]["series"][0]["type"], expected_series)

    def test_get_and_non_stream_modes(self):
        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT user_name, age, total_score, risk_level FROM user_health_risk_assessment"), \
             patch("app.routers.graph_router.vn.execute_sql", return_value=list(SAMPLE_ROWS)):
            get_res = self.client.get("/api/v1/graph/graph_generate?question=查询高风险(柱状图)")
            self.assertEqual(get_res.status_code, 200)
            self.assertIn("text/event-stream", get_res.headers["content-type"])

            json_res = self.client.post(
                "/api/v1/graph/graph_generate",
                json={"question": "查询高风险(折线图)", "stream": False},
            )
            self.assertEqual(json_res.status_code, 200)
            body = json_res.json()
            self.assertTrue(body["success"])
            self.assertEqual(body["chart_type"], "折线图")
            self.assertEqual(body["echarts_option"]["series"][0]["type"], "line")
            self.assertIn("开始处理请求", body["steps"])

    def test_validation_empty_rows_and_hidden_errors(self):
        bad_res = self.client.post("/api/v1/graph/graph_generate", json={"question": "查询", "echarts_type": "散点图"})
        self.assertEqual(bad_res.status_code, 400)

        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT 1"), \
             patch("app.routers.graph_router.vn.execute_sql", return_value=[]):
            empty_res = self.client.post("/api/v1/graph/graph_generate", json={"question": "查询高风险"})
        self.assertEqual(empty_res.status_code, 200)
        events = parse_sse_events(empty_res.text)
        err_payload = json.loads([d for e, d in events if e == "error"][0])
        self.assertFalse(err_payload["success"])
        self.assertIn("没有查询到符合条件的数据", err_payload["error"])

        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT 1"), \
             patch("app.routers.graph_router.vn.execute_sql", side_effect=RuntimeError("Table 'test_db.secret_tbl' missing")):
            fail_res = self.client.post("/api/v1/graph/graph_generate", json={"question": "查询高风险"})
        self.assertNotIn("test_db", fail_res.text)
        self.assertNotIn("secret_tbl", fail_res.text)
        self.assertIn("本次分析未能完成", fail_res.text)


if __name__ == "__main__":
    unittest.main()
