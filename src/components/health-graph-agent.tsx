"use client";

import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption, EChartsType } from "echarts";
import { EChart } from "./echart-view";
import {
  consumeGraphGenerateStream,
  createInitialGraphState,
  parseQuestionChartHint,
  type GraphStreamState,
  type GraphTable,
} from "@/lib/graph-stream";
import { exportAnalysisReportPdf } from "@/lib/pdf-export";

const MAX_QUESTION = 300;
const CHART_TYPES = ["柱状图", "折线图", "饼图"] as const;
type GraphChartType = (typeof CHART_TYPES)[number];

const QUICK_EXAMPLES = [
  "查询高风险",
  "查询高风险(饼图)",
  "统计各个风险等级的人数(柱状图)",
  "最近 7 天每日测评人数趋势(折线图)",
];

function renderInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={idx}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function stripLeadingMarkdownTable(markdown: string): string {
  const lines = markdown.trim().split("\n");
  if (lines.length < 2) return markdown;
  if (!lines[0].trim().includes("|") || !isTableSeparatorLine(lines[1])) {
    return markdown;
  }
  let idx = 2;
  while (idx < lines.length && lines[idx].trim().includes("|")) {
    idx += 1;
  }
  while (idx < lines.length && (!lines[idx].trim() || lines[idx].trim().startsWith("> 注："))) {
    idx += 1;
  }
  return lines.slice(idx).join("\n").trim();
}

