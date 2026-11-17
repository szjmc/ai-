"""基于 LangGraph 主管模式（Supervisor Pattern）的健康数据分析多智能体编排。

兼容 langgraph 0.2.67 + langgraph-checkpoint 2.1.2：
- 使用 ``MemorySaver`` 持久化每个 ``thread_id`` 的图状态检查点，支持随时中断（``interrupt``）、断点恢复（``Command(resume=...)``）、人工干预（Human-in-the-Loop）以及基于历史检查点重绘图表（Time-Travel Replay）。
- ``supervisor``（主管节点）：读取共享状态并按阶段调度专员节点，使用 ``Command(goto=...)`` 统一编排流转、响应人工暂停信号与终止。
- ``sql_agent`` -> ``data_agent`` -> ``insight_agent`` -> (可选 ``human_review`` 人工干预节点) -> ``chart_agent``：每个专员完成后回到 ``supervisor``（静态返回边 ``add_edge(worker, "supervisor")`` 保证检查点更新与分支重放原生可用）。
"""

import asyncio
import logging
from typing import Any, Dict, List, Literal, Optional, Set, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, StreamWriter, interrupt

from app.utils.echarts_insight import build_table, chart_title, normalize_chart_type
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

# 全局内存检查点存储与协同暂停标记（仅保存非敏感的 thread_id 暂停请求）
CHECKPOINTER = MemorySaver()
PAUSE_REQUESTED_THREADS: Set[str] = set()


def request_pause(thread_id: str) -> None:
    if thread_id:
        PAUSE_REQUESTED_THREADS.add(thread_id)


def clear_pause(thread_id: str) -> None:
    if thread_id:
        PAUSE_REQUESTED_THREADS.discard(thread_id)


class HealthGraphState(TypedDict, total=False):
    thread_id: str
    raw_question: str
    clean_question: str
    chart_type: str
    auto_execute: bool
    human_in_the_loop: bool
    human_approved: bool
    human_note: str
    interrupt_reason: Optional[str]
    cancelled: bool
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


def _emit_step(
    writer: Optional[StreamWriter],
    steps: List[str],
    step_num: int,
    message: str,
    agent: str,
) -> List[str]:
    if callable(writer):
        writer({
            "type": "step",
            "step": step_num,
            "agent": agent,
            "message": message,
        })
    return [*steps, message]


def _apply_human_note_to_analysis(
    analysis_markdown: str,
    summary_text: str,
    human_note: str,
) -> tuple[str, str]:
    note = (human_note or "").strip()
    if not note:
        return analysis_markdown, summary_text

    note_tag = f"> **人工干预批注**：{note}"
    cleaned_analysis = analysis_markdown or ""
    if note_tag not in cleaned_analysis:
        cleaned_analysis = f"{cleaned_analysis}\n\n{note_tag}".strip()

    cleaned_summary = summary_text or ""
    if note not in cleaned_summary:
        cleaned_summary = f"{cleaned_summary}（人工批注：{note}）" if cleaned_summary else note

    return cleaned_analysis, cleaned_summary


