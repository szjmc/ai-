"""
Vanna 训练语料 JSON 文件持久化管理模块
将 ddl、document、sql 统一存放在 JSON 文件中，支持读取、追加去重与按索引移除。
"""

import json
import logging
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

logger = logging.getLogger(__name__)

TrainingCategory = Literal["ddl", "document", "sql"]
SqlEntry = Union[str, Dict[str, str]]

_STORE_LOCK = threading.Lock()

DEFAULT_TRAINING_DATA: Dict[str, List[Any]] = {
    "ddl": [
        (
            "CREATE TABLE IF NOT EXISTS user_health_risk_assessment (\n"
            "    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',\n"
            "    user_id VARCHAR(64) NOT NULL COMMENT '用户唯一标识',\n"
            "    user_name VARCHAR(100) NOT NULL COMMENT '用户姓名',\n"
            "    sex ENUM('男', '女', '其他') NOT NULL COMMENT '性别',\n"
            "    age TINYINT UNSIGNED NOT NULL COMMENT '年龄',\n"
            "    assessment_time DATETIME NOT NULL COMMENT '测评时间',\n"
            "    assessment_count INT DEFAULT 1 COMMENT '测试次数',\n"
            "    total_score TINYINT UNSIGNED NOT NULL COMMENT '总分',\n"
            "    nutritional_impairment_score TINYINT UNSIGNED NOT NULL COMMENT '营养受损分',\n"
            "    disease_severity_score TINYINT UNSIGNED NOT NULL COMMENT '疾病严重度分',\n"
            "    age_score TINYINT UNSIGNED NOT NULL COMMENT '年龄分',\n"
            "    assessment_basis TEXT COMMENT '评分依据说明',\n"
            "    risk_level ENUM('无风险', '低风险', '中风险', '高风险') NOT NULL COMMENT '风险等级',\n"
            "    bmi DECIMAL(4,2) COMMENT 'BMI指数',\n"
            "    weight_change VARCHAR(100) COMMENT '体重变化情况',\n"
            "    disease_condition TEXT COMMENT '疾病状况描述',\n"
            "    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间'\n"
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户健康风险测评记录表';"
        )
    ],
    "document": [
        (
            "用户健康风险测评记录表包含NRS2002营养风险筛查的完整评分数据。\n"
            "重要字段说明：\n"
            "- total_score: 总分(0-7分)，分数越高风险越大\n"
            "- nutritional_impairment_score: 营养受损评分(0-3分)\n"
            "- disease_severity_score: 疾病严重度评分(0-3分)\n"
            "- age_score: 年龄评分(0-1分)，70岁以上为1分\n"
            "- risk_level: 风险等级，根据总分自动计算\n"
            "- assessment_count: 测评次数，反映用户测评频率\n\n"
            "常用查询模式：\n"
            "1. 查询高风险患者：WHERE risk_level = '高风险'\n"
            "2. 按时间范围查询：WHERE assessment_time BETWEEN '开始时间' AND '结束时间'\n"
            "3. 统计各风险等级人数：GROUP BY risk_level\n"
            "4. 查询用户历史测评记录：WHERE user_id is not null"
        )
    ],
    "sql": [
        "SELECT user_name, age, total_score, risk_level FROM user_health_risk_assessment WHERE risk_level = '高风险' ORDER BY total_score DESC LIMIT 10",
        "SELECT risk_level, COUNT(*) as count FROM user_health_risk_assessment GROUP BY risk_level ORDER BY count DESC",
        "SELECT user_name, assessment_time, total_score FROM user_health_risk_assessment WHERE user_id = 'USER001' ORDER BY assessment_time DESC",
        "SELECT AVG(total_score) as avg_score, AVG(age) as avg_age FROM user_health_risk_assessment WHERE sex = '男'",
        "SELECT DATE(assessment_time) as date, COUNT(*) as daily_count FROM user_health_risk_assessment GROUP BY DATE(assessment_time) ORDER BY date DESC LIMIT 7",
    ],
}


def get_training_file_path(custom_path: Optional[Union[str, Path]] = None) -> Path:
    """解析训练数据 JSON 文件路径（支持环境变量 VANNA_TRAINING_FILE 覆盖）"""
    if custom_path:
        return Path(custom_path).resolve()
    env_path = (os.getenv("VANNA_TRAINING_FILE") or "").strip()
    if env_path:
        return Path(env_path).resolve()
    app_dir = Path(__file__).resolve().parent.parent
    return (app_dir / "data" / "vanna_training_data.json").resolve()


def _normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\r\n", "\n").strip()


