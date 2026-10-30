# routers/text2sql_router.py
import asyncio
import functools
import logging
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from fastapi import FastAPI, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.config import settings
from app.routers.base_router import BaseRouter
from app.schemas.common import ApiResponse
from app.utils.vanna_engine import vn

logger = logging.getLogger(__name__)


# 数据模型
class QueryRequest(BaseModel):
    question: str
    user_id: Optional[str] = None
    limit: Optional[int] = 10
    auto_execute: Optional[bool] = True


class QueryResponse(BaseModel):
    success: bool
    question: str
    generated_sql: Optional[str] = None
    result: Optional[List[Dict[str, Any]]] = None
    error: Optional[str] = None
    execution_time: float


class HealthResponse(BaseModel):
    status: str
    version: str
    database_connected: bool
    model_loaded: bool


class SqlTrainingPair(BaseModel):
    question: Optional[str] = Field(None, description="可选：对应的自然语言问题")
    sql: str = Field(..., description="示例 SQL 查询语句")


class AddTrainingRequest(BaseModel):
    ddl: Optional[Union[str, List[str]]] = Field(
        None, description="新增的建表 DDL（单条字符串或字符串列表）"
    )
    document: Optional[Union[str, List[str]]] = Field(
        None, description="新增的业务文档说明（单条字符串或字符串列表）"
    )
    documentation: Optional[Union[str, List[str]]] = Field(
        None, description="兼容字段名 documentation（同 document）"
    )
    sql: Optional[Union[str, SqlTrainingPair, List[Union[str, SqlTrainingPair]]]] = Field(
        None, description="新增的示例 SQL（支持纯 SQL 字符串、字符串列表或 question+sql 列表）"
    )
    question: Optional[str] = Field(
        None, description="可选：传入单条 SQL 时配套的自然语言问题"
    )
    auto_train: bool = Field(
        True, description="写入 JSON 文件后是否立即执行 Vanna 增量训练（默认 True）"
    )


