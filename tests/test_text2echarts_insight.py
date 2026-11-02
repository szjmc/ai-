"""Text2Echarts 后端业务逻辑测试：图表配置解析、表格 / 报告生成、图表类型校验。

前端只做展示，这些逻辑全部在后端 `app/utils/echarts_insight.py` 中实现，
因此这里用纯标准库测试，不依赖 FastAPI 是否安装。
"""

import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

try:  # 路由级测试需要 FastAPI 及后端可选依赖，缺失时跳过。
    from fastapi import FastAPI  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402
    from unittest.mock import patch  # noqa: E402

    from app.routers.text2echarts_router import Text2EchartsRouter  # noqa: E402

    _ROUTER_AVAILABLE = True
except Exception:  # pragma: no cover - 沙箱里可能没装 FastAPI
    _ROUTER_AVAILABLE = False

from app.utils.echarts_insight import (  # noqa: E402
    build_chart_payload,
    build_report,
    build_table,
    chart_title,
    extract_echarts_option,
    normalize_chart_type,
)

OPTION = {
    "title": {"text": "营养风险等级统计", "left": "center"},
    "xAxis": {"type": "category", "data": ["低风险", "高风险", "中风险"]},
    "yAxis": {"type": "value", "name": "数量"},
    "series": [{"name": "数量", "type": "bar", "data": [25, 14, 11]}],
}

# 真实工作流返回的形状：Dify 消息事件，图表配置在 answer 的 ```echarts 代码块里。
WORKFLOW_MESSAGES = [{
    "event": "message",
    "task_id": "b5374b70-b6c9-43f4-a550-aa63c419100b",
    "message_id": "0f11d9a9-1d5e-41ed-beb7-516ce97499a4",
    "conversation_id": "3de15e86-8db1-49f9-8145-a5fa3052aacf",
    "mode": "advanced-chat",
    "answer": "```echarts\n\n" + json.dumps(OPTION, ensure_ascii=False, indent=2) + "\n\n```",
    "metadata": {"usage": {"total_tokens": 2071, "latency": 6.506}, "reasoning": {}},
    "created_at": 1793607016,
}]

ROWS = [
    {"疾病类型": "肿瘤", "高风险人数": "16"},
    {"疾病类型": "冠心病", "高风险人数": "9"},
    {"疾病类型": "慢性病急性发作", "高风险人数": "33"},
    {"疾病类型": "一般慢性病", "高风险人数": "47"},
]


class ExtractOptionTests(unittest.TestCase):
    def test_reads_echarts_fenced_answer(self):
        option = extract_echarts_option(WORKFLOW_MESSAGES)
        self.assertIsNotNone(option)
        self.assertEqual(option["series"], OPTION["series"])
        self.assertEqual(option["xAxis"], OPTION["xAxis"])

    def test_other_fence_languages_and_prose(self):
        payloads = [
            "```json\n" + json.dumps(OPTION) + "\n```",
            "```\n" + json.dumps(OPTION) + "\n```",
            "这是图表：\n\n```echarts\n" + json.dumps(OPTION) + "\n```\n\n如需调整请告诉我。",
            "图表配置如下 " + json.dumps(OPTION) + " 请查收",
        ]
        for answer in payloads:
            option = extract_echarts_option([{"answer": answer}])
            self.assertIsNotNone(option, answer[:24])
            self.assertEqual(option["series"], OPTION["series"])

    def test_wrappers_and_stringified_json(self):
        self.assertIsNotNone(extract_echarts_option(
            {"outputs": {"chart": json.dumps({"series": [{"type": "pie", "data": [1]}]})}}))
        self.assertIsNotNone(extract_echarts_option(
            {"data": {"result": {"option": {"series": [{"type": "line", "data": []}]}}}}))
        nested = json.dumps({"answer": "```echarts\n" + json.dumps(OPTION) + "\n```"})
        self.assertIsNotNone(extract_echarts_option([{"answer": nested}]))

    def test_trailing_commas_and_no_javascript(self):
        lenient = '{"series":[{"type":"bar","data":[1,2],},],}'
        option = extract_echarts_option("```echarts\n" + lenient + "\n```")
        self.assertEqual(option["series"], [{"type": "bar", "data": [1, 2]}])
        self.assertIsNone(extract_echarts_option("```echarts\n{ series: [{ type: 'bar' }] }\n```"))
        self.assertIsNone(extract_echarts_option([{"answer": "抱歉，无法生成图表。"}]))
        self.assertIsNone(extract_echarts_option(None))

    def test_option_is_json_serialisable(self):
        option = extract_echarts_option({"series": [{"type": "bar", "data": [Decimal("1.5")]}]})
        self.assertEqual(option["series"][0]["data"], [1.5])
        json.dumps(option)


