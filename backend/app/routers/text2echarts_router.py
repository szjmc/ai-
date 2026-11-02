import json
import logging
from datetime import datetime
from typing import Optional, List, Dict, Any
from fastapi import status, APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.routers.base_router import BaseRouter
from app.utils.vanna_engine import vn
from app.utils.string_utils import format_json
from app.adapter.workflow_client import execute_workflow
from app.utils.string_utils import extract_sql_after_escape_mark
from app.utils.echarts_insight import build_chart_payload, normalize_chart_type
logger = logging.getLogger(__name__)

# 面向用户的提示语：内部异常细节（SQL、表名、密钥、服务地址）只写日志，不下发浏览器。
MSG_NO_DATA = "没有查询到符合条件的数据，请调整问题后重试。"
MSG_SERVICE_DOWN = "分析服务暂时不可用，请稍后重试。"
MSG_GENERIC = "本次分析未能完成，请调整问题后重试。"
MSG_BAD_TYPE = "图表类型仅支持柱状图、折线图、饼图"


class WorkflowUnavailable(RuntimeError):
    """图表工作流不可用；细节写日志，对外只给通用提示。"""


# 数据模型
class QueryRequest(BaseModel):
    question: str
    # 目前只支持柱状图 / 折线图 / 饼图（也接受 bar / line / pie）。
    echarts_type: str = Field(default="柱状图", examples=["柱状图", "折线图", "饼图"])
    user_id: Optional[str] = None
    limit: Optional[int] = 10
    auto_execute: Optional[bool] = True


class QueryResponse(BaseModel):
    """只返回用户需要看到的内容。

    生成的 SQL、原始 SQL 行、Dify 工作流原始响应等调试信息一律不下发，
    仅写入后端日志，避免把库表结构、字段名、内部服务细节暴露到浏览器。
    """

    success: bool
    question: str
    chart_type: Optional[str] = None
    # 后端解析好的 ECharts 配置，前端直接渲染，不再做任何解析或计算。
    echarts_option: Optional[Dict[str, Any]] = None
    table: Optional[Dict[str, Any]] = None
    report: Optional[Dict[str, Any]] = None
    title: Optional[str] = None
    subtitle: Optional[str] = None
    # 面向用户的可读提示，不含堆栈、SQL、密钥或服务地址。
    error: Optional[str] = None
    execution_time: float


class Text2EchartsRouter(BaseRouter):
    def __init__(self):
        logger.info("Initializing Text2EchartsRouter")
        super().__init__()
        self.router = self._register_routes()
        # 移除异步初始化代码
        self._initialized = False



    def _register_routes(self):
        self.router.post(
            "/generate",
            response_model=QueryResponse,
            status_code=status.HTTP_200_OK,
            summary="查询问题",
            description="查询健康",
            tags=["营养风险测评记录"]
        )(self.run_workflow_proxy)

        return self.router

    async def run_workflow_proxy(self, request: QueryRequest):
        """自然语言查询接口：SQL 生成与执行、图表/表格/报告整理都在后端完成。"""
        start_time = datetime.now()

        chart_type = normalize_chart_type(request.echarts_type)
        if not chart_type:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=MSG_BAD_TYPE,
            )

        try:
            logger.info(f"收到查询请求: {request.question}（{chart_type}）")
            # 生成SQL
            generated_sql = vn.generate_sql(request.question)
            logger.info(f"generated_sql: {generated_sql}")
            formatted_sql = extract_sql_after_escape_mark(generated_sql)
            logger.info(f"生成的SQL: {formatted_sql}")

            format_result = {}

            if request.auto_execute and formatted_sql:
                # 执行SQL查询
                result = vn.execute_sql(formatted_sql)
                logger.info(f"查询结果: {result},type:{type(result)}")
                format_result = format_json(result)
                logger.info(f"查询结果转换后: {format_result}")

            if not format_result:
                # 没有数据可画时不必再调用工作流，直接给出可读提示。
                logger.warning("SQL 未返回可用数据，跳过图表工作流")
                return QueryResponse(
                    success=False,
                    question=request.question,
                    chart_type=chart_type,
                    error=MSG_NO_DATA,
                    execution_time=(datetime.now() - start_time).total_seconds(),
                )

            execution_time = (datetime.now() - start_time).total_seconds()
            new_params = f"{json.dumps(format_result, ensure_ascii=False, indent=2)} {chart_type}"
            logger.info(f"生成结果：{new_params}")
            echarts_result = execute_workflow(new_params)
            # execute_workflow 在缺少 DIFY_API_KEY 或工作流失败时会返回 None / 空结果，
            # 直接包装会让前端显示“未识别到可渲染的 ECharts 配置”，这里显式报错更易排查。
            if not echarts_result:
                # 具体原因（缺 DIFY_API_KEY、Dify 应用异常等）只写日志。
                raise WorkflowUnavailable("图表工作流未返回内容，请检查 DIFY_API_KEY、DIFY_BASE_URL 与 Dify 应用状态")
            format_output = [echarts_result]
            logger.info(f"生成echarts结果：{format_output}")
            # 解析图表配置 + 生成表格 / 报告：前端只负责展示。
            payload = build_chart_payload(
                workflow_result=format_output,
                rows=format_result if isinstance(format_result, list) else None,
                question=request.question,
                chart_type=chart_type,
            )
            if payload.get("echarts_option") is None:
                logger.warning("工作流返回中未解析到 ECharts 配置：%s", format_output)

            return QueryResponse(
                success=True,
                question=request.question,
                chart_type=chart_type,
                echarts_option=payload.get("echarts_option"),
                table=payload.get("table"),
                report=payload.get("report"),
                title=payload.get("title"),
                subtitle=payload.get("subtitle"),
                execution_time=execution_time
            )

        except WorkflowUnavailable as e:
            logger.error(f"图表工作流不可用: {e}")
            return QueryResponse(
                success=False,
                question=request.question,
                chart_type=chart_type,
                error=MSG_SERVICE_DOWN,
                execution_time=(datetime.now() - start_time).total_seconds(),
            )
        except Exception as e:
            # 完整异常（可能含 SQL、表名、密钥）只进日志，不回传浏览器。
            logger.error(f"查询处理失败: {str(e)}", exc_info=True)
            return QueryResponse(
                success=False,
                question=request.question,
                chart_type=chart_type,
                error=MSG_GENERIC,
                execution_time=(datetime.now() - start_time).total_seconds()
            )