function MarkdownView({ content }: { content: string }) {
  const blocks = useMemo(() => {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const nodes: ReactNode[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      // Markdown 表格
      if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
        const headers = splitTableRow(trimmed);
        i += 2;
        const bodyRows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes("|")) {
          bodyRows.push(splitTableRow(lines[i]));
          i += 1;
        }
        nodes.push(
          <div className="hg-table-wrap" key={`tbl-${i}`}>
            <table className="hg-table">
              <thead>
                <tr>
                  {headers.map((head, hIdx) => (
                    <th key={hIdx} scope="col">{renderInlineMarkdown(head)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bodyRows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {headers.map((_, cIdx) => (
                      <td key={cIdx}>{renderInlineMarkdown(row[cIdx] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }

      // 标题
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const text = headingMatch[2];
        const HeadingTag = level <= 2 ? "h4" : "h5";
        nodes.push(<HeadingTag className="hg-md-heading" key={`h-${i}`}>{renderInlineMarkdown(text)}</HeadingTag>);
        i += 1;
        continue;
      }

      // 引用块
      if (trimmed.startsWith(">")) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        nodes.push(
          <blockquote className="hg-md-quote" key={`q-${i}`}>
            {renderInlineMarkdown(quoteLines.join(" "))}
          </blockquote>,
        );
        continue;
      }

      // 列表（有序 / 无序）
      if (/^(\d+\.\s+|[-*]\s+)/.test(trimmed)) {
        const ordered = /^\d+\.\s+/.test(trimmed);
        const listItems: string[] = [];
        while (i < lines.length && (ordered ? /^\d+\.\s+/.test(lines[i].trim()) : /^[-*]\s+/.test(lines[i].trim()))) {
          listItems.push(lines[i].trim().replace(/^(\d+\.|[-*])\s+/, ""));
          i += 1;
        }
        const ListTag = ordered ? "ol" : "ul";
        nodes.push(
          <ListTag className="hg-md-list" key={`list-${i}`}>
            {listItems.map((item, idx) => (
              <li key={idx}>{renderInlineMarkdown(item)}</li>
            ))}
          </ListTag>,
        );
        continue;
      }

      // 普通段落
      const paraLines: string[] = [trimmed];
      i += 1;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4}\s+|>\s?|\d+\.\s+|[-*]\s+)/.test(lines[i].trim()) &&
        !(lines[i].trim().includes("|") && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
      ) {
        paraLines.push(lines[i].trim());
        i += 1;
      }
      nodes.push(
        <p className="hg-md-p" key={`p-${i}`}>
          {renderInlineMarkdown(paraLines.join(" "))}
        </p>,
      );
    }

    return nodes;
  }, [content]);

  return <div className="hg-md-body">{blocks}</div>;
}

function StructuredTableCard({ table }: { table: GraphTable }) {
  const rowCount = table.row_count ?? table.rows.length;
  return (
    <section className="hg-section-block" aria-label="数据表格">
      <div className="hg-subhead">
        <h3>数据表格</h3>
        <span>共 {rowCount} 行</span>
      </div>
      <div className="hg-table-wrap">
        <table className="hg-table">
          <thead>
            <tr>
              {table.columns.map((col, idx) => {
                const isNum = idx === table.value_column || idx === table.share_column;
                return (
                  <th key={`${col}-${idx}`} scope="col" className={isNum ? "num" : ""}>
                    {col}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rIdx) => (
              <tr key={rIdx}>
                {table.columns.map((_, cIdx) => {
                  const cell = row[cIdx] ?? "";
                  const isNum =
                    cIdx === table.value_column ||
                    cIdx === table.share_column ||
                    typeof cell === "number";
                  return (
                    <td key={cIdx} className={isNum ? "num" : ""}>
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function HealthGraphAgent({
  open = true,
  onClose,
}: {
  open?: boolean;
  onClose?: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [selectedChartType, setSelectedChartType] = useState<GraphChartType>("柱状图");
  const [streamState, setStreamState] = useState<GraphStreamState>(() => createInitialGraphState());
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const processBoxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chartInstanceRef = useRef<EChartsType | null>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);

  const isStreaming = streamState.status === "streaming";

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    const box = processBoxRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [streamState.steps, streamState.status]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleQuestionChange = useCallback((nextValue: string) => {
    setQuestion(nextValue);
    const { chartType: hinted } = parseQuestionChartHint(nextValue);
    if (hinted && (CHART_TYPES as readonly string[]).includes(hinted)) {
      setSelectedChartType(hinted as GraphChartType);
    }
  }, []);

  const handleSelectChartType = useCallback((nextType: GraphChartType) => {
    setSelectedChartType(nextType);
    setQuestion((prev) => {
      const { cleanQuestion, chartType: hinted } = parseQuestionChartHint(prev);
      if (hinted && cleanQuestion) {
        return `${cleanQuestion}(${nextType})`;
      }
      return prev;
    });
  }, []);

  const runAnalysis = useCallback(async (rawInput: string, chartTypeOverride?: GraphChartType) => {
    const trimmed = rawInput.trim();
    if (!trimmed || isStreaming) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const { chartType: hinted } = parseQuestionChartHint(trimmed);
    const effectiveChartType =
      chartTypeOverride ??
      ((hinted && (CHART_TYPES as readonly string[]).includes(hinted) ? hinted : selectedChartType) as GraphChartType);

    const initial: GraphStreamState = {
      ...createInitialGraphState(trimmed),
      status: "streaming",
      chartType: effectiveChartType,
    };
    setExportError("");
    setStreamState(initial);

    try {
      const payload: Record<string, unknown> = {
        question: trimmed,
        echarts_type: effectiveChartType,
        stream: true,
        auto_execute: true,
        limit: 20,
      };

      const response = await fetch("/api/v1/graph/graph_generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      await consumeGraphGenerateStream(response, initial, (nextState) => {
        if (!controller.signal.aborted) {
          setStreamState(nextState);
        }
      });
    } catch (caught) {
      if (controller.signal.aborted) {
        setStreamState((prev) => ({
          ...prev,
          status: prev.analysisMarkdown || prev.echartsOption ? "done" : "idle",
        }));
        return;
      }
      const message = caught instanceof Error ? caught.message : "分析请求失败，请稍后重试。";
      setStreamState((prev) => ({
        ...prev,
        status: "error",
        error: message,
      }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [isStreaming, selectedChartType]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setStreamState(createInitialGraphState());
    setQuestion("");
    setSelectedChartType("柱状图");
    setExportError("");
    inputRef.current?.focus();
  }, []);

  const displayMarkdown = useMemo(() => {
    if (!streamState.analysisMarkdown) return "";
    if (streamState.table && streamState.table.rows.length > 0) {
      return stripLeadingMarkdownTable(streamState.analysisMarkdown);
    }
    return streamState.analysisMarkdown;
  }, [streamState.analysisMarkdown, streamState.table]);

  const showSeparateSummary = useMemo(() => {
    if (!streamState.summary) return false;
    if (!displayMarkdown) return true;
    return !displayMarkdown.includes(streamState.summary);
  }, [displayMarkdown, streamState.summary]);

  const hasAnyResult =
    Boolean(streamState.table?.rows.length) ||
    Boolean(displayMarkdown) ||
    Boolean(streamState.summary) ||
    Boolean(streamState.report) ||
    Boolean(streamState.echartsOption);

  const handleExportPdf = useCallback(async () => {
    if (!hasAnyResult || isStreaming || exportingPdf) return;
    setExportError("");
    setExportingPdf(true);
    try {
      let chartDataUrl: string | null = null;
      if (chartInstanceRef.current) {
        try {
          chartDataUrl = chartInstanceRef.current.getDataURL({
            type: "png",
            pixelRatio: 2,
            backgroundColor: "#ffffff",
          });
        } catch {
          chartDataUrl = null;
        }
      }
      if (!chartDataUrl && chartWrapRef.current) {
        const canvas = chartWrapRef.current.querySelector("canvas");
        if (canvas) {
          try {
            chartDataUrl = canvas.toDataURL("image/png");
          } catch {
            chartDataUrl = null;
          }
        }
      }

      await exportAnalysisReportPdf({
        title: streamState.title || streamState.question || "健康数据分析报告",
        question: streamState.question || question,
        chartType: streamState.chartType || selectedChartType,
        executionTime: streamState.executionTime,
        table: streamState.table,
        analysisMarkdown: displayMarkdown,
        summary: streamState.summary,
        report: streamState.report,
        chartDataUrl,
      });
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "导出 PDF 失败，请稍后重试。");
    } finally {
      setExportingPdf(false);
    }
  }, [
    displayMarkdown,
    exportingPdf,
    hasAnyResult,
    isStreaming,
    question,
    selectedChartType,
    streamState.chartType,
    streamState.executionTime,
    streamState.question,
    streamState.report,
    streamState.summary,
    streamState.table,
    streamState.title,
  ]);

  if (!open) return null;

  return (
    <section className="hg-shell workspace-tool" aria-labelledby="hg-title">
      <header className="hg-topbar">
        <div className="hg-title-group">
          <h2 id="hg-title">健康数据分析智能体</h2>
          <p>左侧输入与思考过程，右侧图表结果。</p>
        </div>
        <div className="hg-badges">
          <span className="hg-badge hg-badge-sse">
            <i aria-hidden="true" />
            SSE 流式输出
          </span>
          <span className="hg-badge hg-badge-supervisor">LangGraph 主管模式</span>
          <span className="hg-badge hg-badge-chart">图表自动渲染</span>
          {(hasAnyResult || streamState.steps.length > 0) && (
            <button
              type="button"
              className="btn btn-quiet hg-clear-btn"
              onClick={handleReset}
              disabled={isStreaming}
            >
              清空
            </button>
          )}
          {onClose && (
            <button
              className="icon-btn"
              type="button"
              onClick={onClose}
              aria-label="返回知识文件"
            >
              ←
            </button>
          )}
        </div>
      </header>

      <div className="hg-grid">
        {/* 左侧：流式输出业务执行流程 + 提问输入 */}
        <div className="hg-card hg-left-card">
          <div className="hg-card-head">
            <h3>思考过程</h3>
            {isStreaming && <span className="hg-live-tag">流式执行中…</span>}
            {streamState.status === "done" && <span className="hg-done-tag">已完成</span>}
          </div>

          <div className="hg-left-body">
            <div className="hg-process-panel">
              <div className="hg-process-title">思考过程</div>
              <div
                ref={processBoxRef}
                className="hg-process-log"
                role="log"
                aria-live="polite"
                aria-label="业务执行流程"
              >
                {streamState.steps.length === 0 ? (
                  <p className="hg-process-placeholder">
                    等待输入分析问题，点击「开始分析」后将在此实时流式展示 SQL 生成、查询、数据格式化、分析结论与 ECharts 配置生成过程。
                  </p>
                ) : (
                  <ul className="hg-step-list">
                    {streamState.steps.map((step, index) => {
                      const isCurrent = isStreaming && index === streamState.steps.length - 1;
                      return (
                        <li
                          key={step.id}
                          className={`hg-step-item${isCurrent ? " is-active" : ""}`}
                        >
                          <span className="hg-step-text">{step.text}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <form
              className="hg-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runAnalysis(question);
              }}
            >
              <div className="hg-textarea-wrap">
                <label className="sr-only" htmlFor="hg-question-input">
                  输入健康数据分析问题
                </label>
                <textarea
                  id="hg-question-input"
                  ref={inputRef}
                  rows={3}
                  maxLength={MAX_QUESTION}
                  value={question}
                  placeholder="请输入问题，例如：查询高风险(饼图)"
                  onChange={(event) => handleQuestionChange(event.target.value)}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey) return;
                    if (composingRef.current || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    void runAnalysis(question);
                  }}
                />
                <span className={`hg-counter${question.length >= MAX_QUESTION ? " is-full" : ""}`}>
                  {question.length} / {MAX_QUESTION}
                </span>
              </div>

              <div className="hg-chart-picker-row">
                <span className="hg-picker-label">图表类型</span>
                <div className="hg-type-picker" role="group" aria-label="图表类型">
                  {CHART_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={`hg-type-pill${selectedChartType === type ? " on" : ""}`}
                      aria-pressed={selectedChartType === type}
                      disabled={isStreaming}
                      onClick={() => handleSelectChartType(type)}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              <p className="hg-format-hint">
                可点击上方选择图表类型，或直接输入：问题(图表类型)，例如 查询高风险(饼图)
              </p>

              <div className="hg-form-actions">
                <button
                  type="submit"
                  className="hg-submit-btn"
                  disabled={isStreaming || !question.trim()}
                >
                  {isStreaming ? "分析中…" : "开始分析"}
                </button>
                {isStreaming && (
                  <button
                    type="button"
                    className="btn btn-line hg-stop-btn"
                    onClick={handleCancel}
                  >
                    停止
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        {/* 右侧：最终结果（表格 + 分析与总结 + ECharts 图表） */}
        <div className="hg-card hg-right-card">
          <div className="hg-card-head hg-right-head">
            <h3>最终结果</h3>
            <div className="hg-right-actions">
              {streamState.chartType && (
                <span className="hg-result-meta">
                  {streamState.chartType}
                  {streamState.executionTime != null ? ` · ${streamState.executionTime.toFixed(2)}s` : ""}
                </span>
              )}
              {hasAnyResult && (
                <button
                  type="button"
                  className="hg-export-btn"
                  onClick={() => void handleExportPdf()}
                  disabled={isStreaming || exportingPdf}
                >
                  {exportingPdf ? "导出中…" : "导出 PDF"}
                </button>
              )}
            </div>
          </div>

          <div className="hg-right-body">
            {exportError && (
              <div className="hg-export-warn" role="status">
                <span>{exportError}</span>
              </div>
            )}
            {streamState.status === "idle" && !hasAnyResult && !streamState.error && (
              <div className="hg-empty">
                <div className="hg-empty-icon" aria-hidden="true">❖</div>
                <strong>准备就绪，等待分析提问</strong>
                <p>提交问题后，这里将依次输出数据表格、AI 分析与总结，以及可交互的 ECharts 图表。</p>
                <div className="hg-examples">
                  {QUICK_EXAMPLES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="hg-example-chip"
                      onClick={() => {
                        handleQuestionChange(item);
                        inputRef.current?.focus();
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {streamState.error && (
              <div className="hg-error" role="alert">
                <strong>分析未能完成</strong>
                <p>{streamState.error}</p>
                <button
                  type="button"
                  className="btn btn-line"
                  onClick={() => void runAnalysis(streamState.question || question)}
                  disabled={isStreaming || !(streamState.question || question).trim()}
                >
                  重新分析
                </button>
              </div>
            )}

            {(hasAnyResult || isStreaming) && !streamState.error && (
              <div className="hg-result-stack">
                {/* 表格与总结结论区域 */}
                <div className="hg-answer-panel">
                  {isStreaming && !streamState.table && !displayMarkdown && !streamState.summary && (
                    <div className="hg-loading-inline" role="status">
                      <span className="loading-ring" aria-hidden="true" />
                      <span>正在查询数据并生成表格与分析总结…</span>
                    </div>
                  )}

                  {streamState.table && streamState.table.rows.length > 0 && (
                    <StructuredTableCard table={streamState.table} />
                  )}

                  {streamState.report && streamState.report.metrics.length > 0 && (
                    <div className="hg-kpi-row" aria-label="关键指标">
                      {streamState.report.metrics.map((m) => (
                        <div className="hg-kpi" key={m.label}>
                          <span>{m.label}</span>
                          <strong>{m.value}</strong>
                          <em>{m.hint}</em>
                        </div>
                      ))}
                    </div>
                  )}

                  {displayMarkdown && <MarkdownView content={displayMarkdown} />}

                  {showSeparateSummary && (
                    <div className="hg-summary-callout">
                      <strong>总结：</strong>
                      <span>{streamState.summary}</span>
                    </div>
                  )}
                </div>

                {/* ECharts 图表区域 */}
                <div className="hg-chart-section">
                  <div className="hg-subhead">
                    <h3>ECharts 图表</h3>
                    {streamState.subtitle && <span>{streamState.subtitle}</span>}
                  </div>
                  <div className="hg-chart-card" ref={chartWrapRef}>
                    {streamState.echartsOption ? (
                      <EChart
                        option={streamState.echartsOption as EChartsOption}
                        label={`健康分析图表：${streamState.title || streamState.question}`}
                        onChartReady={(inst) => {
                          chartInstanceRef.current = inst;
                        }}
                      />
                    ) : isStreaming ? (
                      <div className="hg-chart-waiting" role="status">
                        <span className="loading-ring" aria-hidden="true" />
                        <span>正在生成 ECharts 图表配置…</span>
                      </div>
                    ) : (
                      <p className="hg-chart-empty">本次响应未包含可渲染的图表配置。</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
