"""Text2Echarts 结果后处理。

前端只负责展示，所有业务逻辑都在这里完成：
1. 从 Dify 工作流返回（``answer`` 里带 ```echarts 代码块的 Markdown）中解析 ECharts 配置；
2. 用 SQL 查询结果生成数据表格（单指标时补「占比」列）；
3. 依据表格做算术汇总，生成智能报告的指标、结论与风险提示。

只解析 JSON，不执行任何生成的 JavaScript；所有函数返回 JSON 可序列化的 dict。
"""

import json
import re
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# 目前只开放三种图表类型；英文别名便于接口直接调用。
CHART_TYPE_ALIASES = {
    "柱状图": "柱状图",
    "bar": "柱状图",
    "折线图": "折线图",
    "line": "折线图",
    "饼图": "饼图",
    "pie": "饼图",
}

_CODE_FENCE = re.compile(r"```[^\n`]*\n?(.*?)```", re.S)
_TRAILING_COMMA = re.compile(r",\s*([}\]])")
_HIGH_RISK_LABEL = re.compile(r"高风险|高危|high[-\s_]?risk", re.I)

# 工作流结果的常见包装字段，优先在这些字段里找图表配置。
_WRAPPER_KEYS = (
    "option", "options", "answer", "outputs", "data", "result",
    "text", "content", "message", "messages", "choices",
)
# 与图表配置无关的大字段，跳过以节省遍历成本。
_SKIP_KEYS = (
    "metadata", "usage", "reasoning", "annotation_reply", "retriever_resources",
    "id", "task_id", "message_id", "conversation_id", "created_by", "created_at",
    "event", "mode", "workflow_run_id", "status",
)

_MAX_DEPTH = 12
_MAX_JSON_STARTS = 24
_MAX_NODES = 4000
_MAX_COLUMNS = 8


def normalize_chart_type(value: Optional[str]) -> Optional[str]:
    """把请求里的图表类型归一到「柱状图 / 折线图 / 饼图」，不支持时返回 None。"""
    if not isinstance(value, str):
        return None
    return CHART_TYPE_ALIASES.get(value.strip())


# --------------------------------------------------------------------------- #
# 1. 从工作流返回中解析 ECharts 配置
# --------------------------------------------------------------------------- #
def _balanced_json(text: str, start: int) -> Optional[str]:
    """从 ``start``（{ 或 [）开始按括号配对截取一段 JSON 文本。"""
    opener = text[start]
    if opener not in "{[":
        return None
    depth = 0
    quote: Optional[str] = None
    escape = False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def _parse_json(candidate: str) -> Optional[Any]:
    body = candidate.strip()
    if not body:
        return None
    try:
        return json.loads(body)
    except (ValueError, TypeError):
        pass
    try:  # 容忍尾随逗号，仍然只解析 JSON
        return json.loads(_TRAILING_COMMA.sub(r"\1", body))
    except (ValueError, TypeError):
        return None


def _json_start_indexes(text: str) -> List[int]:
    indexes = []
    for index, char in enumerate(text):
        if char in "{[":
            indexes.append(index)
            if len(indexes) >= _MAX_JSON_STARTS:
                break
    return indexes


def _parse_text_values(text: str) -> List[Any]:
    """从一段自由文本里取出所有能解析出来的 JSON（代码块 / 整串 / 内嵌片段）。"""
    trimmed = text.strip()
    if not trimmed:
        return []
    candidates: List[str] = [match.group(1) for match in _CODE_FENCE.finditer(trimmed) if match.group(1).strip()]
    candidates.append(trimmed)
    for start in _json_start_indexes(trimmed):
        snippet = _balanced_json(trimmed, start)
        if snippet:
            candidates.append(snippet)
    values = []
    for candidate in candidates:
        parsed = _parse_json(candidate)
        if parsed is not None:
            values.append(parsed)
    return values


def _is_option(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("series"), (list, dict))


def _search(value: Any, depth: int, budget: List[int]) -> Optional[Dict[str, Any]]:
    if depth > _MAX_DEPTH or value is None:
        return None
    budget[0] -= 1
    if budget[0] <= 0:
        return None
    if isinstance(value, str):
        for parsed in _parse_text_values(value):
            found = _search(parsed, depth + 1, budget)
            if found:
                return found
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            found = _search(item, depth + 1, budget)
            if found:
                return found
        return None
    if isinstance(value, dict):
        if _is_option(value):
            return value
        keys = [key for key in _WRAPPER_KEYS if key in value]
        keys += [key for key in value if key not in _WRAPPER_KEYS and key not in _SKIP_KEYS]
        for key in keys:
            found = _search(value[key], depth + 1, budget)
            if found:
                return found
    return None


