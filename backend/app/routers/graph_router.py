"""健康数据分析智能体路由（/api/v1/graph/graph_generate）。

采用 LangGraph 主管模式（Supervisor Pattern）驱动多智能体协作，并通过 SSE（text/event-stream）
实时流式输出业务执行流程与最终表格、分析总结、ECharts 配置。
支持 POST JSON（默认）及 GET Query 两种调用方式，并兼容 ``stream=false`` 非流式响应。
"""

import json
import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import HTTPException, Query, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.routers.base_router import BaseRouter
from app.utils.graph_supervisor import (
    MSG_GENERIC,
    HealthGraphState,
    build_supervisor_graph,
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
    user_id: Optional[str] = None
    limit: Optional[int] = 20
    auto_execute: Optional[bool] = True
    stream: Optional[bool] = True


def _sse_frame(event_name: str, payload: Dict[str, Any]) -> str:
    data_str = json.dumps(payload, ensure_ascii=False)
    return f"event: {event_name}\ndata: {data_str}\n\n"


class GraphRouter(BaseRouter):
    """健康数据分析智能体路由（/api/v1/graph）。"""

    def __init__(self):
        logger.info("Initializing GraphRouter (LangGraph Supervisor Mode)")
        super().__init__()
        self.router = self._register_routes()

    def _register_routes(self):
        self.router.post(
            "/graph_generate",
            status_code=status.HTTP_200_OK,
            summary="健康数据分析智能体（LangGraph主管模式 SSE 流式生成）",
            description="接收自然语言问题与图表类型（柱状图/折线图/饼图），由 LangGraph 主管节点调度专员流式输出表格、分析总结与 ECharts 配置",
            tags=["健康数据分析智能体"],
        )(self.graph_generate_post)

        self.router.get(
            "/graph_generate",
            status_code=status.HTTP_200_OK,
            summary="健康数据分析智能体（GET SSE 兼容入口）",
            tags=["健康数据分析智能体"],
        )(self.graph_generate_get)

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
                "supported_chart_types": ["柱状图", "折线图", "饼图"],
                "vanna_ready": bool(getattr(vn, "vanna_ready", False)),
            },
        }

    async def graph_generate_get(
        self,
        question: str = Query(..., description="分析问题，例如：查询高风险(饼图)"),
        echarts_type: Optional[str] = Query(None, description="图表类型：柱状图 / 折线图 / 饼图"),
        limit: int = Query(20, description="返回条数限制"),
        stream: bool = Query(True, description="是否开启 SSE 流式输出"),
    ):
        req = GraphGenerateRequest(
            question=question,
            echarts_type=echarts_type,
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

        if request.stream is False:
            result = await self._run_full_pipeline(raw_question, clean_question, chart_type, request.auto_execute)
            return JSONResponse(content=result, headers={"Cache-Control": "no-store"})

        return StreamingResponse(
            self._stream_pipeline(raw_question, clean_question, chart_type, request.auto_execute),
            media_type="text/event-stream; charset=utf-8",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    async def _run_full_pipeline(
        self,
        raw_question: str,
        clean_question: str,
        chart_type: str,
        auto_execute: Optional[bool],
    ) -> Dict[str, Any]:
        final_payload: Dict[str, Any] = {
            "success": False,
            "question": raw_question,
            "chart_type": chart_type,
            "error": MSG_GENERIC,
            "execution_time": 0.0,
        }
        steps: list[str] = []
        async for chunk in self._stream_pipeline(raw_question, clean_question, chart_type, auto_execute):
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
                elif parsed.get("type") in ("result", "error"):
                    final_payload = parsed
        final_payload["steps"] = steps
        return final_payload

    async def _stream_pipeline(
        self,
        raw_question: str,
        clean_question: str,
        chart_type: str,
        auto_execute: Optional[bool],
    ) -> AsyncGenerator[str, None]:
        start_time = datetime.now()
        try:
            logger.info(
                "Graph(Supervisor) 分析开始: question=%s, chart_type=%s",
                clean_question,
                chart_type,
            )
            compiled_graph = build_supervisor_graph(vanna_client=vn)
            initial_state: HealthGraphState = {
                "raw_question": raw_question,
                "clean_question": clean_question,
                "chart_type": chart_type,
                "auto_execute": auto_execute is not False,
                "completed_agents": [],
                "supervisor_trace": [],
                "steps": [],
            }

            final_state: Dict[str, Any] = {}
            async for mode, chunk in compiled_graph.astream(
                initial_state,
                stream_mode=["custom", "values"],
            ):
                if mode == "custom" and isinstance(chunk, dict):
                    evt_type = str(chunk.get("type") or "step")
                    yield _sse_frame(evt_type, chunk)
                elif mode == "values" and isinstance(chunk, dict):
                    final_state = chunk

            elapsed = round((datetime.now() - start_time).total_seconds(), 3)
            if final_state.get("error"):
                yield _sse_frame(
                    "error",
                    {
                        "type": "error",
                        "success": False,
                        "orchestrator": "langgraph_supervisor",
                        "question": raw_question,
                        "chart_type": chart_type,
                        "error": str(final_state["error"]),
                        "execution_time": elapsed,
                    },
                )
                yield "data: [DONE]\n\n"
                return

            yield _sse_frame(
                "result",
                {
                    "type": "result",
                    "success": True,
                    "orchestrator": "langgraph_supervisor",
                    "supervisor_trace": final_state.get("supervisor_trace") or [],
                    "question": raw_question,
                    "clean_question": clean_question,
                    "chart_type": chart_type,
                    "title": final_state.get("title") or clean_question,
                    "subtitle": final_state.get("subtitle") or f"{chart_type}",
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
            # 内部异常（可能包含 SQL、库表名、环境连接信息）仅写服务端日志，不下发前端。
            logger.error("Graph(Supervisor) 分析失败: %s", exc, exc_info=True)
            yield _sse_frame(
                "error",
                {
                    "type": "error",
                    "success": False,
                    "question": raw_question,
                    "chart_type": chart_type,
                    "error": MSG_GENERIC,
                    "execution_time": round((datetime.now() - start_time).total_seconds(), 3),
                },
            )
            yield "data: [DONE]\n\n"
