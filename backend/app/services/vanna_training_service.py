"""
Vanna 训练与 SQL 辅助服务模块（独立新增模块，不侵入也不依赖对原 HealthRiskVanna 类的自定义扩展）
直接通过标准 Vanna 接口 vn.train(ddl=..., documentation=..., question=..., sql=...) 完成增量与全量训练，
并将 ddl、document、sql 统一持久化在 JSON 文件（vanna_training_data.json）中。
"""

import logging
import re
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

import pymysql.converters

from app.utils.vanna_training_store import (
    TrainingCategory,
    append_training_corpus,
    load_training_corpus,
    remove_training_item,
)

logger = logging.getLogger(__name__)

_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_]+$")


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
        if value.as_tuple().exponent == 0:
            return int(value)
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


def serialize_sql_rows(rows: Any) -> List[Dict[str, Any]]:
    """将 PyMySQL DictCursor 返回结果中的 Decimal / datetime 等转换为可 JSON 序列化的基础类型"""
    if not rows:
        return []
    return [
        {str(k): _json_safe_value(v) for k, v in dict(row).items()}
        for row in rows
    ]


def is_vanna_model_ready(vn_instance: Any) -> bool:
    """兼容原版 HealthRiskVanna 实例与带状态标记的实例，判断 Vanna 训练/生成接口是否可用"""
    if vn_instance is None:
        return False
    if hasattr(vn_instance, "vanna_ready"):
        return bool(getattr(vn_instance, "vanna_ready"))
    return callable(getattr(vn_instance, "train", None)) and callable(
        getattr(vn_instance, "generate_sql", None)
    )


def ensure_vanna_trainable(vn_instance: Any) -> None:
    """校验 vn 实例具备标准 train 方法"""
    if not is_vanna_model_ready(vn_instance) or not callable(getattr(vn_instance, "train", None)):
        detail = getattr(vn_instance, "init_error", None) or "Vanna 实例未加载 train 方法"
        raise RuntimeError(
            f"Vanna / ChromaDB / Ollama 尚未就绪（{detail}）。请确认已安装 vanna、chromadb 且 Ollama 服务可访问。"
        )


def train_items_on_vanna(
    vn_instance: Any,
    ddl_list: Optional[List[str]] = None,
    document_list: Optional[List[str]] = None,
    sql_list: Optional[List[Any]] = None,
) -> Dict[str, int]:
    """
    直接调用标准 VannaBase.train(...) 接口完成训练，
    无需 HealthRiskVanna 定义任何额外自定义方法。
    """
    ensure_vanna_trainable(vn_instance)

    trained = {"ddl": 0, "document": 0, "sql": 0}

    for ddl_item in ddl_list or []:
        if isinstance(ddl_item, str) and ddl_item.strip():
            vn_instance.train(ddl=ddl_item.strip())
            trained["ddl"] += 1

    for doc_item in document_list or []:
        if isinstance(doc_item, str) and doc_item.strip():
            vn_instance.train(documentation=doc_item.strip())
            trained["document"] += 1

    for sql_item in sql_list or []:
        if isinstance(sql_item, dict):
            sql_text = (sql_item.get("sql") or "").strip()
            q_text = (sql_item.get("question") or "").strip()
            if sql_text:
                if q_text:
                    vn_instance.train(question=q_text, sql=sql_text)
                else:
                    vn_instance.train(sql=sql_text)
                trained["sql"] += 1
        elif isinstance(sql_item, str) and sql_item.strip():
            vn_instance.train(sql=sql_item.strip())
            trained["sql"] += 1

    return trained


def train_all_from_json(vn_instance: Any) -> Dict[str, Any]:
    """从 JSON 文件读取全部 ddl、document、sql，并调用标准 vn.train(...) 完成全量训练"""
    corpus = load_training_corpus()
    trained_counts = train_items_on_vanna(
        vn_instance,
        ddl_list=corpus["ddl"],
        document_list=corpus["document"],
        sql_list=corpus["sql"],
    )
    logger.info(
        f"JSON 语料全量训练完成: DDL={trained_counts['ddl']}, "
        f"Document={trained_counts['document']}, SQL={trained_counts['sql']}"
    )
    return {
        "trained_counts": trained_counts,
        "totals": corpus["counts"],
        "file_name": corpus["file_name"],
        "file_path": corpus["file_path"],
        "updated_at": corpus["updated_at"],
    }


class IncrementalTrainError(Exception):
    """当 JSON 文件已写入成功、但调用 Vanna 向量训练阶段报错时抛出，携带已落盘快照"""

    def __init__(self, message: str, snapshot: Dict[str, Any]):
        super().__init__(message)
        self.snapshot = snapshot


def add_training_and_sync(
    vn_instance: Any,
    ddl: Any = None,
    document: Any = None,
    sql: Any = None,
    question: Optional[str] = None,
    auto_train: bool = True,
) -> Dict[str, Any]:
    """
    新增训练完整流程（不依赖 vn.add_training_data 等非标方法）：
    1. 先将 ddl、document、sql 原子写入 vanna_training_data.json（自动去重）
    2. 若 auto_train=True，直接调用标准 vn.train(...) 完成增量向量训练
    """
    snapshot, added_bundle, skipped_counts = append_training_corpus(
        ddl=ddl,
        document=document,
        sql=sql,
        question=question,
    )

    trained_counts = {"ddl": 0, "document": 0, "sql": 0}
    trained = False
    has_new_items = bool(
        added_bundle["ddl"] or added_bundle["document"] or added_bundle["sql"]
    )

    if auto_train and has_new_items:
        try:
            trained_counts = train_items_on_vanna(
                vn_instance,
                ddl_list=added_bundle["ddl"],
                document_list=added_bundle["document"],
                sql_list=added_bundle["sql"],
            )
            trained = True
        except Exception as exc:
            raise IncrementalTrainError(str(exc), snapshot=snapshot) from exc

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


def get_json_training_corpus() -> Dict[str, Any]:
    """获取当前 JSON 文件中的全部训练语料"""
    return load_training_corpus()


def delete_json_training_item(category: TrainingCategory, index: int) -> Dict[str, Any]:
    """删除 JSON 文件中的指定训练语料"""
    return remove_training_item(category=category, index=index)


def query_table_columns(vn_instance: Any, db_name: str, table_name: str) -> List[Dict[str, Any]]:
    """
    查询指定表字段结构。
    兼容原版 HealthRiskVanna.execute_sql(self, sql: str) 单参数签名，不传第二个元组参数。
    """
    clean_table = (table_name or "user_health_risk_assessment").strip()
    if not _IDENTIFIER_RE.match(clean_table):
        raise ValueError("表名仅允许包含字母、数字和下划线")

    escaped_db = pymysql.converters.escape_string((db_name or "test_db").strip())
    escaped_table = pymysql.converters.escape_string(clean_table)

    sql = (
        "SELECT "
        "TABLE_NAME, "
        "COLUMN_NAME, "
        "DATA_TYPE, "
        "COLUMN_COMMENT "
        "FROM information_schema.COLUMNS "
        f"WHERE TABLE_SCHEMA = '{escaped_db}' AND TABLE_NAME = '{escaped_table}' "
        "ORDER BY ORDINAL_POSITION"
    )
    rows = vn_instance.execute_sql(sql)
    return serialize_sql_rows(rows)