def extract_echarts_option(payload: Any) -> Optional[Dict[str, Any]]:
    """从工作流返回中取出可渲染的 ECharts 配置，找不到返回 None。"""
    found = _search(payload, 0, [_MAX_NODES])
    if not found:
        return None
    return _json_safe(found)


def _json_safe(value: Any) -> Any:
    """把配置里的非 JSON 类型（Decimal / datetime 等）转成 JSON 可序列化的值。"""
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


# --------------------------------------------------------------------------- #
# 2. 生成数据表格（含占比）
# --------------------------------------------------------------------------- #
def _to_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(",", "").replace("%", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _format_count(value: float) -> str:
    if abs(value - round(value)) < 1e-9:
        return f"{int(round(value)):,}"
    return f"{value:,.2f}"


def _format_percent(ratio: float) -> str:
    percent = round(ratio * 100, 1)
    if abs(percent - round(percent)) < 1e-9:
        return f"{int(round(percent))}%"
    return f"{percent:.1f}%"


def _table_from_rows(rows: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    sample = next((row for row in rows if isinstance(row, dict) and row), None)
    if not sample:
        return None
    columns = [str(column) for column in list(sample.keys())[:_MAX_COLUMNS]]
    if not columns:
        return None
    numeric_columns = [
        column for column in columns
        if all(_to_number(row.get(column)) is not None for row in rows)
    ]
    single_measure = len(numeric_columns) == 1
    value_column = columns.index(numeric_columns[0]) if numeric_columns else min(1, len(columns) - 1)

    cells: List[List[Any]] = []
    for row in rows:
        line: List[Any] = []
        for column in columns:
            raw = row.get(column)
            if column in numeric_columns:
                number = _to_number(raw) or 0
                line.append(int(number) if abs(number - round(number)) < 1e-9 else round(number, 4))
            else:
                line.append("" if raw is None else str(raw))
        cells.append(line)

    total = sum(float(line[value_column] or 0) for line in cells) if single_measure else 0.0
    if single_measure:
        columns = columns + ["占比"]
        for line in cells:
            line.append(_format_percent(float(line[value_column] or 0) / total) if total > 0 else "—")

    label_column = next((column for column in columns if column not in numeric_columns), columns[0])
    return {
        "columns": columns,
        "rows": cells,
        "value_column": value_column,
        "share_column": len(columns) - 1 if single_measure else -1,
        "value_label": numeric_columns[0] if numeric_columns else "数值",
        "label_label": label_column,
        "row_count": len(cells),
        "total": total if single_measure else None,
    }


def _first_dict(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict):
        return value
    if isinstance(value, (list, tuple)):
        return next((item for item in value if isinstance(item, dict)), None)
    return None


def _table_from_option(option: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not option:
        return None
    series_list = [item for item in option.get("series") or [] if isinstance(item, dict)]
    axis = _first_dict(option.get("xAxis"))
    labels = [str(item) for item in (axis.get("data") if axis else [] or [])]

    values_by_series: List[Tuple[str, List[float]]] = []
    pie_labels: List[str] = []
    for index, series in enumerate(series_list):
        name = str(series.get("name") or f"系列 {index + 1}")
        values: List[float] = []
        for item in series.get("data") or []:
            if isinstance(item, dict):
                if series.get("type") == "pie" and item.get("name") is not None:
                    pie_labels.append(str(item.get("name")))
                values.append(_to_number(item.get("value")) or 0.0)
            else:
                values.append(_to_number(item) or 0.0)
        if values:
            values_by_series.append((name, values))
    if not values_by_series:
        return None
    if not labels:
        labels = pie_labels
    if not labels:
        return None

    single = len(values_by_series) == 1
    rows: List[List[Any]] = []
    for index, label in enumerate(labels):
        line: List[Any] = [label]
        for _, values in values_by_series:
            number = values[index] if index < len(values) else 0.0
            line.append(int(number) if abs(number - round(number)) < 1e-9 else round(number, 4))
        rows.append(line)

    columns = ["分组", *[name for name, _ in values_by_series]]
    total = sum(float(line[1] or 0) for line in rows) if single else 0.0
    if single:
        columns.append("占比")
        for line in rows:
            line.append(_format_percent(float(line[1] or 0) / total) if total > 0 else "—")

    return {
        "columns": columns,
        "rows": rows,
        "value_column": 1,
        "share_column": len(columns) - 1 if single else -1,
        "value_label": values_by_series[0][0],
        "label_label": "分组",
        "row_count": len(rows),
        "total": total if single else None,
    }


def build_table(rows: Optional[Iterable[Any]], option: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """优先使用 SQL 查询结果（保留数据库自己的顺序与列名），否则按图表配置反推。"""
    if rows:
        # 全空的行（没有标签也没有数值）无法展示，直接忽略。
        clean_rows = [
            row for row in rows
            if isinstance(row, dict) and any(str(value).strip() for value in row.values() if value is not None)
        ]
        if clean_rows:
            table = _table_from_rows(clean_rows)
            if table:
                return table
    return _table_from_option(option)


# --------------------------------------------------------------------------- #
# 3. 智能报告
# --------------------------------------------------------------------------- #
def build_report(option: Optional[Dict[str, Any]], table: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """按表格数据做算术汇总；不调用模型，不做无依据的推断。"""
    if not table or not table.get("rows"):
        return None
    label_index = 0
    value_index = int(table.get("value_column") or 1)
    entries: List[Tuple[str, float]] = []
    for row in table["rows"]:
        if len(row) <= value_index:
            continue
        number = _to_number(row[value_index])
        if number is None:
            continue
        entries.append((str(row[label_index]), number))
    if not entries:
        return None

    total = sum(max(0.0, value) for _, value in entries)
    ordered = sorted(entries, key=lambda item: item[1], reverse=True)
    top_label, top_value = ordered[0]
    bottom_label, bottom_value = ordered[-1]
    groups = len(entries)
    top_share = top_value / total if total > 0 else 0.0
    bottom_share = bottom_value / total if total > 0 else 0.0

    metrics = [
        {"label": "样本合计", "value": _format_count(total), "hint": f"覆盖 {groups} 个分组"},
        {"label": "占比最高", "value": _format_percent(top_share), "hint": f"{top_label} · {_format_count(top_value)}"},
        (
            {"label": "差距", "value": _format_percent(top_share - bottom_share), "hint": f"最高 {top_label} / 最低 {bottom_label}"}
            if groups > 1 else
            {"label": "分组", "value": "1", "hint": "仅一个分组，无法比较"}
        ),
    ]

    if groups > 1:
        summary = (
            f"本次共统计 {groups} 个分组、{_format_count(total)} 条记录。"
            f"{top_label or '—'} 最多，为 {_format_count(top_value)}（{_format_percent(top_share)}）；"
            f"{bottom_label or '—'} 最少，为 {_format_count(bottom_value)}（{_format_percent(bottom_share)}）。"
        )
    else:
        summary = f"本次共统计 1 个分组、{_format_count(total)} 条记录：{top_label or '—'}。"

    risky = [(label, value) for label, value in entries if _HIGH_RISK_LABEL.search(label)]
    risky_total = sum(max(0.0, value) for _, value in risky)
    risky_share = risky_total / total if total > 0 else 0.0

    insight: Optional[str] = None
    tone = "info"
    if risky and len(risky) < groups and risky_share >= 0.2:
        labels = "、".join(label for label, _ in risky)
        insight = (
            f"{labels}合计 {_format_count(risky_total)} 条，占 {_format_percent(risky_share)}，"
            "建议优先安排风险评估与随访管理策略。"
        )
        tone = "warn"
    elif groups > 1 and top_share >= 0.4:
        insight = f"{top_label} 占比 {_format_percent(top_share)}，明显高于其他分组，可作为本轮干预与资源投放的重点。"

    return {"metrics": metrics, "summary": summary, "insight": insight, "insight_tone": tone}


# --------------------------------------------------------------------------- #
# 4. 汇总成前端直接渲染的载荷
# --------------------------------------------------------------------------- #
def chart_title(option: Optional[Dict[str, Any]]) -> str:
    if not option:
        return ""
    raw = option.get("title")
    title = _first_dict(raw)
    if title and isinstance(title.get("text"), str):
        return title["text"].strip()
    return raw.strip() if isinstance(raw, str) else ""


def chart_legend(option: Optional[Dict[str, Any]]) -> List[str]:
    if not option:
        return []
    names = []
    for index, series in enumerate(option.get("series") or []):
        if not isinstance(series, dict):
            continue
        name = series.get("name")
        names.append(name.strip() if isinstance(name, str) and name.strip() else f"系列 {index + 1}")
    return names


def build_chart_payload(
    workflow_result: Any,
    rows: Optional[Iterable[Any]] = None,
    question: str = "",
    chart_type: Optional[str] = None,
) -> Dict[str, Any]:
    """把工作流返回整理成前端可直接渲染的图表 / 表格 / 报告。"""
    option = extract_echarts_option(workflow_result)
    table = build_table(rows, option)
    report = build_report(option, table)
    subtitle = " / ".join(chart_legend(option)) or (chart_type or "")
    return {
        "chart_type": chart_type,
        "title": chart_title(option) or question,
        "subtitle": subtitle,
        "echarts_option": option,
        "table": table,
        "report": report,
    }