class TableTests(unittest.TestCase):
    def test_table_prefers_sql_rows(self):
        table = build_table(ROWS, OPTION)
        self.assertEqual(table["columns"], ["疾病类型", "高风险人数", "占比"])
        self.assertEqual(table["rows"][0], ["肿瘤", 16, "15.2%"])
        self.assertEqual(table["rows"][3], ["一般慢性病", 47, "44.8%"])
        self.assertEqual(table["value_column"], 1)
        self.assertEqual(table["share_column"], 2)
        self.assertEqual(table["row_count"], 4)
        self.assertAlmostEqual(table["total"], 105)

    def test_table_falls_back_to_option(self):
        table = build_table(None, OPTION)
        self.assertEqual(table["columns"], ["分组", "数量", "占比"])
        self.assertEqual(table["rows"][0], ["低风险", 25, "50%"])
        self.assertEqual(table["rows"][2], ["中风险", 11, "22%"])

    def test_pie_option_labels(self):
        option = {"series": [{"type": "pie", "name": "占比", "data": [
            {"name": "高风险", "value": 3}, {"name": "低风险", "value": 7}]}]}
        table = build_table(None, option)
        self.assertEqual(table["rows"], [["高风险", 3, "30%"], ["低风险", 7, "70%"]])

    def test_multi_series_option_has_no_share_column(self):
        option = {"xAxis": {"data": ["A", "B"]}, "series": [
            {"name": "高风险", "type": "bar", "data": [1, 2]},
            {"name": "中风险", "type": "bar", "data": [3, 4]},
        ]}
        table = build_table(None, option)
        self.assertEqual(table["columns"], ["分组", "高风险", "中风险"])
        self.assertEqual(table["share_column"], -1)
        self.assertEqual(table["rows"][1], ["B", 2, 4])

    def test_empty_inputs(self):
        self.assertIsNone(build_table(None, None))
        self.assertIsNone(build_table([], {}))
        self.assertIsNone(build_table([{"a": ""}], None))


class ReportTests(unittest.TestCase):
    def test_report_metrics_and_risk_insight(self):
        table = build_table(None, OPTION)
        report = build_report(OPTION, table)
        self.assertEqual([m["label"] for m in report["metrics"]], ["样本合计", "占比最高", "差距"])
        self.assertEqual(report["metrics"][0]["value"], "50")
        self.assertEqual(report["metrics"][1]["value"], "50%")
        self.assertIn("低风险", report["summary"])
        self.assertIn("50%", report["summary"])
        self.assertTrue(report["insight"].startswith("高风险合计 14 条，占 28%"))
        self.assertEqual(report["insight_tone"], "warn")

    def test_report_from_sql_rows(self):
        report = build_report(OPTION, build_table(ROWS, OPTION))
        self.assertEqual(report["metrics"][0]["value"], "105")
        self.assertEqual(report["metrics"][1]["hint"], "一般慢性病 · 47")
        self.assertIn("4 个分组", report["summary"])
        self.assertIn("44.8%", report["insight"])

    def test_report_is_informational_without_risk_labels(self):
        table = build_table(None, {"xAxis": {"data": ["A", "B"]}, "series": [{"type": "bar", "data": [9, 1]}]})
        report = build_report(None, table)
        self.assertEqual(report["insight_tone"], "info")
        self.assertIn("A 占比 90%", report["insight"])
        self.assertIsNone(build_report(None, None))

    def test_single_group(self):
        table = build_table([{"类型": "全部", "人数": "7"}], None)
        report = build_report(None, table)
        self.assertEqual(report["metrics"][2]["label"], "分组")
        self.assertIn("1 个分组", report["summary"])


class ChartTypeTests(unittest.TestCase):
    def test_only_three_types_are_supported(self):
        self.assertEqual(normalize_chart_type("柱状图"), "柱状图")
        self.assertEqual(normalize_chart_type("折线图"), "折线图")
        self.assertEqual(normalize_chart_type("饼图"), "饼图")
        self.assertEqual(normalize_chart_type(" pie "), "饼图")
        for unsupported in ["条形图", "散点图", "", None, "radar"]:
            self.assertIsNone(normalize_chart_type(unsupported))

    def test_chart_title_and_payload(self):
        self.assertEqual(chart_title(OPTION), "营养风险等级统计")
        self.assertEqual(chart_title({"title": [{"text": "组合标题"}]}), "组合标题")
        self.assertEqual(chart_title(None), "")

        payload = build_chart_payload(WORKFLOW_MESSAGES, ROWS, "各疾病类型高风险人数", "柱状图")
        self.assertEqual(payload["chart_type"], "柱状图")
        self.assertEqual(payload["title"], "营养风险等级统计")
        self.assertEqual(payload["subtitle"], "数量")
        self.assertIsNotNone(payload["echarts_option"])
        self.assertEqual(payload["table"]["row_count"], 4)
        self.assertIsNotNone(payload["report"])
        json.dumps(payload, ensure_ascii=False)

    def test_payload_falls_back_to_question(self):
        payload = build_chart_payload([{"answer": "无图表"}], None, "随便问问", "饼图")
        self.assertIsNone(payload["echarts_option"])
        self.assertIsNone(payload["table"])
        self.assertIsNone(payload["report"])
        self.assertEqual(payload["title"], "随便问问")
        self.assertEqual(payload["subtitle"], "饼图")


