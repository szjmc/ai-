# vanna_engine.py
import logging
import os
import re
import time
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional

import pymysql
from app.config import settings
from app.utils.vanna_training_store import (
    append_training_corpus,
    load_training_corpus,
    remove_training_item,
    TrainingCategory,
)

logger = logging.getLogger(__name__)

try:
    from vanna.ollama.ollama import Ollama
    from vanna.chromadb.chromadb_vector import ChromaDB_VectorStore

    _VANNA_IMPORT_ERROR: Optional[str] = None
except Exception as import_exc:  # pragma: no cover - graceful fallback when optional deps missing
    _VANNA_IMPORT_ERROR = str(import_exc)
    logger.warning(f"Vanna/ChromaDB 依赖尚未就绪，Text2SQL 模型功能将按需提示安装: {_VANNA_IMPORT_ERROR}")

    class ChromaDB_VectorStore:  # type: ignore[no-redef]
        def __init__(self, config=None):
            self._fallback_config = config or {}

    class Ollama:  # type: ignore[no-redef]
        def __init__(self, config=None):
            self._ollama_config = config or {}


def clean_generated_sql(raw_sql: Optional[str]) -> str:
    """清理大模型输出中的 <think> 思考块与 Markdown 代码围栏，提取可执行 SQL"""
    if not raw_sql:
        return ""
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", raw_sql, flags=re.IGNORECASE).strip()
    fence_match = re.search(r"```(?:sql)?\s*([\s\S]*?)```", cleaned, flags=re.IGNORECASE)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    return cleaned.strip()


def _json_safe_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (dt_time, timedelta)):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    return value


def _serialize_rows(rows: Any) -> List[Dict[str, Any]]:
    if not rows:
        return []
    return [
        {str(k): _json_safe_value(v) for k, v in dict(row).items()}
        for row in rows
    ]


