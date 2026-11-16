"""健康数据分析智能体路由（/api/v1/graph/graph_generate）。

通过 SSE（text/event-stream）实时流式输出 10 步业务执行流程：
1-2. 生成 SQL -> 3-4. 执行 SQL 查询 -> 5-6. 格式化数据 -> 7-8. 生成分析结论（表格+分析+总结）-> 9-10. 生成 ECharts 图表配置。
支持 POST JSON（默认）及 GET Query 两种调用方式，并兼容 ``stream=false`` 非流式响应。
"""

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import HTTPException, Query, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app.routers.base_router import BaseRouter
from app.utils.echarts_insight import build_table, chart_title
from app.utils.graph_workflow import (
    build_analysis_and_summary,
    build_graph_echarts_option,
    format_rows_for_display,
    is_safe_readonly_sql,
    parse_graph_input,
    try_workflow_chart,
)
from app.utils.string_utils import extract_sql_after_escape_mark
from app.utils.vanna_engine import clean_generated_sql, vn

logger = logging.getLogger(__name__)

MSG_EMPTY_QUESTION = "请输入分析问题"
MSG_BAD_TYPE = "图表类型仅支持柱状图、折线图、饼图"
MSG_NO_DATA = "没有查询到符合条件的数据，请调整问题后重试。"
MSG_UNSAFE_SQL = "生成的查询指令不符合安全只读规范，请调整问题后重试。"
MSG_GENERIC = "本次分析未能完成，请调整问题后重试。"


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


def _step_frame(step: int, message: str) -> str:
    return _sse_frame("step", {"type": "step", "step": step, "message": message})


class GraphRouter(BaseRouter):
    """健康数据分析智能体路由（/api/v1/graph）。"""

    def __init__(self):
        logger.info("Initializing GraphRouter")
        super().__init__()
        self.router = self._register_routes()

    def _register_routes(self):
        self.router.post(
            "/graph_generate",
            status_code=status.HTTP_200_OK,
            summary="健康数据分析智能体（SSE流式生成表格、图表与总结）",
            description="接收自然语言问题（支持 问题(图表类型)），流式输出执行步骤并返回表格、分析总结与 ECharts 配置",
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
            logger.info("Graph 分析开始: question=%s, chart_type=%s", clean_question, chart_type)
            yield _step_frame(0, "开始处理请求")
            await asyncio.sleep(0)

            # 1-2. 生成 SQL
            yield _step_frame(1, "1. 正在生成 SQL...")
            await asyncio.sleep(0)
            generated_sql = await asyncio.to_thread(vn.generate_sql, clean_question)
            extracted_sql = extract_sql_after_escape_mark(generated_sql or "")
            cleaned_sql = clean_generated_sql(extracted_sql)
            logger.info("Graph 生成 SQL: %s", cleaned_sql)

            if not is_safe_readonly_sql(cleaned_sql):
                logger.warning("拒绝非只读 SQL: %s", cleaned_sql)
                yield _sse_frame(
                    "error",
                    {
                        "type": "error",
                        "success": False,
                        "question": raw_question,
                        "chart_type": chart_type,
                        "error": MSG_UNSAFE_SQL,
                        "execution_time": (datetime.now() - start_time).total_seconds(),
                    },
                )
                yield "data: [DONE]\n\n"
                return

            yield _step_frame(2, "2. SQL 生成完成")
            await asyncio.sleep(0)

            # 3-4. 执行 SQL 查询
            yield _step_frame(3, "3. 正在执行 SQL 查询...")
            await asyncio.sleep(0)
            raw_rows = []
            if auto_execute is not False:
                raw_rows = await asyncio.to_thread(vn.execute_sql, cleaned_sql) or []

            row_count = len(raw_rows)
            logger.info("Graph SQL 查询返回 %d 行", row_count)
            yield _step_frame(4, f"4. SQL 执行完成，返回 {row_count} 行数据")
            await asyncio.sleep(0)

            if row_count == 0:
                yield _sse_frame(
                    "error",
                    {
                        "type": "error",
                        "success": False,
                        "question": raw_question,
                        "chart_type": chart_type,
                        "error": MSG_NO_DATA,
                        "execution_time": (datetime.now() - start_time).total_seconds(),
                    },
                )
                yield "data: [DONE]\n\n"
                return

            # 5-6. 格式化数据
            yield _step_frame(5, "5. 正在格式化数据...")
            await asyncio.sleep(0)
            display_rows = format_rows_for_display(raw_rows)
            table = build_table(display_rows, None)
            yield _step_frame(6, "6. 数据格式化完成")
            await asyncio.sleep(0)

            # 7-8. 生成分析结论（表格 + 分析 + 总结）
            yield _step_frame(7, "7. 正在生成分析结论...")
            await asyncio.sleep(0)
            analysis_markdown, summary_text, report = build_analysis_and_summary(
                question=clean_question,
                rows=display_rows,
                table=table,
                chart_type=chart_type,
            )
            yield _step_frame(8, "8. 分析结论生成完成")
            yield _sse_frame(
                "analysis",
                {
                    "type": "analysis",
                    "question": raw_question,
                    "chart_type": chart_type,
                    "table": table,
                    "analysis": analysis_markdown,
                    "summary": summary_text,
                    "report": report,
                },
            )
            await asyncio.sleep(0)

            # 9-10. 生成 ECharts 配置
            yield _step_frame(9, "9. 正在生成 ECharts 配置...")
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
            yield _step_frame(10, "10. 图表配置生成完成")
            yield _sse_frame(
                "chart",
                {
                    "type": "chart",
                    "chart_type": chart_type,
                    "title": title,
                    "subtitle": subtitle,
                    "echarts_option": echarts_option,
                },
            )
            await asyncio.sleep(0)

            yield _step_frame(11, "所有步骤完成")
            elapsed = round((datetime.now() - start_time).total_seconds(), 3)
            yield _sse_frame(
                "result",
                {
                    "type": "result",
                    "success": True,
                    "question": raw_question,
                    "clean_question": clean_question,
                    "chart_type": chart_type,
                    "title": title,
                    "subtitle": subtitle,
                    "table": table,
                    "analysis": analysis_markdown,
                    "summary": summary_text,
                    "report": report,
                    "echarts_option": echarts_option,
                    "execution_time": elapsed,
                },
            )
            yield "data: [DONE]\n\n"
        except Exception as exc:
            # 内部异常（可能包含 SQL、库表名、环境连接信息）仅写服务端日志，不下发前端。
            logger.error("Graph 分析失败: %s", exc, exc_info=True)
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