@unittest.skipUnless(_ROUTER_AVAILABLE, "需要 FastAPI 及后端可选依赖")
class RouterTests(unittest.TestCase):
    """/generate 合同测试：解析、表格、报告由后端产出，前端无需计算。"""

    def setUp(self):
        app = FastAPI()
        app.include_router(Text2EchartsRouter()._register_routes(), prefix="/api/v1/text2echarts")
        self.client = TestClient(app)

    def post(self, **overrides):
        body = {"question": "各疾病类型高风险人数", "echarts_type": "柱状图", "auto_execute": True, "limit": 10}
        body.update(overrides)
        return self.client.post("/api/v1/text2echarts/generate", json=body)

    def test_generate_returns_display_ready_payload(self):
        with patch("app.routers.text2echarts_router.vn.generate_sql", return_value="SELECT 1"), \
             patch("app.routers.text2echarts_router.vn.execute_sql", return_value=list(ROWS)), \
             patch("app.routers.text2echarts_router.execute_workflow", return_value=WORKFLOW_MESSAGES[0]):
            response = self.post()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["chart_type"], "柱状图")
        self.assertEqual(data["title"], "营养风险等级统计")
        self.assertEqual(data["subtitle"], "数量")
        self.assertEqual(data["echarts_option"]["series"], OPTION["series"])
        # format_json 会把数值转成字符串，后端仍要正确生成占比列。
        self.assertEqual(data["table"]["columns"], ["疾病类型", "高风险人数", "占比"])
        self.assertEqual(data["table"]["rows"][1], ["冠心病", 9, "8.6%"])
        self.assertEqual(data["report"]["metrics"][0]["value"], "105")
        self.assertTrue(data["report"]["insight"])
        # SQL、原始行、Dify 原始响应等调试信息不下发浏览器。
        for internal in ("generated_sql", "rows", "result", "debug"):
            self.assertNotIn(internal, data)
        serialised = json.dumps(data, ensure_ascii=False)
        for leaked in ("SELECT", "DIFY_API_KEY", "task_id", "message_id", "usage"):
            self.assertNotIn(leaked, serialised)

    def test_generate_rejects_unsupported_chart_type(self):
        response = self.post(echarts_type="散点图")
        self.assertEqual(response.status_code, 400)
        self.assertIn("柱状图、折线图、饼图", response.json()["detail"])

    def test_generate_reports_workflow_failure_without_internals(self):
        with patch("app.routers.text2echarts_router.vn.generate_sql", return_value="SELECT 1"), \
             patch("app.routers.text2echarts_router.vn.execute_sql", return_value=list(ROWS)), \
             patch("app.routers.text2echarts_router.execute_workflow", return_value=None):
            response = self.post()
        data = response.json()
        self.assertFalse(data["success"])
        self.assertEqual(data["error"], "分析服务暂时不可用，请稍后重试。")
        self.assertNotIn("DIFY_API_KEY", data["error"])

    def test_generate_hides_sql_errors(self):
        with patch("app.routers.text2echarts_router.vn.generate_sql", return_value="SELECT 1"), \
             patch("app.routers.text2echarts_router.vn.execute_sql",
                   side_effect=RuntimeError("Table 'test_db.user_health_risk' doesn't exist")):
            response = self.post()
        data = response.json()
        self.assertFalse(data["success"])
        self.assertEqual(data["error"], "本次分析未能完成，请调整问题后重试。")
        self.assertNotIn("test_db", json.dumps(data, ensure_ascii=False))

    def test_generate_reports_empty_result_set(self):
        with patch("app.routers.text2echarts_router.vn.generate_sql", return_value="SELECT 1"), \
             patch("app.routers.text2echarts_router.vn.execute_sql", return_value=[]), \
             patch("app.routers.text2echarts_router.execute_workflow") as workflow:
            response = self.post()
        data = response.json()
        self.assertFalse(data["success"])
        self.assertEqual(data["error"], "没有查询到符合条件的数据，请调整问题后重试。")
        workflow.assert_not_called()


if __name__ == "__main__":
    unittest.main()
