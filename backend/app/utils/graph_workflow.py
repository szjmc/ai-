"""健康数据分析智能体工作流工具模块。

负责：
1. 解析用户自然语言输入（含 ``问题(图表类型)`` 语法）；
2. 对 SQL 查询结果做清洗、友好字段映射与表格整理；
3. 基于真实查询结果生成表格 + 结构化分析结论 + 总结 Markdown；
4. 生成或解析前端可直接渲染的 ECharts 配置（柱状图 / 折线图 / 饼图）。

所有异常细节只记录日志，不向浏览器暴露 SQL、数据库结构、密钥或内部服务地址。
"""

import json
import os
import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.utils.echarts_insight import (
    CHART_TYPE_ALIASES,
    build_report,
    build_table,
    chart_title,
    extract_echarts_option,
    normalize_chart_type,
)

# 与图表面板风格一致的柔和专业配色
CHART_PALETTE = [
    "#496be8",
    "#78c273",
    "#f6c343",
    "#e8684a",
    "#7262fd",
    "#5ad8a6",
    "#5d7092",
    "#f08bb4",
]

# 常见英文列名映射为友好的中文展示名（仅用于展示与图表，不暴露库表结构）
COLUMN_DISPLAY_LABELS: Dict[str, str] = {
    "id": "编号",
    "user_id": "用户编号",
    "user_name": "姓名",
    "sex": "性别",
    "gender": "性别",
    "age": "年龄",
    "assessment_time": "测评时间",
    "assessment_count": "测评次数",
    "total_score": "总分",
    "nutritional_impairment_score": "营养受损分",
    "disease_severity_score": "疾病严重度分",
    "age_score": "年龄分",
    "assessment_basis": "评分依据",
    "risk_level": "风险等级",
    "bmi": "BMI",
    "weight_change": "体重变化",
    "disease_condition": "疾病状况",
    "created_at": "创建时间",
    "count": "人数",
    "cnt": "人数",
    "total": "合计",
    "daily_count": "每日人数",
    "avg_score": "平均分",
    "avg_age": "平均年龄",
    "date": "日期",
}

_TRAILING_CHART_PAREN = re.compile(r"[（(]\s*([^()（）]+?)\s*[）)]\s*$")
_SQL_READONLY_RE = re.compile(r"^\s*(?:--[^\n]*\n\s*|/\*[\s\S]*?\*/\s*)*(SELECT|WITH)\b", re.I)
_LINE_HINT_RE = re.compile(r"趋势|走势|变化|每日|每天|每周|每月|按日|按周|按月|曲线|折线|日期|时间")
_PIE_HINT_RE = re.compile(r"分布|占比|比例|构成|份额|饼图|风险")


def parse_graph_input(
    raw_question: str,
    explicit_chart_type: Optional[str] = None,
) -> Tuple[str, str]:
    """解析问题文本与图表类型。

    支持：
    - ``查询高风险(饼图)`` / ``查询高风险（柱状图）``
    - 显式传入 ``echarts_type``
    - 未显式指定时按语义推断默认图表类型（趋势->折线图，风险/分布/占比->饼图，其余->柱状图）
    """
    text = (raw_question or "").strip()
    if not text:
        raise ValueError("请输入分析问题")

    extracted_type: Optional[str] = None
    clean_question = text
    match = _TRAILING_CHART_PAREN.search(text)
    if match:
        candidate = match.group(1).strip()
        normalized = normalize_chart_type(candidate) or normalize_chart_type(candidate.lower())
        if normalized:
            extracted_type = normalized
            stripped = text[: match.start()].strip()
            if stripped:
                clean_question = stripped

    if explicit_chart_type is not None and str(explicit_chart_type).strip():
        raw_type = str(explicit_chart_type).strip()
        normalized_explicit = normalize_chart_type(raw_type) or normalize_chart_type(raw_type.lower())
        if not normalized_explicit:
            raise ValueError("图表类型仅支持柱状图、折线图、饼图")
        chart_type = normalized_explicit
    elif extracted_type:
        chart_type = extracted_type
    elif _LINE_HINT_RE.search(clean_question):
        chart_type = "折线图"
    elif _PIE_HINT_RE.search(clean_question):
        chart_type = "饼图"
    else:
        chart_type = "柱状图"

    return clean_question, chart_type


def is_safe_readonly_sql(sql: str) -> bool:
    """仅允许只读 SELECT / WITH 查询语句。"""
    if not sql or not isinstance(sql, str):
        return False
    stripped = sql.strip()
    if not _SQL_READONLY_RE.match(stripped):
        return False
    forbidden = re.search(
        r"\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE)\b",
        stripped,
        re.I,
    )
    return forbidden is None


