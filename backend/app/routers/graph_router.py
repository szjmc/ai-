"""健康数据分析智能体路由（/api/v1/graph）。

采用 LangGraph 主管模式（Supervisor Pattern + MemorySaver Checkpointer）驱动多智能体协作，
支持：
- ``POST/GET /api/v1/graph/graph_generate``：流式运行或触发人工干预断点（SSE / JSON）
- ``POST /api/v1/graph/interrupt``：向运行中的 ``thread_id`` 发送协同暂停中断指令
- ``POST /api/v1/graph/resume``：从检查点恢复执行（支持 ``Command(resume=...)`` 人工干预批准/批注/重查/终止，以及基于历史检查点重绘图表）
- ``GET /api/v1/graph/state/{thread_id}``：读取线程检查点快照与历史时间线（脱敏）
"""

import json
import logging
import uuid
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import HTTPException, Path, Query, status
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel

from app.routers.base_router import BaseRouter
from app.utils.echarts_insight import normalize_chart_type
from app.utils.graph_supervisor import (
    MSG_GENERIC,
    HealthGraphState,
    _apply_human_note_to_analysis,
    build_supervisor_graph,
    clear_pause,
    get_checkpoint_snapshot,
    request_pause,
)
from app.utils.graph_workflow import parse_graph_input
from app.utils.vanna_engine import vn

logger = logging.getLogger(__name__)


class GraphGenerateRequest(BaseModel):
    question: Optional[str] = None
    query: Optional[str] = None
    input: Optional[str] = None
    echarts_type: Optional[str] = None
    chart_type: Optional[str] = None
    thread_id: Optional[str] = None
    human_in_the_loop: Optional[bool] = False
    user_id: Optional[str] = None
    limit: Optional[int] = 20
    auto_execute: Optional[bool] = True
    stream: Optional[bool] = True


class GraphInterruptRequest(BaseModel):
    thread_id: str


class GraphResumeRequest(BaseModel):
    thread_id: str
    action: Optional[str] = "approve"  # approve | cancel | rerun_sql | replay
    chart_type: Optional[str] = None
    echarts_type: Optional[str] = None
    human_note: Optional[str] = None
    stream: Optional[bool] = True


def _sse_frame(event_name: str, payload: Dict[str, Any]) -> str:
    data_str = json.dumps(payload, ensure_ascii=False)
    return f"event: {event_name}\ndata: {data_str}\n\n"


