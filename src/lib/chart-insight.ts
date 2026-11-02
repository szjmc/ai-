import type { EChartsOption } from "echarts";

/** A single rendered table cell. */
export type TableCell = string | number;

export type ChartTable = {
  columns: string[];
  rows: TableCell[][];
  /** Index of the column holding the measure used for shares / report metrics. */
  valueColumn: number;
  /** Index of the "占比" column when it was derived, otherwise -1. */
  shareColumn: number;
  valueLabel: string;
  labelLabel: string;
};

export type ReportMetric = { label: string; value: string; hint: string };

export type ChartReport = {
  metrics: ReportMetric[];
  /** One-sentence reading of the numbers, arithmetic only (no model guessing). */
  summary: string;
  /** Call-out shown above the report when the data hints at a priority. */
  insight: string | null;
  insightTone: "warn" | "info";
};

type JsonObject = Record<string, unknown>;

const HIGH_RISK_LABEL = /高风险|高危|high[-_\s]?risk/i;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,%\s]/g, ""));
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("zh-CN") : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function share(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

export function formatPercent(value: number): string {
  const percent = value * 100;
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** Table built from the SQL result rows the backend returns alongside the chart. */
function tableFromRows(rows: JsonObject[]): ChartTable | null {
  const sample = rows.find((row) => Object.keys(row).length > 0);
  if (!sample) return null;
  const columns = Object.keys(sample).slice(0, 8);
  if (!columns.length) return null;
  const numeric = columns.filter((column) => rows.every((row) => toNumber(row[column]) !== null));
  const values: TableCell[][] = rows.map((row) => columns.map((column) => (
    numeric.includes(column) ? Number(toNumber(row[column]) ?? 0) : String(row[column] ?? "")
  )));
  const valueColumn = numeric.length ? columns.indexOf(numeric[0]) : 1;
  const singleMeasure = numeric.length === 1;
  const nextColumns = singleMeasure ? [...columns, "占比"] : columns;
  const total = singleMeasure ? values.reduce((sum, row) => sum + Number(row[valueColumn] || 0), 0) : 0;
  const finalRows = values.map((row) => (singleMeasure ? [...row, formatPercent(share(Number(row[valueColumn] || 0), total))] : row));
  return {
    columns: nextColumns,
    rows: finalRows,
    valueColumn,
    shareColumn: singleMeasure ? nextColumns.length - 1 : -1,
    valueLabel: numeric[0] || "数值",
    labelLabel: columns.find((column) => !numeric.includes(column)) || columns[0],
  };
}

function seriesItems(option: EChartsOption): { labels: string[]; series: { name: string; values: number[] }[] } {
  const optionObject = option as JsonObject;
  const axis = asArray(optionObject.xAxis).find(isObject);
  const axisData = asArray(axis?.data).map((item) => String(item));
  const seriesList = asArray(optionObject.series).filter(isObject);
  const result: { name: string; values: number[] }[] = [];
  let pieLabels: string[] | null = null;

  seriesList.forEach((series, index) => {
    const name = typeof series.name === "string" && series.name.trim() ? series.name : `系列 ${index + 1}`;
    const values: number[] = [];
    for (const item of asArray(series.data)) {
      if (isObject(item)) {
        if (series.type === "pie" && typeof item.name === "string") {
          pieLabels = pieLabels || [];
          (pieLabels as string[]).push(item.name);
        }
        values.push(toNumber(item.value) ?? 0);
      } else {
        values.push(toNumber(item) ?? 0);
      }
    }
    result.push({ name, values });
  });

  const labels = axisData.length ? axisData : pieLabels || [];
  return { labels, series: result };
}

/** Table derived from the chart option when the backend did not return rows. */
function tableFromOption(option: EChartsOption): ChartTable | null {
  const { labels, series } = seriesItems(option);
  const usable = series.filter((item) => item.values.length);
  if (!labels.length || !usable.length) return null;
  const single = usable.length === 1;
  const rows: TableCell[][] = labels.map((label, index) => [
    label,
    ...usable.map((item) => item.values[index] ?? 0),
  ]);
  if (single) {
    const total = rows.reduce((sum, row) => sum + Number(row[1] || 0), 0);
    rows.forEach((row) => row.push(formatPercent(share(Number(row[1] || 0), total))));
  }
  return {
    columns: ["分组", ...usable.map((item) => item.name), ...(single ? ["占比"] : [])],
    rows,
    valueColumn: 1,
    shareColumn: single ? 2 : -1,
    valueLabel: usable[0].name,
    labelLabel: "分组",
  };
}

/**
 * Prefers the real SQL rows (they keep the database's own order and labels) and
 * falls back to reading the numbers back out of the ECharts option.
 */
export function buildChartTable(option: EChartsOption, rows?: unknown): ChartTable | null {
  const list = asArray(rows).filter(isObject);
  if (list.length) {
    const fromRows = tableFromRows(list);
    if (fromRows) return fromRows;
  }
  return tableFromOption(option);
}

function metricFor(table: ChartTable): ChartReport | null {
  if (!table.rows.length) return null;
  const labelIndex = 0;
  const valueIndex = table.valueColumn;
  const entries = table.rows
    .map((row) => ({ label: String(row[labelIndex] ?? ""), value: Number(row[valueIndex] || 0) }))
    .filter((entry) => Number.isFinite(entry.value));
  if (!entries.length) return null;

  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.value), 0);
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  const groups = entries.length;
  const topShare = share(top.value, total);
  const bottomShare = share(bottom.value, total);

  const metrics: ReportMetric[] = [
    { label: "样本合计", value: formatCount(total), hint: `覆盖 ${groups} 个分组` },
    { label: "占比最高", value: formatPercent(topShare), hint: `${top.label || "—"} · ${formatCount(top.value)}` },
    groups > 1
      ? { label: "差距", value: formatPercent(topShare - bottomShare), hint: `最高 ${top.label} / 最低 ${bottom.label}` }
      : { label: "分组", value: "1", hint: "仅一个分组，无法比较" },
  ];

  const summary = groups > 1
    ? `本次共统计 ${groups} 个分组、${formatCount(total)} 条记录。${top.label} 最多，为 ${formatCount(top.value)}（${formatPercent(topShare)}）；${bottom.label} 最少，为 ${formatCount(bottom.value)}（${formatPercent(bottomShare)}）。`
    : `本次共统计 1 个分组、${formatCount(total)} 条记录：${top.label || "—"}。`;

  const risky = entries.filter((entry) => HIGH_RISK_LABEL.test(entry.label));
  const riskyTotal = risky.reduce((sum, entry) => sum + Math.max(0, entry.value), 0);
  const riskyShare = share(riskyTotal, total);
  let insight: string | null = null;
  let insightTone: "warn" | "info" = "info";
  if (risky.length && risky.length < entries.length && riskyShare >= 0.2) {
    insight = `${risky.map((entry) => entry.label).join("、")}合计 ${formatCount(riskyTotal)} 条，占 ${formatPercent(riskyShare)}，建议优先安排风险评估与随访管理策略。`;
    insightTone = "warn";
  } else if (groups > 1 && topShare >= 0.4) {
    insight = `${top.label}占比 ${formatPercent(topShare)}，明显高于其他分组，可作为本轮干预与资源投放的重点。`;
  }

  return { metrics, summary, insight, insightTone };
}

export function buildChartReport(option: EChartsOption | null, table: ChartTable | null): ChartReport | null {
  if (!table) return null;
  return metricFor(table);
}

/** Series names, used as the subtitle of the chart card. */
export function seriesLabels(option: EChartsOption | null): string[] {
  if (!option) return [];
  return asArray((option as JsonObject).series)
    .filter(isObject)
    .map((series, index) => (typeof series.name === "string" && series.name.trim() ? series.name : `系列 ${index + 1}`));
}

/** `title.text` of the option, used as the chart card heading. */
export function chartTitle(option: EChartsOption | null): string {
  if (!option) return "";
  const raw = (option as JsonObject).title;
  const title = asArray(raw).find(isObject);
  const text = typeof title?.text === "string" ? title.text : typeof raw === "string" ? raw : "";
  return text.trim();
}
