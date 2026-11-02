"use client";

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "./echart-view";
import { extractEchartsOption } from "@/lib/echarts-option";
import { buildChartReport, buildChartTable, chartTitle, seriesLabels } from "@/lib/chart-insight";

export type ChartResult = {
  success: boolean;
  question: string;
  generated_sql?: string | null;
  result?: unknown;
  rows?: Record<string, string>[] | null;
  error?: string | null;
  execution_time?: number;
};

/** One assistant answer: chart card, data table, insight call-out and report. */
export function ChartAnswer({ result }: { result: ChartResult }) {
  const option = useMemo(() => extractEchartsOption(result.result) as EChartsOption | null, [result]);
  const table = useMemo(() => buildChartTable(option || {}, result.rows), [option, result.rows]);
  const report = useMemo(() => buildChartReport(option, table), [option, table]);
  const title = chartTitle(option);
  const series = seriesLabels(option).join(" / ");
  const seconds = typeof result.execution_time === "number" ? result.execution_time.toFixed(2) : null;

  return <div className="ana-result">
    <div className="ana-result-meta">
      <strong>{title || result.question}</strong>
      {seconds && <span>SQL 查询耗时 {seconds} 秒</span>}
    </div>

    {option
      ? <section className="ana-card ana-chart-card" aria-label="图表">
        <header className="ana-card-head"><h3>图表</h3><span>{series || result.question}</span></header>
        <EChart option={option} label={`图表：${title || result.question}`} />
      </section>
      : <div className="ana-error ana-no-option" role="status">
        <strong>未识别到可渲染的 ECharts 配置</strong>
        <p>服务可能未返回图表配置，或返回了非 JSON 格式。可展开下方原始结果检查。</p>
      </div>}

    {table && <section className="ana-card" aria-label="表格展示">
      <header className="ana-card-head"><h3>表格展示</h3><span>{table.rows.length} 行</span></header>
      <div className="ana-table-wrap">
        <table className="ana-table">
          <thead><tr>{table.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>
            {row.map((cell, cellIndex) => <td key={cellIndex} className={cellIndex === table.valueColumn || cellIndex === table.shareColumn ? "num" : ""}>{cell}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </section>}

    {report?.insight && <p className={`ana-insight${report.insightTone === "warn" ? " warn" : ""}`} role="note">
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