class HealthRiskVanna(ChromaDB_VectorStore, Ollama):
    def __init__(self, config=None):
        if config is None:
            config = {}
        else:
            config = dict(config)

        # 使用绝对路径避免相对路径问题
        base_dir = Path(__file__).parent.parent
        chroma_path = config.get("chroma_db_path", str(base_dir / "chromadb"))

        # 确保路径是绝对路径
        chroma_path = os.path.abspath(chroma_path)
        config["chroma_db_path"] = chroma_path
        config.setdefault("path", chroma_path)

        self.vanna_ready = False
        self.init_error: Optional[str] = _VANNA_IMPORT_ERROR

        if _VANNA_IMPORT_ERROR is None:
            os.makedirs(chroma_path, exist_ok=True)
            logger.info(f"初始化 ChromaDB，路径: {chroma_path}")
            max_retries = 1
            for attempt in range(max_retries):
                try:
                    ChromaDB_VectorStore.__init__(self, config=config)
                    Ollama.__init__(self, config=config)
                    self.vanna_ready = True
                    self.init_error = None
                    logger.info("ChromaDB 初始化成功")
                    break
                except Exception as e:
                    logger.warning(f"ChromaDB 初始化尝试 {attempt + 1} 失败: {str(e)}")
                    if attempt == max_retries - 1:
                        logger.error("ChromaDB 初始化完全失败，尝试使用内存模式")
                        try:
                            mem_config = dict(config)
                            mem_config["chroma_db_path"] = None
                            mem_config["client"] = "in-memory"
                            ChromaDB_VectorStore.__init__(self, config=mem_config)
                            Ollama.__init__(self, config=mem_config)
                            self.vanna_ready = True
                            self.init_error = None
                        except Exception as fallback_exc:
                            self.vanna_ready = False
                            self.init_error = str(fallback_exc)
                            logger.error(f"Vanna 内存模式初始化失败: {self.init_error}")
                    else:
                        time.sleep(2)
        else:
            ChromaDB_VectorStore.__init__(self, config=config)
            Ollama.__init__(self, config=config)

        self.db_config = {
            "host": settings.MYSQL_HOST or "127.0.0.1",
            "port": int(settings.MYSQL_PORT or 3306),
            "user": settings.MYSQL_USER or "root",
            "password": settings.MYSQL_PASSWORD or "",
            "database": settings.MYSQL_DB or "test_db",
            "charset": "utf8mb4",
            "connect_timeout": 5,
        }

        # 延迟连接数据库，避免启动时阻塞
        self.connection = None

    def _ensure_vanna_ready(self) -> None:
        if not self.vanna_ready or not hasattr(super(), "train"):
            detail = self.init_error or "Vanna 引擎未就绪"
            raise RuntimeError(
                f"Vanna / ChromaDB / Ollama 尚未就绪（{detail}）。请确认已安装 vanna、chromadb 且 Ollama 服务可访问。"
            )

    def generate_sql(self, question: str, **kwargs) -> str:
        self._ensure_vanna_ready()
        raw_sql = super().generate_sql(question=question, **kwargs)
        return clean_generated_sql(raw_sql)

    def connect_to_mysql(self) -> bool:
        """连接MySQL数据库"""
        try:
            if self.connection is None or not self.connection.open:
                self.connection = pymysql.connect(**self.db_config)
                logger.info("成功连接到MySQL数据库")
            else:
                self.connection.ping(reconnect=True)
            return True
        except Exception as e:
            logger.error(f"数据库连接失败: {str(e)}")
            return False

    def execute_sql(self, sql: str, params: Optional[Any] = None) -> List[Dict[str, Any]]:
        """执行SQL查询（兼容无参查询与参数化查询）"""
        def _run_once() -> List[Dict[str, Any]]:
            if self.connection is None or not self.connection.open:
                if not self.connect_to_mysql():
                    raise RuntimeError(
                        f"无法连接 MySQL 数据库 {self.db_config['host']}:{self.db_config['port']}/{self.db_config['database']}"
                    )
            with self.connection.cursor(pymysql.cursors.DictCursor) as cursor:
                if params is not None:
                    cursor.execute(sql, params)
                else:
                    cursor.execute(sql)
                rows = cursor.fetchall()
            self.connection.commit()
            return _serialize_rows(rows)

        try:
            return _run_once()
        except Exception as e:
            logger.error(f"SQL执行失败: {str(e)}")
            try:
                self.connection = None
                return _run_once()
            except Exception as retry_error:
                logger.error(f"SQL重试执行失败: {str(retry_error)}")
                raise retry_error

    def load_training_data(self) -> Dict[str, Any]:
        """从 JSON 文件读取当前的 ddl、document、sql 训练语料"""
        return load_training_corpus()

    def train_items(
        self,
        ddl_list: Optional[List[str]] = None,
        document_list: Optional[List[str]] = None,
        sql_list: Optional[List[Any]] = None,
    ) -> Dict[str, int]:
        """对指定的 ddl、document、sql 列表执行 Vanna 训练"""
        self._ensure_vanna_ready()

        trained = {"ddl": 0, "document": 0, "sql": 0}
        for ddl_item in ddl_list or []:
            if ddl_item and ddl_item.strip():
                self.train(ddl=ddl_item)
                trained["ddl"] += 1

        for doc_item in document_list or []:
            if doc_item and doc_item.strip():
                self.train(documentation=doc_item)
                trained["document"] += 1

        for sql_item in sql_list or []:
            if isinstance(sql_item, dict):
                sql_text = (sql_item.get("sql") or "").strip()
                q_text = (sql_item.get("question") or "").strip()
                if sql_text:
                    if q_text:
                        self.train(question=q_text, sql=sql_text)
                    else:
                        self.train(sql=sql_text)
                    trained["sql"] += 1
            elif isinstance(sql_item, str) and sql_item.strip():
                self.train(sql=sql_item)
                trained["sql"] += 1

        return trained

    def train_health_risk_tables(self, raise_on_error: bool = False) -> Optional[Dict[str, Any]]:
        """从 JSON 文件（vanna_training_data.json）读取全部 ddl、document、sql 并执行训练"""
        try:
            corpus = load_training_corpus()
            trained_counts = self.train_items(
                ddl_list=corpus["ddl"],
                document_list=corpus["document"],
                sql_list=corpus["sql"],
            )
            logger.info(
                f"JSON 训练语料全量训练完成: DDL={trained_counts['ddl']}, "
                f"Document={trained_counts['document']}, SQL={trained_counts['sql']}"
            )
            return {
                "trained_counts": trained_counts,
                "totals": corpus["counts"],
                "file_path": corpus["file_path"],
                "updated_at": corpus["updated_at"],
            }
        except Exception as e:
            logger.error(f"训练过程出现错误: {str(e)}")
            if raise_on_error:
                raise
            return None

    def add_training_data(
        self,
        ddl: Any = None,
        document: Any = None,
        sql: Any = None,
        question: Optional[str] = None,
        auto_train: bool = True,
    ) -> Dict[str, Any]:
        """
        新增训练接口核心逻辑：
        1. 将新增的 ddl、document、sql 追加写入 JSON 文件（自动去重）
        2. 当 auto_train=True 时，立即调用 Vanna 对本次提交的条目完成增量训练
        """
        snapshot, submitted_bundle, skipped_counts = append_training_corpus(
            ddl=ddl,
            document=document,
            sql=sql,
            question=question,
        )

        trained_counts = {"ddl": 0, "document": 0, "sql": 0}
        trained = False
        if auto_train:
            trained_counts = self.train_items(
                ddl_list=submitted_bundle["ddl"],
                document_list=submitted_bundle["document"],
                sql_list=submitted_bundle["sql"],
            )
            trained = True

        return {
            "added": snapshot["added"],
            "skipped_duplicates": skipped_counts,
            "trained": trained,
            "trained_counts": trained_counts,
            "counts": snapshot["counts"],
            "file_name": snapshot["file_name"],
            "file_path": snapshot["file_path"],
            "updated_at": snapshot["updated_at"],
            "ddl": snapshot["ddl"],
            "document": snapshot["document"],
            "sql": snapshot["sql"],
        }

    def delete_training_data(self, category: TrainingCategory, index: int) -> Dict[str, Any]:
        """从训练 JSON 文件移除单条 ddl / document / sql"""
        return remove_training_item(category=category, index=index)


# 初始化Vanna实例 - 使用绝对路径
base_dir = Path(__file__).parent
chroma_db_path = base_dir / "chromadb"

vanna_config = {
    "model": settings.LLM_MODEL,
    "ollama_host": settings.OLLAMA_BASE_URL,
    "chroma_db_path": str(chroma_db_path),
}

vn = HealthRiskVanna(config=vanna_config)
