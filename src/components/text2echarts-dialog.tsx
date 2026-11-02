"use client";

import { useEffect, useRef, useState } from "react";
import type { EChartsType, EChartsOption } from "echarts";

type Result = { success: boolean; question: string; generated_sql?: string | null; result?: unknown; error?: string | null; execution_time?: number };

// Workflow results may contain a JSON option directly or inside Dify's answer / outputs.
// Deliberately do not evaluate generated JavaScript or formatter functions.
function findOption(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return findOption(JSON.parse(text), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findOption(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (object.series && (Array.isArray(object.series) || typeof object.series === "object")) return object;
  for (const key of ["option", "options", "answer", "outputs", "data", "result", "text"]) {
    const found = findOption(object[key], depth + 1); if (found) return found;
  }
  return null;
}

export function Text2EchartsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chartNode = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const [question, setQuestion] = useState("");
  const [type, setType] = useState("柱状图");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const option = result ? findOption(result.result) : null;
  useEffect(() => {
    if (!open || !option || !chartNode.current) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    import("echarts").then((echarts) => {
      if (disposed || !chartNode.current) return;
      chart.current = echarts.init(chartNode.current);
      try { chart.current.setOption(option as EChartsOption); } catch { setError("图表配置无法渲染，请检查下方原始结果。"); }
      observer = new ResizeObserver(() => chart.current?.resize());
      observer.observe(chartNode.current);
    }).catch(() => setError("图表组件加载失败，请重试。"));
    return () => { disposed = true; observer?.disconnect(); chart.current?.dispose(); chart.current = null; };
    // Result is the stable source for the derived option.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, result]);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/v1/text2echarts/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: question.trim(), echarts_type: type, auto_execute: true, limit: 10 }) });
      const data = await response.json() as Result & { detail?: unknown };
      if (!response.ok || !data.success) throw new Error(data.error || "图表生成失败，请检查服务状态。");
      setResult(data);
    } catch (e) { setError(e instanceof Error ? e.message : "图表生成失败"); }
    finally { setBusy(false); }
  }
  if (!open) return null;
  return <section className="chart-dialog workspace-tool" aria-labelledby="chart-title">
    <header className="chart-header"><div><p className="chart-eyebrow">AI DATA VISUALIZATION</p><h2 id="chart-title">智能图表</h2><p>用自然语言探索数据，快速生成可视化图表。</p></div><button className="icon-btn" type="button" onClick={onClose} aria-label="返回知识文件">←</button></header>
    <div className="chart-body"><form onSubmit={generate} className="chart-form">
      <div className="chart-section-heading"><span className="chart-step">01</span><div><h3>描述分析需求</h3><p>输入你想了解的问题，并选择合适的图表类型。</p></div></div>
      <label className="chart-label" htmlFor="chart-question">分析问题</label><textarea id="chart-question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="例如：统计各风险等级的人数，并按照人数降序排列" required />
      <button className="chart-example" type="button" onClick={() => setQuestion("统计各个风险等级的人数，并按人数从高到低排序")}>试试：统计各风险等级的人数 ↗</button>
      <label className="chart-label" htmlFor="chart-type">图表类型</label><select id="chart-type" value={type} onChange={(e) => setType(e.target.value)}><option>柱状图</option><option>折线图</option><option>饼图</option><option>散点图</option><option>条形图</option></select>
      <button className="btn btn-primary chart-submit" disabled={busy || !question.trim()} type="submit">{busy ? "正在生成图表…" : "✦  生成图表"}</button>
      <p className="chart-hint">生成过程包含 SQL 查询和图表配置生成，可能需要一些时间。请核对生成的 SQL 和结果。</p>
    </form><section className="chart-output" aria-live="polite"><div className="chart-section-heading"><span className="chart-step">02</span><div><h3>可视化结果</h3><p>生成后可在此查看图表及查询详情。</p></div></div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {busy && <div className="chart-empty"><div className="chart-empty-icon">✦</div><strong>正在分析数据</strong><p>正在请求后端服务，请稍候。</p></div>}
      {!busy && !result && !error && <div className="chart-empty"><div className="chart-empty-icon">▥</div><strong>你的图表将在这里呈现</strong><p>输入问题并选择图表类型，开始探索数据。</p></div>}
      {result && <><div className="chart-result-meta"><strong>{result.question}</strong>{typeof result.execution_time === "number" && <span>SQL 查询耗时 {result.execution_time.toFixed(2)} 秒</span>}</div>{option ? <div ref={chartNode} className="chart-canvas" role="img" aria-label={`图表：${result.question}`} /> : <div className="chart-empty chart-no-option"><strong>未识别到可渲染的 ECharts 配置</strong><p>服务可能未返回图表配置，或返回了非 JSON 格式。可展开原始结果检查。</p></div>}
      {result.generated_sql && <details className="chart-details"><summary>查看生成的 SQL</summary><pre>{result.generated_sql}</pre></details>}
      <details className="chart-details" open={!option}><summary>查看原始结果</summary><pre>{JSON.stringify(result.result, null, 2) ?? "无结果"}</pre></details></>}
    </section></div>
  </section>;
}