def normalize_text_list(raw: Any) -> List[str]:
    """将单条字符串或字符串列表标准化为非空字符串列表"""
    if raw is None:
        return []
    items = [raw] if isinstance(raw, str) else (list(raw) if isinstance(raw, (list, tuple)) else [])
    result: List[str] = []
    for item in items:
        text = _normalize_text(item)
        if text:
            result.append(text)
    return result


def normalize_sql_list(raw: Any, default_question: Optional[str] = None) -> List[SqlEntry]:
    """标准化 SQL 训练列表：支持纯 SQL 字符串或 {'question': ..., 'sql': ...}"""
    if raw is None:
        return []
    q_fallback = _normalize_text(default_question) if default_question else ""
    if isinstance(raw, str):
        sql_text = _normalize_text(raw)
        if not sql_text:
            return []
        if q_fallback:
            return [{"question": q_fallback, "sql": sql_text}]
        return [sql_text]
    if isinstance(raw, dict) or hasattr(raw, "model_dump"):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []

    result: List[SqlEntry] = []
    for item in raw:
        if isinstance(item, str):
            sql_text = _normalize_text(item)
            if sql_text:
                if q_fallback and len(raw) == 1:
                    result.append({"question": q_fallback, "sql": sql_text})
                else:
                    result.append(sql_text)
        elif hasattr(item, "model_dump"):
            dumped = item.model_dump()
            sql_text = _normalize_text(dumped.get("sql"))
            question_text = _normalize_text(dumped.get("question"))
            if sql_text:
                result.append({"question": question_text, "sql": sql_text} if question_text else sql_text)
        elif isinstance(item, dict):
            sql_text = _normalize_text(item.get("sql"))
            question_text = _normalize_text(item.get("question"))
            if sql_text:
                result.append({"question": question_text, "sql": sql_text} if question_text else sql_text)
    return result


def _sql_fingerprint(entry: SqlEntry) -> str:
    if isinstance(entry, dict):
        q = _normalize_text(entry.get("question")).lower()
        s = " ".join(_normalize_text(entry.get("sql")).split()).rstrip(";").lower()
        return f"{q}||{s}"
    return f"||{' '.join(_normalize_text(entry).split()).rstrip(';').lower()}"


def _text_fingerprint(text: str) -> str:
    return " ".join(_normalize_text(text).split()).lower()


def _sanitize_corpus_dict(raw: Any) -> Dict[str, List[Any]]:
    if not isinstance(raw, dict):
        raise ValueError("训练语料 JSON 顶层结构必须是对象（包含 ddl、document、sql）")
    ddl_items = normalize_text_list(raw.get("ddl"))
    doc_source = raw.get("document") if "document" in raw else raw.get("documentation")
    doc_items = normalize_text_list(doc_source)
    sql_items = normalize_sql_list(raw.get("sql"))
    return {
        "ddl": ddl_items,
        "document": doc_items,
        "sql": sql_items,
    }


def _atomic_write_json(file_path: Path, payload: Dict[str, List[Any]]) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = file_path.with_name(f"{file_path.name}.{uuid.uuid4().hex}.tmp")
    content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(tmp_path, file_path)


