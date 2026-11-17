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
from app.utils.graph_supervisor import build_supervisor_graph, request_pause  # noqa: E402
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
        self.assertIsNotNone(compiled.checkpointer)
        self.assertEqual(
            set(compiled.nodes.keys()),
            {"__start__", "supervisor", "sql_agent", "data_agent", "insight_agent", "human_review", "chart_agent"},
        )

        health_res = self.client.get("/api/v1/graph/health")
        self.assertEqual(health_res.status_code, 200)
        health_data = health_res.json()["data"]
        self.assertEqual(health_data["orchestrator"], "langgraph_supervisor")
        self.assertIn("human_in_the_loop", health_data["features"])
        self.assertIn("time_travel_replay", health_data["features"])
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

    def test_human_in_the_loop_interrupt_resume_and_time_travel_replay(self):
        thread_id = "test-hil-thread-001"
        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT risk_level, COUNT(*) AS count FROM user_health_risk_assessment GROUP BY risk_level") as mock_gen, \
             patch("app.routers.graph_router.vn.execute_sql", return_value=list(AGG_ROWS)) as mock_exec:
            start_res = self.client.post(
                "/api/v1/graph/graph_generate",
                json={
                    "question": "查询风险分布",
                    "echarts_type": "柱状图",
                    "thread_id": thread_id,
                    "human_in_the_loop": True,
                },
            )
            self.assertEqual(start_res.status_code, 200)
            events = parse_sse_events(start_res.text)
            analysis_events = [json.loads(d) for e, d in events if e == "analysis"]
            interrupt_events = [json.loads(d) for e, d in events if e == "interrupt"]
            self.assertEqual(len(analysis_events), 1)
            self.assertEqual(len(interrupt_events), 1)
            self.assertTrue(interrupt_events[0]["interrupted"])
            self.assertEqual(interrupt_events[0]["reason"], "human_review")
            self.assertEqual(mock_exec.call_count, 1)

            state_res = self.client.get(f"/api/v1/graph/state/{thread_id}")
            self.assertEqual(state_res.status_code, 200)
            snap = state_res.json()["data"]
            self.assertTrue(snap["interrupted"])
            self.assertGreaterEqual(len(snap["history"]), 3)
            for forbidden in ("SELECT", "user_health_risk_assessment"):
                self.assertNotIn(forbidden, state_res.text)

            # 人工干预批准并修改图表类型为饼图、追加人工批注（不重查 SQL）
            resume_res = self.client.post(
                "/api/v1/graph/resume",
                json={
                    "thread_id": thread_id,
                    "action": "approve",
                    "chart_type": "饼图",
                    "human_note": "重点随访高风险人群",
                    "stream": False,
                },
            )
            self.assertEqual(resume_res.status_code, 200)
            resumed = resume_res.json()
            self.assertTrue(resumed["success"])
            self.assertEqual(resumed["chart_type"], "饼图")
            self.assertEqual(resumed["echarts_option"]["series"][0]["type"], "pie")
            self.assertIn("重点随访高风险人群", resumed["analysis"])
            self.assertIn("重点随访高风险人群", resumed["summary"])
            self.assertEqual(mock_gen.call_count, 1)
            self.assertEqual(mock_exec.call_count, 1)

            # Time-Travel：基于检查点切换为折线图重绘，同样跳过 SQL 查询
            replay_res = self.client.post(
                "/api/v1/graph/resume",
                json={
                    "thread_id": thread_id,
                    "action": "replay",
                    "chart_type": "折线图",
                    "stream": False,
                },
            )
            self.assertEqual(replay_res.status_code, 200)
            replayed = replay_res.json()
            self.assertTrue(replayed["success"])
            self.assertEqual(replayed["chart_type"], "折线图")
            self.assertEqual(replayed["echarts_option"]["series"][0]["type"], "line")
            self.assertEqual(mock_exec.call_count, 1)

    def test_anytime_pause_interrupt_cancel_and_rerun_sql(self):
        thread_id = "test-pause-thread-002"

        def execute_and_pause(_sql):
            request_pause(thread_id)
            return list(AGG_ROWS)

        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT risk_level, COUNT(*) AS count FROM user_health_risk_assessment GROUP BY risk_level"), \
             patch("app.routers.graph_router.vn.execute_sql", side_effect=execute_and_pause) as mock_exec:
            pause_res = self.client.post(
                "/api/v1/graph/graph_generate",
                json={"question": "查询风险分布(柱状图)", "thread_id": thread_id},
            )
            self.assertEqual(pause_res.status_code, 200)
            events = parse_sse_events(pause_res.text)
            interrupts = [json.loads(d) for e, d in events if e == "interrupt"]
            self.assertEqual(len(interrupts), 1)
            self.assertEqual(interrupts[0]["reason"], "user_pause")

            # 测试人工终止
            cancel_res = self.client.post(
                "/api/v1/graph/resume",
                json={"thread_id": thread_id, "action": "cancel", "stream": False},
            )
            self.assertEqual(cancel_res.status_code, 200)
            self.assertTrue(cancel_res.json()["cancelled"])

        # 测试从终止/中断检查点重查 SQL 并恢复完成
        with patch("app.routers.graph_router.vn.generate_sql", return_value="SELECT risk_level, COUNT(*) AS count FROM user_health_risk_assessment GROUP BY risk_level"), \
             patch("app.routers.graph_router.vn.execute_sql", return_value=list(AGG_ROWS)) as mock_exec2:
            rerun_res = self.client.post(
                "/api/v1/graph/resume",
                json={"thread_id": thread_id, "action": "rerun_sql", "chart_type": "饼图", "stream": False},
            )
            self.assertEqual(rerun_res.status_code, 200)
            rerun_body = rerun_res.json()
            self.assertTrue(rerun_body["success"])
            self.assertEqual(rerun_body["chart_type"], "饼图")
            self.assertEqual(mock_exec2.call_count, 1)

        intr_api = self.client.post("/api/v1/graph/interrupt", json={"thread_id": thread_id})
        self.assertEqual(intr_api.status_code, 200)
        self.assertTrue(intr_api.json()["data"]["pause_requested"])

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