class Text2SqlRouter(BaseRouter):
    def __init__(self):
        logger.info("Initializing Text2SqlRouter")
        super().__init__()
        self._routes_registered = False
        self.router = self._register_routes()
        self._initialized = False

    async def _async_startup(self):
        """异步初始化方法"""
        logger.info("Starting Text2SqlRouter")
        self._initialized = True

    def register_startup_event(self, app: FastAPI):
        """注册启动事件"""

        @app.on_event("startup")
        async def startup_event():
            await self._async_startup()

    def _register_routes(self):
        if getattr(self, "_routes_registered", False):
            return self.router

        self.router.post(
            "/query",
            response_model=QueryResponse,
            status_code=status.HTTP_200_OK,
            summary="查询问题",
            description="自然语言生成 SQL 并查询健康风险测评记录",
            tags=["营养风险测评记录"],
        )(self.natural_language_query)

        self.router.post(
            "/train",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="训练数据（全量读取 JSON 文件）",
            description="读取 JSON 训练文件中的全部 ddl、document、sql 并同步训练至 Vanna",
            tags=["营养风险测评记录"],
        )(self.train_model)

        self.router.post(
            "/train/add",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="增加训练（写入 JSON 并增量训练）",
            description="将新增的 ddl、document、sql 写入 JSON 文件，并完成 Vanna 增量训练",
            tags=["营养风险测评记录"],
        )(self.add_training)

        self.router.get(
            "/train/data",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="获取 JSON 训练语料",
            description="读取 JSON 文件中保存的 ddl、document、sql 列表及数量统计",
            tags=["营养风险测评记录"],
        )(self.get_training_data)

        self.router.delete(
            "/train/data",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="移除单条 JSON 训练语料",
            description="按类别（ddl / document / sql）与下标移除 JSON 文件中的指定训练条目",
            tags=["营养风险测评记录"],
        )(self.delete_training_data)

        self.router.get(
            "/health",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="健康检查",
            description="检查 MySQL 连接、Vanna 模型与训练语料状态",
            tags=["营养风险测评记录"],
        )(self.health_check)

        self.router.get(
            "/ask",
            response_model=QueryResponse,
            status_code=status.HTTP_200_OK,
            summary="简化问答查询",
            description="GET 方式的自然语言问数接口",
            tags=["营养风险测评记录"],
        )(self.ask_question)

        self.router.get(
            "/tables",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="获取数据表结构",
            description="查询目标数据表字段与注释信息",
            tags=["营养风险测评记录"],
        )(self.get_table_info)

        self._routes_registered = True
        return self.router

    async def health_check(self):
        """健康检查端点"""
        try:
            db_connected = await asyncio.get_running_loop().run_in_executor(
                None, vn.connect_to_mysql
            )
            corpus = vn.load_training_data()
            return ApiResponse(
                status=200,
                message="服务运行正常",
                data={
                    "status": "healthy",
                    "version": "1.0.0",
                    "database_connected": db_connected,
                    "model_loaded": bool(vn.vanna_ready),
                    "init_error": vn.init_error,
                    "llm_model": settings.LLM_MODEL,
                    "ollama_host": settings.OLLAMA_BASE_URL,
                    "mysql_db": settings.MYSQL_DB or "test_db",
                    "training_counts": corpus["counts"],
                    "training_file": corpus["file_name"],
                },
            )
        except Exception as e:
            return ApiResponse(
                status=500,
                message=f"健康检查失败: {str(e)}",
                data={},
            )

    async def natural_language_query(self, request: QueryRequest):
        """自然语言查询接口"""
        start_time = datetime.now()
        question_text = (request.question or "").strip()
        if not question_text:
            return QueryResponse(
                success=False,
                question=request.question,
                error="问题不能为空",
                execution_time=0.0,
            )

        try:
            effective_question = question_text
            if request.user_id and request.user_id.strip():
                effective_question = f"{question_text}（限定 user_id = '{request.user_id.strip()}'）"
            if request.limit and request.limit > 0 and "limit" not in question_text.lower():
                effective_question = f"{effective_question}（最多返回 {request.limit} 条）"

            logger.info(f"收到查询请求: {effective_question}")
            loop = asyncio.get_running_loop()

            # 生成SQL
            generated_sql = await loop.run_in_executor(
                None, functools.partial(vn.generate_sql, effective_question)
            )
            logger.info(f"生成的SQL: {generated_sql}")

            if not generated_sql:
                execution_time = (datetime.now() - start_time).total_seconds()
                return QueryResponse(
                    success=False,
                    question=request.question,
                    error="模型未能生成有效的 SQL，请先确认已完成训练或补充示例 SQL",
                    execution_time=execution_time,
                )

            result = None
            if request.auto_execute and generated_sql:
                result = await loop.run_in_executor(
                    None, functools.partial(vn.execute_sql, generated_sql)
                )
                if request.limit and request.limit > 0 and isinstance(result, list):
                    result = result[: request.limit]
                logger.info(f"查询结果记录数: {len(result) if result else 0}")

            execution_time = (datetime.now() - start_time).total_seconds()

            return QueryResponse(
                success=True,
                question=request.question,
                generated_sql=generated_sql,
                result=result,
                execution_time=execution_time,
            )

        except Exception as e:
            logger.error(f"查询处理失败: {str(e)}")
            execution_time = (datetime.now() - start_time).total_seconds()

            return QueryResponse(
                success=False,
                question=request.question,
                error=str(e),
                execution_time=execution_time,
            )

    async def ask_question(
        self,
        question: str = Query(..., description="自然语言问题"),
        limit: int = Query(10, description="结果限制条数"),
        user_id: Optional[str] = Query(None, description="用户ID过滤"),
    ):
        """GET方式的简化查询接口"""
        request = QueryRequest(
            question=question,
            user_id=user_id,
            limit=limit,
            auto_execute=True,
        )
        return await self.natural_language_query(request)

    async def train_model(self):
        """手动触发全量模型训练（读取 JSON 文件中的 ddl、document、sql）"""
        try:
            loop = asyncio.get_running_loop()
            summary = await loop.run_in_executor(
                None, functools.partial(vn.train_health_risk_tables, True)
            )
            return ApiResponse(
                status=200,
                message="模型全量训练完成（已从 JSON 文件加载全部语料）",
                data=summary or {},
            )
        except Exception as e:
            logger.error(f"全量训练失败: {str(e)}")
            raise HTTPException(status_code=500, detail=f"训练失败: {str(e)}")

    async def get_training_data(self):
        """读取 JSON 文件中的 ddl、document、sql 训练语料"""
        try:
            data = vn.load_training_data()
            return ApiResponse(
                status=200,
                message="获取训练语料成功",
                data={
                    "ddl": data["ddl"],
                    "document": data["document"],
                    "sql": data["sql"],
                    "counts": data["counts"],
                    "file_name": data["file_name"],
                    "updated_at": data["updated_at"],
                },
            )
        except Exception as e:
            logger.error(f"读取训练语料失败: {str(e)}")
            return ApiResponse(status=500, message=f"读取训练语料失败: {str(e)}", data=None)

    async def add_training(self, request: AddTrainingRequest):
        """
        新增训练接口：将 ddl、document、sql 写入 JSON 文件，并触发 Vanna 增加训练
        """
        doc_payload = request.document if request.document is not None else request.documentation
        loop = asyncio.get_running_loop()

        try:
            result = await loop.run_in_executor(
                None,
                functools.partial(
                    vn.add_training_data,
                    ddl=request.ddl,
                    document=doc_payload,
                    sql=request.sql,
                    question=request.question,
                    auto_train=request.auto_train,
                ),
            )
            public_data = {
                "added": result["added"],
                "skipped_duplicates": result["skipped_duplicates"],
                "trained": result["trained"],
                "trained_counts": result["trained_counts"],
                "counts": result["counts"],
                "file_name": result["file_name"],
                "updated_at": result["updated_at"],
                "ddl": result["ddl"],
                "document": result["document"],
                "sql": result["sql"],
            }
            msg = (
                "新增训练完成：语料已写入 JSON 文件并同步至 Vanna 模型"
                if result["trained"]
                else "训练语料已保存至 JSON 文件（未执行立即训练）"
            )
            return ApiResponse(status=200, message=msg, data=public_data)
        except ValueError as ve:
            return ApiResponse(status=400, message=str(ve), data=None)
        except Exception as e:
            logger.error(f"增加训练失败: {str(e)}", exc_info=True)
            # 若 JSON 文件已成功落盘而 Vanna 向量入库失败，同时返回最新语料快照以便前端提示
            try:
                latest = vn.load_training_data()
                fallback_data = {
                    "saved_to_json": True,
                    "trained": False,
                    "counts": latest["counts"],
                    "file_name": latest["file_name"],
                    "updated_at": latest["updated_at"],
                }
            except Exception:
                fallback_data = None
            return ApiResponse(
                status=502,
                message=f"语料已保存至 JSON 文件，但 Vanna 增量训练失败: {str(e)}",
                data=fallback_data,
            )

    async def delete_training_data(
        self,
        category: Literal["ddl", "document", "sql"] = Query(
            ..., description="训练语料类别：ddl | document | sql"
        ),
        index: int = Query(..., ge=0, description="要删除的条目下标（从 0 开始）"),
    ):
        """按类别和下标从 JSON 文件删除指定训练条目"""
        try:
            result = vn.delete_training_data(category=category, index=index)
            return ApiResponse(
                status=200,
                message="已从 JSON 训练文件中移除该条目",
                data={
                    "removed": result["removed"],
                    "counts": result["counts"],
                    "file_name": result["file_name"],
                    "updated_at": result["updated_at"],
                    "ddl": result["ddl"],
                    "document": result["document"],
                    "sql": result["sql"],
                },
            )
        except (ValueError, IndexError) as err:
            return ApiResponse(status=400, message=str(err), data=None)
        except Exception as e:
            logger.error(f"删除训练语料失败: {str(e)}")
            return ApiResponse(status=500, message=f"删除训练语料失败: {str(e)}", data=None)

    async def get_table_info(
        self,
        table_name: str = Query(
            "user_health_risk_assessment", description="目标表名（默认 user_health_risk_assessment）"
        ),
    ):
        """获取表结构信息"""
        try:
            loop = asyncio.get_running_loop()
            connected = await loop.run_in_executor(None, vn.connect_to_mysql)
            if not connected:
                raise HTTPException(status_code=500, detail="数据库连接失败")

            sql = """
            SELECT 
                TABLE_NAME,
                COLUMN_NAME,
                DATA_TYPE,
                COLUMN_COMMENT
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
            ORDER BY ORDINAL_POSITION
            """

            db_name = settings.MYSQL_DB or "test_db"
            result = await loop.run_in_executor(
                None, functools.partial(vn.execute_sql, sql, (db_name, table_name.strip()))
            )
            return ApiResponse(status=200, data=result, message="success")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"获取表结构失败: {str(e)}")