def build_supervisor_graph(vanna_client: Any = None, checkpointer: Any = None):
    """构建并编译带检查点与人工干预断点的 LangGraph 主管模式状态图（兼容 0.2.67）。"""
    client = vanna_client if vanna_client is not None else vn
    saver = checkpointer if checkpointer is not None else CHECKPOINTER

    async def supervisor_node(
        state: HealthGraphState,
        writer: StreamWriter,
    ) -> Command[Literal["sql_agent", "data_agent", "insight_agent", "human_review", "chart_agent", "__end__"]]:
        completed = list(state.get("completed_agents") or [])
        trace = list(state.get("supervisor_trace") or [])
        steps = list(state.get("steps") or [])
        chart_type = state.get("chart_type") or "柱状图"
        thread_id = state.get("thread_id") or ""

        if state.get("cancelled"):
            steps = _emit_step(writer, steps, 99, "主管节点：已确认人工终止指令，流程结束", "supervisor")
            return Command(
                goto=END,
                update={
                    "steps": steps,
                    "supervisor_trace": [*trace, "supervisor->end(cancelled)"],
                },
            )

        if state.get("error"):
            return Command(
                goto=END,
                update={"supervisor_trace": [*trace, "supervisor->end(error)"]},
            )

        # 随时中断：若收到针对该 thread_id 的暂停请求，则在当前检查点挂起等待人工恢复
        if thread_id and thread_id in PAUSE_REQUESTED_THREADS:
            PAUSE_REQUESTED_THREADS.discard(thread_id)
            steps = _emit_step(
                writer,
                steps,
                len(steps),
                "主管节点：收到暂停中断指令，已保存当前检查点并等待人工恢复",
                "supervisor",
            )
            return Command(
                goto="human_review",
                update={
                    "interrupt_reason": "user_pause",
                    "steps": steps,
                    "supervisor_trace": [*trace, "supervisor->human_review(pause)"],
                },
            )

        if "sql_agent" not in completed:
            steps = _emit_step(writer, steps, 0, "开始处理请求", "supervisor")
            steps = _emit_step(
                writer,
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
                writer,
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
                writer,
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

        if state.get("human_in_the_loop") and not state.get("human_approved"):
            steps = _emit_step(
                writer,
                steps,
                8,
                "主管节点：触发 LangGraph 人工干预断点（Interrupt），等待确认图表与批注",
                "supervisor",
            )
            return Command(
                goto="human_review",
                update={
                    "interrupt_reason": "human_review",
                    "steps": steps,
                    "supervisor_trace": [*trace, "supervisor->human_review"],
                },
            )

        if "chart_agent" not in completed:
            steps = _emit_step(
                writer,
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

        steps = _emit_step(writer, steps, 11, "所有步骤完成", "supervisor")
        return Command(
            goto=END,
            update={
                "steps": steps,
                "supervisor_trace": [*trace, "supervisor->end"],
            },
        )

    async def sql_agent_node(state: HealthGraphState, writer: StreamWriter) -> Dict[str, Any]:
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        clean_question = state.get("clean_question") or ""
        auto_execute = state.get("auto_execute", True)

        steps = _emit_step(writer, steps, 1, "1. 正在生成 SQL...", "sql_agent")
        await asyncio.sleep(0)

        generated_sql = await asyncio.to_thread(client.generate_sql, clean_question)
        extracted_sql = extract_sql_after_escape_mark(generated_sql or "")
        cleaned_sql = clean_generated_sql(extracted_sql)
        logger.info("Graph(Supervisor) 生成 SQL: %s", cleaned_sql)

        if not is_safe_readonly_sql(cleaned_sql):
            logger.warning("Graph(Supervisor) 拒绝非只读 SQL: %s", cleaned_sql)
            return {
                "steps": steps,
                "error": MSG_UNSAFE_SQL,
                "completed_agents": [*completed, "sql_agent"],
            }

        steps = _emit_step(writer, steps, 2, "2. SQL 生成完成", "sql_agent")
        await asyncio.sleep(0)

        steps = _emit_step(writer, steps, 3, "3. 正在执行 SQL 查询...", "sql_agent")
        await asyncio.sleep(0)

        raw_rows: List[Dict[str, Any]] = []
        if auto_execute is not False:
            raw_rows = await asyncio.to_thread(client.execute_sql, cleaned_sql) or []

        row_count = len(raw_rows)
        logger.info("Graph(Supervisor) SQL 查询返回 %d 行", row_count)
        steps = _emit_step(writer, steps, 4, f"4. SQL 执行完成，返回 {row_count} 行数据", "sql_agent")
        await asyncio.sleep(0)

        if row_count == 0:
            return {
                "sql": cleaned_sql,
                "raw_rows": [],
                "row_count": 0,
                "steps": steps,
                "error": MSG_NO_DATA,
                "completed_agents": [*completed, "sql_agent"],
            }

        return {
            "sql": cleaned_sql,
            "raw_rows": raw_rows,
            "row_count": row_count,
            "steps": steps,
            "completed_agents": [*completed, "sql_agent"],
        }

    async def data_agent_node(state: HealthGraphState, writer: StreamWriter) -> Dict[str, Any]:
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        raw_rows = state.get("raw_rows") or []

        steps = _emit_step(writer, steps, 5, "5. 正在格式化数据...", "data_agent")
        await asyncio.sleep(0)

        display_rows = format_rows_for_display(raw_rows)
        table = build_table(display_rows, None)

        steps = _emit_step(writer, steps, 6, "6. 数据格式化完成", "data_agent")
        await asyncio.sleep(0)

        return {
            "display_rows": display_rows,
            "table": table,
            "steps": steps,
            "completed_agents": [*completed, "data_agent"],
        }

    async def insight_agent_node(state: HealthGraphState, writer: StreamWriter) -> Dict[str, Any]:
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        display_rows = state.get("display_rows") or []
        table = state.get("table")
        clean_question = state.get("clean_question") or ""
        raw_question = state.get("raw_question") or clean_question
        chart_type = state.get("chart_type") or "柱状图"
        human_note = state.get("human_note") or ""

        steps = _emit_step(writer, steps, 7, "7. 正在生成分析结论...", "insight_agent")
        await asyncio.sleep(0)

        analysis_markdown, summary_text, report = build_analysis_and_summary(
            question=clean_question,
            rows=display_rows,
            table=table,
            chart_type=chart_type,
        )
        analysis_markdown, summary_text = _apply_human_note_to_analysis(
            analysis_markdown,
            summary_text,
            human_note,
        )

        steps = _emit_step(writer, steps, 8, "8. 分析结论生成完成", "insight_agent")
        if callable(writer):
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

        return {
            "analysis": analysis_markdown,
            "summary": summary_text,
            "report": report,
            "steps": steps,
            "completed_agents": [*completed, "insight_agent"],
        }

    async def human_review_node(state: HealthGraphState, writer: StreamWriter) -> Dict[str, Any]:
        steps = list(state.get("steps") or [])
        completed = list(state.get("completed_agents") or [])
        reason = state.get("interrupt_reason") or "human_review"
        current_chart = state.get("chart_type") or "柱状图"
        current_note = state.get("human_note") or ""

        prompt = (
            "流程已在检查点暂停，可确认或调整图表类型与分析批注后恢复继续。"
            if reason == "user_pause"
            else "已生成数据表格与初步分析结论，请确认或调整图表类型与批注后继续生成图表。"
        )

        decision = interrupt({
            "reason": reason,
            "prompt": prompt,
            "thread_id": state.get("thread_id") or "",
            "chart_type": current_chart,
            "row_count": int(state.get("row_count") or 0),
            "completed_agents": completed,
            "human_note": current_note,
        })

        decision_dict = decision if isinstance(decision, dict) else {}
        action = str(decision_dict.get("action") or "approve").strip().lower()

        if action == "cancel":
            steps = _emit_step(writer, steps, 99, "人工干预：用户终止了后续流程", "human_review")
            return {
                "cancelled": True,
                "interrupt_reason": None,
                "steps": steps,
            }

        requested_chart = decision_dict.get("chart_type")
        next_chart = (
            normalize_chart_type(str(requested_chart).strip())
            if requested_chart
            else None
        ) or current_chart
        next_note = str(decision_dict.get("human_note") if "human_note" in decision_dict else current_note).strip()

        if action == "rerun_sql":
            steps = _emit_step(writer, steps, 0, f"人工干预：要求重新执行 SQL（目标图表：{next_chart}）", "human_review")
            return {
                "chart_type": next_chart,
                "human_note": next_note,
                "human_approved": False,
                "interrupt_reason": None,
                "completed_agents": [],
                "raw_rows": [],
                "row_count": 0,
                "display_rows": [],
                "table": None,
                "analysis": "",
                "summary": "",
                "report": None,
                "echarts_option": None,
                "steps": steps,
            }

        updated_analysis, updated_summary = _apply_human_note_to_analysis(
            state.get("analysis") or "",
            state.get("summary") or "",
            next_note,
        )
        msg = f"人工干预完成：确认使用「{next_chart}」继续执行"
        if next_note:
            msg += f"（批注：{next_note}）"
        steps = _emit_step(writer, steps, 8, msg, "human_review")

        if next_note and state.get("table") is not None and callable(writer):
            writer({
                "type": "analysis",
                "agent": "human_review",
                "question": state.get("raw_question") or state.get("clean_question") or "",
                "chart_type": next_chart,
                "table": state.get("table"),
                "analysis": updated_analysis,
                "summary": updated_summary,
                "report": state.get("report"),
            })

        return {
            "chart_type": next_chart,
            "human_note": next_note,
            "human_approved": True,
            "interrupt_reason": None,
            "analysis": updated_analysis,
            "summary": updated_summary,
            "steps": steps,
        }

    async def chart_agent_node(state: HealthGraphState, writer: StreamWriter) -> Dict[str, Any]:
        steps = list(state.get("steps") or [])
        completed = [a for a in (state.get("completed_agents") or []) if a != "chart_agent"]
        display_rows = state.get("display_rows") or []
        table = state.get("table")
        clean_question = state.get("clean_question") or ""
        chart_type = state.get("chart_type") or "柱状图"
        row_count = int(state.get("row_count") or len(display_rows))
        human_note = state.get("human_note") or ""

        steps = _emit_step(writer, steps, 9, "9. 正在生成 ECharts 配置...", "chart_agent")
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
        if human_note:
            subtitle = f"{subtitle} · 已含人工批注"

        steps = _emit_step(writer, steps, 10, "10. 图表配置生成完成", "chart_agent")
        if callable(writer):
            writer({
                "type": "chart",
                "agent": "chart_agent",
                "chart_type": chart_type,
                "title": title,
                "subtitle": subtitle,
                "echarts_option": echarts_option,
            })
        await asyncio.sleep(0)

        return {
            "title": title,
            "subtitle": subtitle,
            "echarts_option": echarts_option,
            "steps": steps,
            "completed_agents": [*completed, "chart_agent"],
        }

    graph = StateGraph(HealthGraphState)
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("sql_agent", sql_agent_node)
    graph.add_node("data_agent", data_agent_node)
    graph.add_node("insight_agent", insight_agent_node)
    graph.add_node("human_review", human_review_node)
    graph.add_node("chart_agent", chart_agent_node)

    graph.add_edge(START, "supervisor")
    graph.add_edge("sql_agent", "supervisor")
    graph.add_edge("data_agent", "supervisor")
    graph.add_edge("insight_agent", "supervisor")
    graph.add_edge("human_review", "supervisor")
    graph.add_edge("chart_agent", "supervisor")

    return graph.compile(checkpointer=saver)


async def get_checkpoint_snapshot(
    thread_id: str,
    vanna_client: Any = None,
    checkpointer: Any = None,
) -> Optional[Dict[str, Any]]:
    """读取 LangGraph 线程当前检查点与历史快照（脱敏处理，不返回 SQL/原始数据行）。"""
    if not thread_id:
        return None
    compiled = build_supervisor_graph(vanna_client=vanna_client, checkpointer=checkpointer)
    config = {"configurable": {"thread_id": thread_id}}
    state_snap = await compiled.aget_state(config)
    if not state_snap or not state_snap.values:
        return None

    values = state_snap.values or {}
    interrupts_info: Optional[Dict[str, Any]] = None
    for task in state_snap.tasks or ():
        if getattr(task, "interrupts", None):
            val = task.interrupts[0].value
            if isinstance(val, dict):
                interrupts_info = {
                    "reason": val.get("reason") or "human_review",
                    "prompt": val.get("prompt") or "",
                    "chart_type": val.get("chart_type") or values.get("chart_type") or "柱状图",
                    "row_count": int(val.get("row_count") or values.get("row_count") or 0),
                    "completed_agents": list(val.get("completed_agents") or values.get("completed_agents") or []),
                    "human_note": val.get("human_note") or values.get("human_note") or "",
                }
            break

    history_items: List[Dict[str, Any]] = []
    async for item in compiled.aget_state_history(config, limit=12):
        hist_vals = item.values or {}
        if not hist_vals:
            continue
        cfg_meta = item.config.get("configurable", {}) if isinstance(item.config, dict) else {}
        meta = item.metadata or {}
        history_items.append({
            "checkpoint_id": str(cfg_meta.get("checkpoint_id") or ""),
            "step": meta.get("step"),
            "next_nodes": list(item.next or ()),
            "completed_agents": list(hist_vals.get("completed_agents") or []),
            "chart_type": hist_vals.get("chart_type") or "柱状图",
        })

    curr_cfg = state_snap.config.get("configurable", {}) if isinstance(state_snap.config, dict) else {}
    return {
        "thread_id": thread_id,
        "checkpoint_id": str(curr_cfg.get("checkpoint_id") or ""),
        "next_nodes": list(state_snap.next or ()),
        "interrupted": bool(interrupts_info),
        "interrupt": interrupts_info,
        "completed_agents": list(values.get("completed_agents") or []),
        "supervisor_trace": list(values.get("supervisor_trace") or []),
        "chart_type": values.get("chart_type") or "柱状图",
        "row_count": int(values.get("row_count") or 0),
        "human_note": values.get("human_note") or "",
        "cancelled": bool(values.get("cancelled")),
        "history": history_items,
    }