class GraphRouter(BaseRouter):
    """健康数据分析智能体路由（/api/v1/graph）。"""

    def __init__(self):
        logger.info("Initializing GraphRouter (LangGraph Supervisor + Checkpointer Mode)")
        super().__init__()
        self.router = self._register_routes()

    def _register_routes(self):
        self.router.post(
            "/graph_generate",
            status_code=status.HTTP_200_OK,
            summary="健康数据分析智能体（LangGraph主管模式 SSE 流式生成）",
            tags=["健康数据分析智能体"],
        )(self.graph_generate_post)

        self.router.get(
            "/graph_generate",
            status_code=status.HTTP_200_OK,
            summary="健康数据分析智能体（GET SSE 兼容入口）",
            tags=["健康数据分析智能体"],
        )(self.graph_generate_get)

        self.router.post(
            "/interrupt",
            status_code=status.HTTP_200_OK,
            summary="中断当前运行中的 LangGraph 线程并保存检查点",
            tags=["健康数据分析智能体"],
        )(self.graph_interrupt)

        self.router.post(
            "/resume",
            status_code=status.HTTP_200_OK,
            summary="从 LangGraph 检查点或人工干预断点恢复/重绘",
            tags=["健康数据分析智能体"],
        )(self.graph_resume)

        self.router.get(
            "/state/{thread_id}",
            status_code=status.HTTP_200_OK,
            summary="查询 LangGraph 线程检查点状态与历史",
            tags=["健康数据分析智能体"],
        )(self.graph_state)

        self.router.get(
            "/health",
            status_code=status.HTTP_200_OK,
            summary="健康数据分析智能体健康检查",
            tags=["健康数据分析智能体"],
        )(self.health_check)

        return self.router

    async def health_check(self):
        return {
            "status": 200,
            "message": "ok",
            "data": {
                "service": "graph_generate",
                "orchestrator": "langgraph_supervisor",
                "features": ["checkpointing", "interrupt", "resume", "human_in_the_loop", "time_travel_replay"],
                "supported_chart_types": ["柱状图", "折线图", "饼图"],
                "vanna_ready": bool(getattr(vn, "vanna_ready", False)),
            },
        }

    async def graph_state(self, thread_id: str = Path(..., description="LangGraph 线程 ID")):
        snap = await get_checkpoint_snapshot(thread_id, vanna_client=vn)
        if not snap:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到对应的分析线程检查点")
        return {"status": 200, "message": "ok", "data": snap}

    async def graph_interrupt(self, request: GraphInterruptRequest):
        thread_id = (request.thread_id or "").strip()
        if not thread_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少 thread_id")
        request_pause(thread_id)
        snap = await get_checkpoint_snapshot(thread_id, vanna_client=vn)
        return {
            "status": 200,
            "message": "ok",
            "data": {
                "thread_id": thread_id,
                "pause_requested": True,
                "snapshot": snap,
            },
        }

    async def graph_generate_get(
        self,
        question: str = Query(..., description="分析问题，例如：查询高风险(饼图)"),
        echarts_type: Optional[str] = Query(None, description="图表类型：柱状图 / 折线图 / 饼图"),
        thread_id: Optional[str] = Query(None, description="可选 LangGraph 线程 ID"),
        human_in_the_loop: bool = Query(False, description="是否开启人工干预确认断点"),
        limit: int = Query(20, description="返回条数限制"),
        stream: bool = Query(True, description="是否开启 SSE 流式输出"),
    ):
        req = GraphGenerateRequest(
            question=question,
            echarts_type=echarts_type,
            thread_id=thread_id,
            human_in_the_loop=human_in_the_loop,
            limit=limit,
            stream=stream,
        )
        return await self.graph_generate_post(req)

    async def graph_generate_post(self, request: GraphGenerateRequest):
        raw_question = (request.question or request.query or request.input or "").strip()
        explicit_type = request.echarts_type or request.chart_type
        try:
            clean_question, chart_type = parse_graph_input(raw_question, explicit_type)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

        thread_id = (request.thread_id or "").strip() or f"graph-{uuid.uuid4().hex[:12]}"
        clear_pause(thread_id)

        compiled_graph = build_supervisor_graph(vanna_client=vn)
        initial_state: HealthGraphState = {
            "thread_id": thread_id,
            "raw_question": raw_question,
            "clean_question": clean_question,
            "chart_type": chart_type,
            "auto_execute": request.auto_execute is not False,
            "human_in_the_loop": bool(request.human_in_the_loop),
            "human_approved": False,
            "human_note": "",
            "cancelled": False,
            "completed_agents": [],
            "supervisor_trace": [],
            "steps": [],
        }
        config = {"configurable": {"thread_id": thread_id}}

        if request.stream is False:
            result = await self._collect_stream(
                compiled_graph.astream(
                    initial_state,
                    config=config,
                    stream_mode=["custom", "updates", "values"],
                ),
                thread_id=thread_id,
                raw_question=raw_question,
                clean_question=clean_question,
                chart_type=chart_type,
            )
            return JSONResponse(content=result, headers={"Cache-Control": "no-store"})

        return StreamingResponse(
            self._stream_graph_run(
                compiled_graph.astream(
                    initial_state,
                    config=config,
                    stream_mode=["custom", "updates", "values"],
                ),
                thread_id=thread_id,
                raw_question=raw_question,
                clean_question=clean_question,
                chart_type=chart_type,
            ),
            media_type="text/event-stream; charset=utf-8",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    async def graph_resume(self, request: GraphResumeRequest):
        thread_id = (request.thread_id or "").strip()
        if not thread_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少 thread_id")

        clear_pause(thread_id)
        compiled_graph = build_supervisor_graph(vanna_client=vn)
        config = {"configurable": {"thread_id": thread_id}}
        state_snap = await compiled_graph.aget_state(config)
        if not state_snap or not state_snap.values:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到可恢复的分析线程检查点")

        values = state_snap.values or {}
        raw_question = str(values.get("raw_question") or "")
        clean_question = str(values.get("clean_question") or raw_question)

        raw_requested_type = (request.chart_type or request.echarts_type or "").strip()
        if raw_requested_type:
            normalized_type = normalize_chart_type(raw_requested_type) or normalize_chart_type(raw_requested_type.lower())
            if not normalized_type:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="图表类型仅支持柱状图、折线图、饼图")
        else:
            normalized_type = str(values.get("chart_type") or "柱状图")

        action = (request.action or "approve").strip().lower()
        if action not in ("approve", "resume", "cancel", "rerun_sql", "replay"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不支持的恢复操作类型")

        human_note = (
            request.human_note.strip()
            if request.human_note is not None
            else str(values.get("human_note") or "").strip()
        )

        has_active_interrupt = any(getattr(t, "interrupts", None) for t in (state_snap.tasks or ()))

        if action == "replay" or (action in ("approve", "resume") and not state_snap.next and not has_active_interrupt):
            # Time-Travel 分支重放：直接复用已查询到的检查点数据，不重新执行 SQL，直接重绘目标图表与批注
            if not values.get("display_rows"):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="当前检查点缺少可重绘的数据")
            updated_analysis, updated_summary = _apply_human_note_to_analysis(
                str(values.get("analysis") or ""),
                str(values.get("summary") or ""),
                human_note,
            )
            replayed_agents = [
                a for a in (values.get("completed_agents") or ["sql_agent", "data_agent", "insight_agent"])
                if a != "chart_agent"
            ]
            if "insight_agent" not in replayed_agents:
                replayed_agents.append("insight_agent")
            replay_steps = [
                *(values.get("steps") or []),
                f"时间旅行恢复：基于检查点重绘「{normalized_type}」（跳过 SQL 重复查询）"
                + (f"（批注：{human_note}）" if human_note else ""),
            ]
            new_cfg = await compiled_graph.aupdate_state(
                config,
                {
                    "chart_type": normalized_type,
                    "human_note": human_note,
                    "human_approved": True,
                    "cancelled": False,
                    "interrupt_reason": None,
                    "analysis": updated_analysis,
                    "summary": updated_summary,
                    "completed_agents": replayed_agents,
                    "steps": replay_steps,
                },
                as_node="insight_agent",
            )
            stream_iter = compiled_graph.astream(
                None,
                config=new_cfg,
                stream_mode=["custom", "updates", "values"],
            )
            preface_events = [
                ("step", {"type": "step", "agent": "supervisor", "message": replay_steps[-1]}),
                ("analysis", {
                    "type": "analysis",
                    "agent": "supervisor",
                    "question": raw_question,
                    "chart_type": normalized_type,
                    "table": values.get("table"),
                    "analysis": updated_analysis,
                    "summary": updated_summary,
                    "report": values.get("report"),
                }),
            ]
        elif has_active_interrupt:
            resume_payload = {
                "action": action,
                "chart_type": normalized_type,
                "human_note": human_note,
            }
            stream_iter = compiled_graph.astream(
                Command(resume=resume_payload),
                config=config,
                stream_mode=["custom", "updates", "values"],
            )
            preface_events = []
        elif action == "rerun_sql":
            rerun_step = f"基于检查点重新查询 SQL（目标图表：{normalized_type}）"
            new_cfg = await compiled_graph.aupdate_state(
                config,
                {
                    "chart_type": normalized_type,
                    "human_note": human_note,
                    "human_approved": False,
                    "cancelled": False,
                    "interrupt_reason": None,
                    "error": None,
                    "completed_agents": [],
                    "raw_rows": [],
                    "row_count": 0,
                    "display_rows": [],
                    "table": None,
                    "analysis": "",
                    "summary": "",
                    "report": None,
                    "echarts_option": None,
                    "steps": [*(values.get("steps") or []), rerun_step],
                },
                as_node="human_review",
            )
            stream_iter = compiled_graph.astream(
                None,
                config=new_cfg,
                stream_mode=["custom", "updates", "values"],
            )
            preface_events = [("step", {"type": "step", "agent": "supervisor", "message": rerun_step})]
        else:
            # 从非中断挂起检查点恢复继续
            if action == "cancel":
                new_cfg = await compiled_graph.aupdate_state(
                    config,
                    {"cancelled": True, "interrupt_reason": None},
                    as_node="human_review",
                )
            else:
                new_cfg = await compiled_graph.aupdate_state(
                    config,
                    {"chart_type": normalized_type, "human_note": human_note, "human_approved": True, "cancelled": False},
                    as_node="human_review",
                )
            stream_iter = compiled_graph.astream(
                None,
                config=new_cfg,
                stream_mode=["custom", "updates", "values"],
            )
            preface_events = []

        if request.stream is False:
            result = await self._collect_stream(
                stream_iter,
                thread_id=thread_id,
                raw_question=raw_question,
                clean_question=clean_question,
                chart_type=normalized_type,
                preface_events=preface_events,
            )
            return JSONResponse(content=result, headers={"Cache-Control": "no-store"})

        return StreamingResponse(
            self._stream_graph_run(
                stream_iter,
                thread_id=thread_id,
                raw_question=raw_question,
                clean_question=clean_question,
                chart_type=normalized_type,
                preface_events=preface_events,
            ),
            media_type="text/event-stream; charset=utf-8",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    async def _collect_stream(
        self,
        stream_iter: AsyncGenerator[Any, None],
        thread_id: str,
        raw_question: str,
        clean_question: str,
        chart_type: str,
        preface_events: Optional[list[tuple[str, Dict[str, Any]]]] = None,
    ) -> Dict[str, Any]:
        final_payload: Dict[str, Any] = {
            "success": False,
            "thread_id": thread_id,
            "question": raw_question,
            "chart_type": chart_type,
            "error": MSG_GENERIC,
            "execution_time": 0.0,
        }
        steps: list[str] = []
        async for chunk in self._stream_graph_run(
            stream_iter,
            thread_id=thread_id,
            raw_question=raw_question,
            clean_question=clean_question,
            chart_type=chart_type,
            preface_events=preface_events,
        ):
            for line in chunk.splitlines():
                if not line.startswith("data: "):
                    continue
                payload_text = line[6:].strip()
                if not payload_text or payload_text == "[DONE]":
                    continue
                try:
                    parsed = json.loads(payload_text)
                except ValueError:
                    continue
                if parsed.get("type") == "step" and isinstance(parsed.get("message"), str):
                    steps.append(parsed["message"])
                elif parsed.get("type") in ("result", "error", "interrupt", "cancelled"):
                    final_payload = parsed
        final_payload["steps"] = steps
        return final_payload

    async def _stream_graph_run(
        self,
        stream_iter: AsyncGenerator[Any, None],
        thread_id: str,
        raw_question: str,
        clean_question: str,
        chart_type: str,
        preface_events: Optional[list[tuple[str, Dict[str, Any]]]] = None,
    ) -> AsyncGenerator[str, None]:
        start_time = datetime.now()
        try:
            yield _sse_frame("meta", {
                "type": "meta",
                "thread_id": thread_id,
                "orchestrator": "langgraph_supervisor",
            })

            for evt_name, evt_payload in preface_events or []:
                yield _sse_frame(evt_name, {**evt_payload, "thread_id": thread_id})

            final_state: Dict[str, Any] = {}
            interrupted_payload: Optional[Dict[str, Any]] = None

            async for mode, chunk in stream_iter:
                if mode == "custom" and isinstance(chunk, dict):
                    evt_type = str(chunk.get("type") or "step")
                    yield _sse_frame(evt_type, {**chunk, "thread_id": thread_id})
                elif mode == "updates" and isinstance(chunk, dict) and "__interrupt__" in chunk:
                    raw_interrupts = chunk.get("__interrupt__") or ()
                    if raw_interrupts:
                        val = getattr(raw_interrupts[0], "value", None)
                        interrupted_payload = dict(val) if isinstance(val, dict) else {"prompt": "请确认后继续"}
                elif mode == "values" and isinstance(chunk, dict):
                    final_state = chunk

            elapsed = round((datetime.now() - start_time).total_seconds(), 3)
            snapshot = await get_checkpoint_snapshot(thread_id, vanna_client=vn)

            if interrupted_payload is not None or (snapshot and snapshot.get("interrupted")):
                intr = interrupted_payload or (snapshot.get("interrupt") if snapshot else {}) or {}
                yield _sse_frame(
                    "interrupt",
                    {
                        "type": "interrupt",
                        "success": True,
                        "interrupted": True,
                        "orchestrator": "langgraph_supervisor",
                        "thread_id": thread_id,
                        "checkpoint_id": snapshot.get("checkpoint_id") if snapshot else "",
                        "reason": intr.get("reason") or "human_review",
                        "prompt": intr.get("prompt") or "请在检查点确认参数后恢复继续",
                        "chart_type": intr.get("chart_type") or final_state.get("chart_type") or chart_type,
                        "row_count": int(intr.get("row_count") or final_state.get("row_count") or 0),
                        "human_note": intr.get("human_note") or final_state.get("human_note") or "",
                        "completed_agents": list(snapshot.get("completed_agents") or []) if snapshot else [],
                        "supervisor_trace": list(final_state.get("supervisor_trace") or []),
                        "checkpoints": list(snapshot.get("history") or []) if snapshot else [],
                        "execution_time": elapsed,
                    },
                )
                yield "data: [DONE]\n\n"
                return

            if final_state.get("cancelled"):
                yield _sse_frame(
                    "cancelled",
                    {
                        "type": "cancelled",
                        "success": False,
                        "cancelled": True,
                        "orchestrator": "langgraph_supervisor",
                        "thread_id": thread_id,
                        "checkpoint_id": snapshot.get("checkpoint_id") if snapshot else "",
                        "completed_agents": list(final_state.get("completed_agents") or []),
                        "supervisor_trace": list(final_state.get("supervisor_trace") or []),
                        "checkpoints": list(snapshot.get("history") or []) if snapshot else [],
                        "message": "流程已按人工指令终止",
                        "execution_time": elapsed,
                    },
                )
                yield "data: [DONE]\n\n"
                return

            if final_state.get("error"):
                yield _sse_frame(
                    "error",
                    {
                        "type": "error",
                        "success": False,
                        "orchestrator": "langgraph_supervisor",
                        "thread_id": thread_id,
                        "question": raw_question,
                        "chart_type": final_state.get("chart_type") or chart_type,
                        "error": str(final_state["error"]),
                        "execution_time": elapsed,
                    },
                )
                yield "data: [DONE]\n\n"
                return

            resolved_chart_type = str(final_state.get("chart_type") or chart_type)
            yield _sse_frame(
                "result",
                {
                    "type": "result",
                    "success": True,
                    "orchestrator": "langgraph_supervisor",
                    "thread_id": thread_id,
                    "checkpoint_id": snapshot.get("checkpoint_id") if snapshot else "",
                    "completed_agents": list(final_state.get("completed_agents") or []),
                    "supervisor_trace": list(final_state.get("supervisor_trace") or []),
                    "checkpoints": list(snapshot.get("history") or []) if snapshot else [],
                    "human_note": final_state.get("human_note") or "",
                    "question": raw_question,
                    "clean_question": clean_question,
                    "chart_type": resolved_chart_type,
                    "title": final_state.get("title") or clean_question,
                    "subtitle": final_state.get("subtitle") or resolved_chart_type,
                    "table": final_state.get("table"),
                    "analysis": final_state.get("analysis") or "",
                    "summary": final_state.get("summary") or "",
                    "report": final_state.get("report"),
                    "echarts_option": final_state.get("echarts_option"),
                    "execution_time": elapsed,
                },
            )
            yield "data: [DONE]\n\n"
        except Exception as exc:
            logger.error("Graph(Supervisor) 分析失败: %s", exc, exc_info=True)
            yield _sse_frame(
                "error",
                {
                    "type": "error",
                    "success": False,
                    "thread_id": thread_id,
                    "question": raw_question,
                    "chart_type": chart_type,
                    "error": MSG_GENERIC,
                    "execution_time": round((datetime.now() - start_time).total_seconds(), 3),
                },
            )
            yield "data: [DONE]\n\n"