def load_training_corpus(custom_path: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
    """
    读取 JSON 训练文件内容。若文件尚不存在，则初始化写入默认健康风险测评语料。
    """
    file_path = get_training_file_path(custom_path)
    with _STORE_LOCK:
        if not file_path.exists():
            logger.info(f"训练语料文件不存在，初始化创建: {file_path}")
            _atomic_write_json(file_path, DEFAULT_TRAINING_DATA)

        raw_text = file_path.read_text(encoding="utf-8")
        parsed = json.loads(raw_text) if raw_text.strip() else {"ddl": [], "document": [], "sql": []}
        corpus = _sanitize_corpus_dict(parsed)
        stat = file_path.stat()
        updated_at = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")

    return {
        "ddl": corpus["ddl"],
        "document": corpus["document"],
        "sql": corpus["sql"],
        "counts": {
            "ddl": len(corpus["ddl"]),
            "document": len(corpus["document"]),
            "sql": len(corpus["sql"]),
            "total": len(corpus["ddl"]) + len(corpus["document"]) + len(corpus["sql"]),
        },
        "file_path": str(file_path),
        "file_name": file_path.name,
        "updated_at": updated_at,
    }


def append_training_corpus(
    ddl: Any = None,
    document: Any = None,
    sql: Any = None,
    question: Optional[str] = None,
    custom_path: Optional[Union[str, Path]] = None,
) -> Tuple[Dict[str, Any], Dict[str, List[Any]], Dict[str, int]]:
    """
    将新增的 ddl、document、sql 追加写入 JSON 文件（自动去重），返回：
    1. 更新后的完整语料信息
    2. 本次提交的标准化条目（用于后续触发 Vanna 增量训练）
    3. 跳过的重复条数统计
    """
    submitted_ddl = normalize_text_list(ddl)
    submitted_doc = normalize_text_list(document)
    submitted_sql = normalize_sql_list(sql, default_question=question)

    if not submitted_ddl and not submitted_doc and not submitted_sql:
        raise ValueError("请至少提供 ddl、document 或 sql 中的一项非空训练内容")

    file_path = get_training_file_path(custom_path)
    added_counts = {"ddl": 0, "document": 0, "sql": 0}
    skipped_counts = {"ddl": 0, "document": 0, "sql": 0}
    added_bundle: Dict[str, List[Any]] = {"ddl": [], "document": [], "sql": []}

    with _STORE_LOCK:
        if not file_path.exists():
            _atomic_write_json(file_path, DEFAULT_TRAINING_DATA)

        raw_text = file_path.read_text(encoding="utf-8")
        parsed = json.loads(raw_text) if raw_text.strip() else {"ddl": [], "document": [], "sql": []}
        corpus = _sanitize_corpus_dict(parsed)

        existing_ddl_fp = {_text_fingerprint(item) for item in corpus["ddl"]}
        for item in submitted_ddl:
            fp = _text_fingerprint(item)
            if fp in existing_ddl_fp:
                skipped_counts["ddl"] += 1
            else:
                corpus["ddl"].append(item)
                added_bundle["ddl"].append(item)
                existing_ddl_fp.add(fp)
                added_counts["ddl"] += 1

        existing_doc_fp = {_text_fingerprint(item) for item in corpus["document"]}
        for item in submitted_doc:
            fp = _text_fingerprint(item)
            if fp in existing_doc_fp:
                skipped_counts["document"] += 1
            else:
                corpus["document"].append(item)
                added_bundle["document"].append(item)
                existing_doc_fp.add(fp)
                added_counts["document"] += 1

        existing_sql_fp = {_sql_fingerprint(item) for item in corpus["sql"]}
        for item in submitted_sql:
            fp = _sql_fingerprint(item)
            if fp in existing_sql_fp:
                skipped_counts["sql"] += 1
            else:
                corpus["sql"].append(item)
                added_bundle["sql"].append(item)
                existing_sql_fp.add(fp)
                added_counts["sql"] += 1

        if any(added_counts.values()):
            _atomic_write_json(file_path, corpus)

        stat = file_path.stat()
        updated_at = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")

    snapshot = {
        "ddl": corpus["ddl"],
        "document": corpus["document"],
        "sql": corpus["sql"],
        "counts": {
            "ddl": len(corpus["ddl"]),
            "document": len(corpus["document"]),
            "sql": len(corpus["sql"]),
            "total": len(corpus["ddl"]) + len(corpus["document"]) + len(corpus["sql"]),
        },
        "added": added_counts,
        "skipped_duplicates": skipped_counts,
        "file_path": str(file_path),
        "file_name": file_path.name,
        "updated_at": updated_at,
    }
    return snapshot, added_bundle, skipped_counts


def remove_training_item(
    category: TrainingCategory,
    index: int,
    custom_path: Optional[Union[str, Path]] = None,
) -> Dict[str, Any]:
    """按类别（ddl / document / sql）和下标移除单条训练数据"""
    if category not in ("ddl", "document", "sql"):
        raise ValueError("category 必须是 ddl、document 或 sql 之一")

    file_path = get_training_file_path(custom_path)
    with _STORE_LOCK:
        if not file_path.exists():
            _atomic_write_json(file_path, DEFAULT_TRAINING_DATA)

        raw_text = file_path.read_text(encoding="utf-8")
        parsed = json.loads(raw_text) if raw_text.strip() else {"ddl": [], "document": [], "sql": []}
        corpus = _sanitize_corpus_dict(parsed)

        target_list = corpus[category]
        if index < 0 or index >= len(target_list):
            raise IndexError(f"{category} 下标 {index} 超出范围（共 {len(target_list)} 条）")

        removed = target_list.pop(index)
        _atomic_write_json(file_path, corpus)
        stat = file_path.stat()
        updated_at = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")

    return {
        "removed": {"category": category, "index": index, "content": removed},
        "ddl": corpus["ddl"],
        "document": corpus["document"],
        "sql": corpus["sql"],
        "counts": {
            "ddl": len(corpus["ddl"]),
            "document": len(corpus["document"]),
            "sql": len(corpus["sql"]),
            "total": len(corpus["ddl"]) + len(corpus["document"]) + len(corpus["sql"]),
        },
        "file_path": str(file_path),
        "file_name": file_path.name,
        "updated_at": updated_at,
    }