def _json_safe_cell(value: Any) -> Any:
    if isinstance(value, Decimal):
        num = float(value)
        return int(num) if abs(num - round(num)) < 1e-9 else round(num, 4)
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, float):
        return int(value) if abs(value - round(value)) < 1e-9 else round(value, 4)
    return value


def _to_number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
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


def format_rows_for_display(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """将 SQL 原始行转换为中文友好列名与 JSON 安全值。"""
    formatted: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        item: Dict[str, Any] = {}
        used_keys: Dict[str, int] = {}
        for raw_key, raw_val in row.items():
            key_str = str(raw_key).strip()
            display_key = COLUMN_DISPLAY_LABELS.get(key_str.lower(), key_str)
            if display_key in used_keys:
                used_keys[display_key] += 1
                display_key = f"{display_key}_{used_keys[display_key]}"
            else:
                used_keys[display_key] = 1
            item[display_key] = _json_safe_cell(raw_val)
        if item:
            formatted.append(item)
    return formatted


def _format_num(value: float) -> str:
    if abs(value - round(value)) < 1e-9:
        return f"{int(round(value)):,}"
    return f"{value:,.2f}"


def _format_pct(ratio: float) -> str:
    pct = round(ratio * 100, 1)
    if abs(pct - round(pct)) < 1e-9:
        return f"{int(round(pct))}%"
    return f"{pct:.1f}%"


def build_markdown_table(table: Optional[Dict[str, Any]], max_rows: int = 20) -> str:
    """将结构化 table 渲染为标准 Markdown 表格。"""
    if not table or not table.get("columns") or not table.get("rows"):
        return ""
    columns = [str(col) for col in table["columns"]]
    rows = table["rows"][:max_rows]
    lines = [
        "| " + " | ".join(columns) + " |",
        "| " + " | ".join(["---"] * len(columns)) + " |",
    ]
    for row in rows:
        cells = []
        for cell in row:
            text = "" if cell is None else str(cell).replace("|", "\\|").replace("\n", " ")
            cells.append(text)
        lines.append("| " + " | ".join(cells) + " |")
    if len(table["rows"]) > max_rows:
        lines.append(f"\n> 注：表格仅预览前 {max_rows} 条，完整共 {len(table['rows'])} 条记录。")
    return "\n".join(lines)


def _infer_chart_title(question: str, chart_type: str, rows: Sequence[Dict[str, Any]]) -> str:
    if any("风险等级" in row for row in rows):
        return "营养风险等级分布统计" if chart_type == "饼图" else "营养风险等级统计"
    clean = re.sub(r"[？?。！!]+$", "", question or "").strip()
    if not clean:
        return "健康数据分析图表"
    return clean if len(clean) <= 24 else f"{clean[:22]}…"


def _aggregate_category_counts(
    rows: Sequence[Dict[str, Any]],
    column: str,
) -> List[Tuple[str, int]]:
    counts: Dict[str, int] = {}
    for row in rows:
        val = str(row.get(column) or "未标注").strip() or "未标注"
        counts[val] = counts.get(val, 0) + 1
    return sorted(counts.items(), key=lambda item: item[1], reverse=True)


def _age_bucket(age: float) -> str:
    if age < 45:
        return "45岁以下"
    if age < 60:
        return "45-59岁"
    if age < 70:
        return "60-69岁"
    return "70岁及以上"


def _pick_pie_series(
    rows: Sequence[Dict[str, Any]],
    table: Optional[Dict[str, Any]],
) -> Tuple[str, List[Dict[str, Any]]]:
    """为饼图智能选取最有信息量的分类统计。"""
    if not rows:
        return "数量", []

    columns = list(rows[0].keys())
    text_cols = [
        col for col in columns
        if not all(_to_number(row.get(col)) is not None for row in rows if row.get(col) is not None)
    ]
    num_cols = [
        col for col in columns
        if all(_to_number(row.get(col)) is not None for row in rows if row.get(col) is not None)
        and any(_to_number(row.get(col)) is not None for row in rows)
    ]

    detail_id_cols = {"姓名", "用户编号", "测评编号", "记录ID", "评分依据", "测评时间", "创建时间"}
    # 情况 1：已经是汇总表（存在非个体标识的唯一分类标签 + 数值列）
    if text_cols and num_cols:
        summary_text_cols = [c for c in text_cols if c not in detail_id_cols]
        if summary_text_cols:
            label_col = summary_text_cols[0]
            val_col = num_cols[0]
            raw_labels = [str(row.get(label_col) or "").strip() for row in rows]
            if len(raw_labels) == len(set(raw_labels)) and len(rows) <= 15:
                data = [
                    {"name": str(row.get(label_col) or "未标注"), "value": _to_number(row.get(val_col)) or 0}
                    for row in rows
                ]
                return val_col, data

    # 情况 2：明细数据，优先按有区分度的分类列聚合计数（如 风险等级、性别、疾病状况）
    preferred_dims = ["风险等级", "性别", "疾病状况", "体重变化"]
    ordered_dims = [c for c in preferred_dims if c in text_cols] + [
        c for c in text_cols if c not in preferred_dims and c not in ("姓名", "用户编号", "评分依据", "测评时间", "创建时间")
    ]
    for dim in ordered_dims:
        grouped = _aggregate_category_counts(rows, dim)
        if 2 <= len(grouped) <= 12:
            return f"{dim}分布", [{"name": k, "value": v} for k, v in grouped]

    # 情况 3：如所有记录均属于同一风险等级（如只查询“高风险”），按年龄段或总分分布统计
    if "年龄" in num_cols:
        buckets: Dict[str, int] = {}
        for row in rows:
            age_val = _to_number(row.get("年龄"))
            if age_val is not None:
                bucket = _age_bucket(age_val)
                buckets[bucket] = buckets.get(bucket, 0) + 1
        if len(buckets) >= 2:
            order = ["45岁以下", "45-59岁", "60-69岁", "70岁及以上"]
            data = [{"name": k, "value": buckets[k]} for k in order if k in buckets]
            return "年龄段人数", data

    if "总分" in num_cols:
        scores: Dict[str, int] = {}
        for row in rows:
            score_val = _to_number(row.get("总分"))
            if score_val is not None:
                key = f"{int(round(score_val))}分"
                scores[key] = scores.get(key, 0) + 1
        if len(scores) >= 2:
            data = [{"name": k, "value": v} for k, v in sorted(scores.items())]
            return "总分分布", data

    # 情况 4：退回首列标签 + 首个数值列（或 table 推导）
    if table and table.get("rows"):
        label_idx = 0
        val_idx = int(table.get("value_column") or 1)
        data = []
        for line in table["rows"][:12]:
            if len(line) > val_idx:
                num = _to_number(line[val_idx])
                if num is not None:
                    data.append({"name": str(line[label_idx]), "value": num})
        if data:
            return str(table.get("value_label") or "数值"), data

    if text_cols:
        grouped = _aggregate_category_counts(rows, text_cols[0])[:12]
        return text_cols[0], [{"name": k, "value": v} for k, v in grouped]

    return "数值", []


def build_graph_echarts_option(
    rows: Sequence[Dict[str, Any]],
    table: Optional[Dict[str, Any]],
    question: str,
    chart_type: str,
    workflow_result: Any = None,
) -> Dict[str, Any]:
    """优先使用工作流返回的有效 ECharts 配置；否则基于查询结果生成可渲染配置。"""
    if workflow_result:
        extracted = extract_echarts_option(workflow_result)
        if extracted:
            return extracted

    title_text = _infer_chart_title(question, chart_type, rows)
    if chart_type == "饼图":
        series_name, pie_data = _pick_pie_series(rows, table)
        return {
            "color": CHART_PALETTE,
            "title": {"text": title_text, "left": "center", "top": 8},
            "tooltip": {"trigger": "item", "formatter": "{b}: {c} ({d}%)"},
            "legend": {"orient": "vertical", "left": 12, "top": 12},
            "series": [
                {
                    "name": series_name,
                    "type": "pie",
                    "radius": "62%",
                    "center": ["54%", "56%"],
                    "data": pie_data,
                    "label": {"formatter": "{b}: {c}"},
                    "emphasis": {
                        "itemStyle": {
                            "shadowBlur": 12,
                            "shadowOffsetX": 0,
                            "shadowColor": "rgba(24, 36, 59, 0.25)",
                        }
                    },
                }
            ],
        }

    # 柱状图 / 折线图
    if not rows:
        return {"title": {"text": title_text, "left": "center"}, "series": []}

    columns = list(rows[0].keys())
    text_cols = [
        col for col in columns
        if not all(_to_number(row.get(col)) is not None for row in rows if row.get(col) is not None)
    ]
    num_cols = [
        col for col in columns
        if all(_to_number(row.get(col)) is not None for row in rows if row.get(col) is not None)
        and any(_to_number(row.get(col)) is not None for row in rows)
    ]

    # 如果没有任何数值列，退化为对首列做计数分布
    if not num_cols:
        dim = text_cols[0] if text_cols else columns[0]
        grouped = _aggregate_category_counts(rows, dim)[:15]
        labels = [item[0] for item in grouped]
        values = [item[1] for item in grouped]
        series_type = "line" if chart_type == "折线图" else "bar"
        series_obj: Dict[str, Any] = {
            "name": "人数",
            "type": series_type,
            "data": values,
        }
        if series_type == "bar":
            series_obj["itemStyle"] = {"borderRadius": [6, 6, 0, 0]}
        else:
            series_obj["smooth"] = True
            series_obj["areaStyle"] = {"opacity": 0.14}
        return {
            "color": CHART_PALETTE,
            "title": {"text": title_text, "left": "center", "top": 8},
            "tooltip": {"trigger": "axis"},
            "grid": {"left": "5%", "right": "5%", "top": 56, "bottom": 36, "containLabel": True},
            "xAxis": {"type": "category", "data": labels, "axisLabel": {"interval": 0}},
            "yAxis": {"type": "value"},
            "series": [series_obj],
        }

    # 优先选 姓名 / 风险等级 / 日期 / 首非数值列 作为 X 轴
    label_col = next(
        (c for c in ["风险等级", "日期", "测评时间", "姓名", "疾病状况", "性别"] if c in text_cols),
        text_cols[0] if text_cols else columns[0],
    )
    limited_rows = list(rows[:20])
    labels = [str(row.get(label_col) or f"#{idx + 1}") for idx, row in enumerate(limited_rows)]
    # 最多画前 3 个数值指标，避免图例过拥挤
    selected_metrics = num_cols[:3]
    series_type = "line" if chart_type == "折线图" else "bar"

    series_list = []
    for metric in selected_metrics:
        values = [_to_number(row.get(metric)) or 0 for row in limited_rows]
        item: Dict[str, Any] = {
            "name": metric,
            "type": series_type,
            "data": values,
        }
        if series_type == "bar":
            item["itemStyle"] = {"borderRadius": [6, 6, 0, 0]}
        else:
            item["smooth"] = True
            item["symbolSize"] = 7
            if len(selected_metrics) == 1:
                item["areaStyle"] = {"opacity": 0.14}
        series_list.append(item)

    option: Dict[str, Any] = {
        "color": CHART_PALETTE,
        "title": {"text": title_text, "left": "center", "top": 8},
        "tooltip": {"trigger": "axis"},
        "grid": {"left": "5%", "right": "5%", "top": 64, "bottom": 36, "containLabel": True},
        "xAxis": {
            "type": "category",
            "data": labels,
            "axisLabel": {"rotate": 20 if len(labels) > 7 else 0},
        },
        "yAxis": {"type": "value"},
        "series": series_list,
    }
    if len(selected_metrics) > 1:
        option["legend"] = {"top": 36}
    return option


def build_analysis_and_summary(
    question: str,
    rows: Sequence[Dict[str, Any]],
    table: Optional[Dict[str, Any]],
    chart_type: str,
) -> Tuple[str, str, Optional[Dict[str, Any]]]:
    """基于真实查询数据生成表格 Markdown、结构化分析结论与总结。"""
    if not rows:
        return "", "没有查询到符合条件的数据，请调整问题后重试。", None

    report = build_report(None, table)
    row_count = len(rows)
    columns = list(rows[0].keys())
    num_cols = [
        col for col in columns
        if all(_to_number(row.get(col)) is not None for row in rows if row.get(col) is not None)
        and any(_to_number(row.get(col)) is not None for row in rows)
    ]

    points: List[str] = []

    # 1. 数据概览
    points.append(
        f"1. **数据概览与统计口径**: 针对问题「{question}」，本次共检索到 **{row_count}** 条有效记录，"
        f"涵盖字段「{'、'.join(columns[:6])}」，图表按「{chart_type}」模式自动生成。"
    )

    # 2. 核心数值统计
    stat_parts: List[str] = []
    for col in num_cols[:3]:
        vals = [_to_number(row.get(col)) for row in rows]
        nums = [v for v in vals if v is not None]
        if not nums:
            continue
        avg_val = sum(nums) / len(nums)
        max_val = max(nums)
        min_val = min(nums)
        if col in ("人数", "数量", "合计", "每日人数") or (table and table.get("share_column", -1) >= 0 and col == table.get("value_label")):
            total_val = sum(nums)
            stat_parts.append(
                f"{col}合计 **{_format_num(total_val)}**（单组最高 {_format_num(max_val)}，最低 {_format_num(min_val)}）"
            )
        else:
            stat_parts.append(
                f"{col}均值 **{_format_num(avg_val)}**（区间 {_format_num(min_val)} ~ {_format_num(max_val)}）"
            )

    if stat_parts:
        points.append(f"2. **核心指标统计**: {'；'.join(stat_parts)}。")

    # 3. 不同风险等级 / 分类分布统计
    if "风险等级" in columns:
        # 如果是汇总数据（带 人数 列），按人数加权；否则按行计数
        count_col = next((c for c in ("人数", "数量", "合计") if c in num_cols), None)
        dist: Dict[str, float] = {}
        for row in rows:
            lvl = str(row.get("风险等级") or "未标注")
            w = _to_number(row.get(count_col)) if count_col else 1.0
            dist[lvl] = dist.get(lvl, 0.0) + (w or 0.0)
        total_people = sum(dist.values()) or 1.0
        dist_desc = "、".join(
            f"{k} {_format_num(v)} 人（{_format_pct(v / total_people)}）"
            for k, v in sorted(dist.items(), key=lambda x: x[1], reverse=True)
        )
        points.append(f"3. **不同风险人群统计**: 不同风险等级分布如上表及图表所示：{dist_desc}。")
    elif report and report.get("summary"):
        points.append(f"3. **分组分布特征**: {report['summary']}")

    # 4. 风险成因与干预建议
    reason_notes: List[str] = []
    if "年龄" in num_cols:
        ages = [v for v in (_to_number(r.get("年龄")) for r in rows) if v is not None]
        if ages:
            elderly = sum(1 for a in ages if a >= 70)
            if elderly > 0:
                reason_notes.append(
                    f"样本中 70 岁及以上高龄人群共 {elderly} 人（占 {_format_pct(elderly / len(ages))}），年龄增长与营养风险呈正相关"
                )
            else:
                reason_notes.append(
                    f"人群年龄分布跨度为 {_format_num(min(ages))}–{_format_num(max(ages))} 岁，平均 {_format_num(sum(ages) / len(ages))} 岁"
                )
    if "总分" in num_cols:
        scores = [v for v in (_to_number(r.get("总分")) for r in rows) if v is not None]
        if scores:
            at_risk = sum(1 for s in scores if s >= 3)
            if at_risk > 0:
                reason_notes.append(
                    f"NRS2002 总分 >= 3 分的需重点干预人群共 {at_risk} 例（占 {_format_pct(at_risk / len(scores))}），建议优先制定个体化营养支持方案并安排复评"
                )
    if not reason_notes and report and report.get("insight"):
        reason_notes.append(report["insight"])
    if not reason_notes:
        reason_notes.append("建议结合患者营养受损评分、疾病严重程度及复评周期持续跟踪变化趋势。")

    points.append(f"4. **问题原因分析与建议**: {'；'.join(reason_notes)}。")

    # 总结
    if report and report.get("summary"):
        summary_text = report["summary"]
    elif "风险等级" in columns and "总分" in num_cols:
        scores = [v for v in (_to_number(r.get("总分")) for r in rows) if v is not None]
        avg_s = _format_num(sum(scores) / len(scores)) if scores else "—"
        summary_text = f"本次共分析 {row_count} 条健康风险测评记录，平均总分 {avg_s} 分，建议对中高风险及高龄重点人群优先开展营养干预与随访。"
    else:
        summary_text = f"本次共返回 {row_count} 条数据记录，已完成数据表格整理、趋势特征总结及{chart_type}可视化渲染。"

    table_md = build_markdown_table(table)
    sections = []
    if table_md:
        sections.append(table_md)
    sections.append("\n\n".join(points))
    sections.append(f"**总结**：{summary_text}")

    analysis_markdown = "\n\n".join(sections)
    return analysis_markdown, summary_text, report


def try_workflow_chart(rows: Sequence[Dict[str, Any]], chart_type: str) -> Any:
    """仅在配置了 DIFY_API_KEY 时尝试调用现有图表工作流；未配置时返回 None 由本地构图器接管。"""
    if not os.getenv("DIFY_API_KEY"):
        return None
    try:
        from app.adapter.workflow_client import execute_workflow

        params = f"{json.dumps(list(rows), ensure_ascii=False, indent=2)} {chart_type}"
        return execute_workflow(params)
    except Exception:
        return None
