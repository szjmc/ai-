"""基于 LangGraph 主管模式（Supervisor Pattern）的健康数据分析多智能体编排。

架构：
- ``supervisor``（主管节点）：读取共享状态并按业务阶段调度各个专员节点，使用 ``Command(goto=...)`` 统一编排流转与终止。
- ``sql_agent``（SQL 专员）：负责生成并校验只读 SQL，执行数据库查询。
- ``data_agent``（数据专员）：负责将查询结果格式化为中文友好列名与结构化表格。
- ``insight_agent``（分析专员）：负责生成表格视图、核心发现与总结结论，并实时推送 ``analysis`` 事件。
- ``chart_agent``（图表专员）：负责依据用户选择的图表类型（柱状图 / 折线图 / 饼图）生成 ECharts 配置并实时推送 ``chart`` 事件。

各节点通过 LangGraph ``get_stream_writer()`` 实时写出进度与中间结果，经 FastAPI ``astream(..., stream_mode=["custom", "values"])`` 流式输出到前端 SSE。
"""

import asyncio
import logging
from typing import Any, Dict, List, Literal, Optional, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from app.utils.echarts_insight import build_table, chart_title
from app.utils.graph_workflow import (
    build_analysis_and_summary,
    build_graph_echarts_option,
    format_rows_for_display,
    is_safe_readonly_sql,
    try_workflow_chart,
)
from app.utils.string_utils import extract_sql_after_escape_mark
from app.utils.vanna_engine import clean_generated_sql, vn

logger = logging.getLogger(__name__)

MSG_NO_DATA = "没有查询到符合条件的数据，请调整问题后重试。"
MSG_UNSAFE_SQL = "生成的查询指令不符合安全只读规范，请调整问题后重试。"
MSG_GENERIC = "本次分析未能完成，请调整问题后重试。"

WorkerName = Literal["sql_agent", "data_agent", "insight_agent", "chart_agent"]


class HealthGraphState(TypedDict, total=False):
    raw_question: str
    clean_question: str
    chart_type: str
    auto_execute: bool
    sql: str
    raw_rows: List[Dict[str, Any]]
    row_count: int
    display_rows: List[Dict[str, Any]]
    table: Optional[Dict[str, Any]]
    analysis: str
    summary: str
    report: Optional[Dict[str, Any]]
    title: str
    subtitle: str
    echarts_option: Optional[Dict[str, Any]]
    completed_agents: List[str]
    supervisor_trace: List[str]
    steps: List[str]
    error: Optional[str]


def _emit_step(steps: List[str], step_num: int, message: str, agent: str) -> List[str]:
    writer = get_stream_writer()
    writer({
        "type": "step",
        "step": step_num,
        "agent": agent,
        "message": message,
    })
    return [*steps, message]


