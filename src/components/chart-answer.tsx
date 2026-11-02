"use client";

import type { EChartsOption } from "echarts";
import { EChart } from "./echart-view";

/** Payload already processed by FastAPI; this component only renders it. */
type TableCell = string | number;

export type ChartTable = {
  columns: string[];
  rows: TableCell[][];
  value_column: number;
  share_column: number;
  value_label: string;
  label_label: string;
  row_count: number;
  total: number | null;
};

export type ChartReport = {
  metrics: { label: string; value: string; hint: string }[];
  summary: string;
  insight?: string | null;
  insight_tone?: "warn" | "info" | string | null;
};

export type ChartResult = {
  success: boolean;
  question: string;
  chart_type?: string | null;
  generated_sql?: string | null;
  result?: unknown;
  rows?: Record<string, string>[] | null;
  echarts_option?: Record<string, unknown> | null;
  table?: ChartTable | null;
  report?: ChartReport | null;
  title?: string | null;
  subtitle?: string | null;
  error?: string | null;
  execution_time?: number;
};

/** One assistant answer: chart card, data table, insight call-out and report. */
export function ChartAnswer({ result }: { result: ChartResult }) {
  const option = result.echarts_option as EChartsOption | null | undefined;
  const table = result.table;
  const report = result.report;
  const title = result.title || result.question;
  const seconds = typeof result.execution_time === "number" ? result.execution_time.toFixed(2) : null;

  return <div className="ana-result">
    <div className="ana-result-meta">
      <strong>{title}</strong>
      {seconds && <span>SQL 查询耗时 {seconds} 秒</span>}
    </div>

    {option
      ? <section className="ana-card ana-chart-card" aria-label="图表">
        <header className="ana-card-head"><h3>图表</h3><span>{result.subtitle || result.chart_type || ""}</span></header>
        <EChart option={option} label={`图表：${title}`} />
      </section>
      : <div className="ana-error ana-no-option" role="status">
        <strong>未识别到可渲染的 ECharts 配置</strong>
        <p>后端未能从工作流返回中解析出图表配置，可展开下方原始结果检查。</p>
      </div>}

    {table && table.rows.length > 0 && <section className="ana-card" aria-label="表格展示">
      <header className="ana-card-head"><h3>表格展示</h3><span>{table.row_count} 行</span></header>
      <div className="ana-table-wrap">
        <table className="ana-table">
          <thead><tr>{table.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>
            {row.map((cell, cellIndex) => <td key={cellIndex} className={cellIndex === table.value_column || cellIndex === table.share_column ? "num" : ""}>{cell}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </section>}

    {report?.insight && <p className={`ana-insight${report.insight_tone === "warn" ? " warn" : ""}`} role="note">
      <span aria-hidden="true">ⓘ</span>{report.insight}
    </p>}

    {report && <section className="ana-card ana-report" aria-label="智能报告">
      <header className="ana-card-head"><h3><span aria-hidden="true">▤</span> 智能报告</h3><span>基于本次结果自动汇总</span></header>
      <div className="ana-metrics">{report.metrics.map((metric) => <div className="ana-metric" key={metric.label}>
        <span>{metric.label}</span><strong>{metric.value}</strong><em>{metric.hint}</em>
      </div>)}</div>
      <p className="ana-summary">{report.summary}</p>
    </section>}

    <div className="ana-details">
      {result.generated_sql && <details><summary>查看生成的 SQL</summary><pre>{result.generated_sql}</pre></details>}
      <details open={!option}><summary>查看原始结果</summary><pre>{JSON.stringify(result.result, null, 2) ?? "无结果"}</pre></details>
    </div>
  </div>;
}
