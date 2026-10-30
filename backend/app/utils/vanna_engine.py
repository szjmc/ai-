# vanna_engine.py
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pymysql
from app.config import settings
from app.services.vanna_training_service import (
    add_training_and_sync,
    clean_generated_sql,
    delete_json_training_item,
    get_json_training_corpus,
    serialize_sql_rows,
    train_all_from_json,
    train_items_on_vanna,
)
from app.utils.vanna_training_store import TrainingCategory

logger = logging.getLogger(__name__)

try:
    from vanna.ollama.ollama import Ollama
    from vanna.chromadb.chromadb_vector import ChromaDB_VectorStore

    _VANNA_IMPORT_ERROR: Optional[str] = None
except Exception:
    try:
        from vanna.legacy.ollama.ollama import Ollama  # type: ignore[no-redef]
        from vanna.legacy.chromadb.chromadb_vector import ChromaDB_VectorStore  # type: ignore[no-redef]

        _VANNA_IMPORT_ERROR = None
    except Exception as import_exc:  # pragma: no cover
        _VANNA_IMPORT_ERROR = str(import_exc)
        logger.warning(f"Vanna/ChromaDB 依赖尚未就绪，Text2SQL 模型功能将按需提示安装: {_VANNA_IMPORT_ERROR}")

        class ChromaDB_VectorStore:  # type: ignore[no-redef]
            def __init__(self, config=None):
                self._fallback_config = config or {}

        class Ollama:  # type: ignore[no-redef]
            def __init__(self, config=None):
                self._ollama_config = config or {}


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
                        logger.error("ChromaDB 初始化完全失败，使用内存模式")
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
        """执行SQL查询"""
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
            return serialize_sql_rows(rows)

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

    def train_health_risk_tables(self) -> Optional[Dict[str, Any]]:
        """从 JSON 文件读取全部 ddl、document、sql 执行训练"""
        try:
            return train_all_from_json(self)
        except Exception as e:
            logger.error(f"训练过程出现错误: {str(e)}")
            return None

    def load_training_data(self) -> Dict[str, Any]:
        return get_json_training_corpus()

    def train_items(
        self,
        ddl_list: Optional[List[str]] = None,
        document_list: Optional[List[str]] = None,
        sql_list: Optional[List[Any]] = None,
    ) -> Dict[str, int]:
        return train_items_on_vanna(self, ddl_list=ddl_list, document_list=document_list, sql_list=sql_list)

    def add_training_data(
        self,
        ddl: Any = None,
        document: Any = None,
        sql: Any = None,
        question: Optional[str] = None,
        auto_train: bool = True,
    ) -> Dict[str, Any]:
        return add_training_and_sync(
            self,
            ddl=ddl,
            document=document,
            sql=sql,
            question=question,
            auto_train=auto_train,
        )

    def delete_training_data(self, category: TrainingCategory, index: int) -> Dict[str, Any]:
        return delete_json_training_item(category=category, index=index)


# 导出兼容引用
_serialize_rows = serialize_sql_rows

# 初始化Vanna实例 - 使用绝对路径
base_dir = Path(__file__).parent
chroma_db_path = base_dir / "chromadb"

vanna_config = {
    "model": settings.LLM_MODEL,
    "ollama_host": settings.OLLAMA_BASE_URL,
    "chroma_db_path": str(chroma_db_path),
}

vn = HealthRiskVanna(config=vanna_config)