def build_supervisor_graph(vanna_client: Any = None):
    """构建并编译 LangGraph 主管模式状态图。"""
    client = vanna_client if vanna_client is not None else vn

    async def supervisor_node(
        state: HealthGraphState,
    ) -> Command[Literal["sql_agent", "data_agent", "insight_agent", "chart_agent", "__end__"]]:
        completed = list(state.get("completed_agents") or [])
        trace = list(state.get("supervisor_trace") or [])
        steps = list(state.get("steps") or [])
        chart_type = state.get("chart_type") or "柱状图"

        if state.get("error"):
            return Command(
                goto=END,
                update={"supervisor_trace": [*trace, "supervisor->end(error)"]},
            )

        if "sql_agent" not in completed:
            steps = _emit_step(steps, 0, "开始处理请求", "supervisor")
            steps = _emit_step(
                steps,
                0,
                f"主管节点：识别目标图表类型为「{chart_type}」，调度 SQL 查询专员",
                "supervisor",
            )
            return Command(
                goto="sql_agent",
                update={
                    "steps": steps,
                    "supervisor_trace": [*trace, "supervisor->sql_agent"],
                },
            )

        if "data_agent" not in completed:
            row_count = int(state.get("row_count") or 0)
            steps = _emit_step(
                steps,
                4,
                f"主管节点：已获取 {row_count} 行数据，调度数据格式化专员",
                "supervisor",
            )
            return Command(
                goto="data_agent",
                update={
                    "steps": steps,
                    "supervisor_trace": [*trace, "supervisor->data_agent"],
                },
            )

        if "insight_agent" not in completed:
            steps = _emit_step(
                steps,
                6,
                "主管节点：数据格式化就绪，调度分析结论专员",
                "supervisor",
            )
            return Command(
                goto="insight_agent",
                update={
                    "steps": steps,
                    "supervisor_trace": [*trace, "supervisor->insight_agent"],
                },
            )

        if "chart_agent" not in completed:
            steps = _emit_step(
                steps,
                8,
                f"主管节点：结论生成完成，调度图表专员生成「{chart_type}」",
                "supervisor",
            )
            return Command(
                goto="chart_agent",
                update={
                    "steps": steps,
                    "supervisor_trace": [*trace, "supervisor->chart_agent"],
                },
            )

        steps = _emit_step(steps, 11, "所有步骤完成", "supervisor")
        return Command(
            goto=END,
            update={
                "steps": steps,
                "supervisor_trace": [*trace, "supervisor->end"],
            },
        )

    async def sql_agent_node(state: HealthGraphState) -> Command[Literal["supervisor"]]:
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        clean_question = state.get("clean_question") or ""
        auto_execute = state.get("auto_execute", True)

        steps = _emit_step(steps, 1, "1. 正在生成 SQL...", "sql_agent")
        await asyncio.sleep(0)

        generated_sql = await asyncio.to_thread(client.generate_sql, clean_question)
        extracted_sql = extract_sql_after_escape_mark(generated_sql or "")
        cleaned_sql = clean_generated_sql(extracted_sql)
        logger.info("Graph(Supervisor) 生成 SQL: %s", cleaned_sql)

        if not is_safe_readonly_sql(cleaned_sql):
            logger.warning("Graph(Supervisor) 拒绝非只读 SQL: %s", cleaned_sql)
            return Command(
                goto="supervisor",
                update={
                    "steps": steps,
                    "error": MSG_UNSAFE_SQL,
                    "completed_agents": [*completed, "sql_agent"],
                },
            )

        steps = _emit_step(steps, 2, "2. SQL 生成完成", "sql_agent")
        await asyncio.sleep(0)

        steps = _emit_step(steps, 3, "3. 正在执行 SQL 查询...", "sql_agent")
        await asyncio.sleep(0)

        raw_rows: List[Dict[str, Any]] = []
        if auto_execute is not False:
            raw_rows = await asyncio.to_thread(client.execute_sql, cleaned_sql) or []

        row_count = len(raw_rows)
        logger.info("Graph(Supervisor) SQL 查询返回 %d 行", row_count)
        steps = _emit_step(steps, 4, f"4. SQL 执行完成，返回 {row_count} 行数据", "sql_agent")
        await asyncio.sleep(0)

        if row_count == 0:
            return Command(
                goto="supervisor",
                update={
                    "sql": cleaned_sql,
                    "raw_rows": [],
                    "row_count": 0,
                    "steps": steps,
                    "error": MSG_NO_DATA,
                    "completed_agents": [*completed, "sql_agent"],
                },
            )

        return Command(
            goto="supervisor",
            update={
                "sql": cleaned_sql,
                "raw_rows": raw_rows,
                "row_count": row_count,
                "steps": steps,
                "completed_agents": [*completed, "sql_agent"],
            },
        )

    async def data_agent_node(state: HealthGraphState) -> Command[Literal["supervisor"]]:
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        raw_rows = state.get("raw_rows") or []

        steps = _emit_step(steps, 5, "5. 正在格式化数据...", "data_agent")
        await asyncio.sleep(0)

        display_rows = format_rows_for_display(raw_rows)
        table = build_table(display_rows, None)

        steps = _emit_step(steps, 6, "6. 数据格式化完成", "data_agent")
        await asyncio.sleep(0)

        return Command(
            goto="supervisor",
            update={
                "display_rows": display_rows,
                "table": table,
                "steps": steps,
                "completed_agents": [*completed, "data_agent"],
            },
        )

    async def insight_agent_node(state: HealthGraphState) -> Command[Literal["supervisor"]]:
        writer = get_stream_writer()
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        display_rows = state.get("display_rows") or []
        table = state.get("table")
        clean_question = state.get("clean_question") or ""
        raw_question = state.get("raw_question") or clean_question
        chart_type = state.get("chart_type") or "柱状图"

        steps = _emit_step(steps, 7, "7. 正在生成分析结论...", "insight_agent")
        await asyncio.sleep(0)

        analysis_markdown, summary_text, report = build_analysis_and_summary(
            question=clean_question,
            rows=display_rows,
            table=table,
            chart_type=chart_type,
        )

        steps = _emit_step(steps, 8, "8. 分析结论生成完成", "insight_agent")
        writer({
            "type": "analysis",
            "agent": "insight_agent",
            "question": raw_question,
            "chart_type": chart_type,
            "table": table,
            "analysis": analysis_markdown,
            "summary": summary_text,
            "report": report,
        })
        await asyncio.sleep(0)

        return Command(
            goto="supervisor",
            update={
                "analysis": analysis_markdown,
                "summary": summary_text,
                "report": report,
                "steps": steps,
                "completed_agents": [*completed, "insight_agent"],
            },
        )

    async def chart_agent_node(state: HealthGraphState) -> Command[Literal["supervisor"]]:
        writer = get_stream_writer()
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        display_rows = state.get("display_rows") or []
        table = state.get("table")
        clean_question = state.get("clean_question") or ""
        chart_type = state.get("chart_type") or "柱状图"
        row_count = int(state.get("row_count") or len(display_rows))

        steps = _emit_step(steps, 9, "9. 正在生成 ECharts 配置...", "chart_agent")
        await asyncio.sleep(0)

        workflow_result = await asyncio.to_thread(try_workflow_chart, display_rows, chart_type)
        echarts_option = build_graph_echarts_option(
            rows=display_rows,
            table=table,
            question=clean_question,
            chart_type=chart_type,
            workflow_result=workflow_result,
        )
        title = chart_title(echarts_option) or clean_question
        subtitle = f"{chart_type} · 共 {row_count} 条记录"

        steps = _emit_step(steps, 10, "10. 图表配置生成完成", "chart_agent")
        writer({
            "type": "chart",
            "agent": "chart_agent",
            "chart_type": chart_type,
            "title": title,
            "subtitle": subtitle,
            "echarts_option": echarts_option,
        })
        await asyncio.sleep(0)

        return Command(
            goto="supervisor",
            update={
                "title": title,
                "subtitle": subtitle,
                "echarts_option": echarts_option,
                "steps": steps,
                "completed_agents": [*completed, "chart_agent"],
            },
        )

    graph = StateGraph(HealthGraphState)
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("sql_agent", sql_agent_node)
    graph.add_node("data_agent", data_agent_node)
    graph.add_node("insight_agent", insight_agent_node)
    graph.add_node("chart_agent", chart_agent_node)
    graph.add_edge(START, "supervisor")

    return graph.compile()
