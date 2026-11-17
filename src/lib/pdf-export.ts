import type { GraphReport, GraphTable } from "./graph-stream";

export interface PrintableReportInput {
  title?: string;
  question: string;
  chartType?: string;
  executionTime?: number | null;
  table?: GraphTable | null;
  analysisMarkdown?: string;
  summary?: string;
  report?: GraphReport | null;
  chartDataUrl?: string | null;
  generatedAt?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizePdfFilename(question: string): string {
  const cleaned = (question || "")
    .replace(/[\\/:*?"<>|\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned ? `健康数据分析报告-${cleaned}` : "健康数据分析报告";
}

function renderInlineMarkdownToHtml(text: string): string {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens
    .map((part) => {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
      }
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function markdownToPrintableHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return "";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.includes("|") && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const headers = splitMarkdownRow(trimmed);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|")) {
        bodyRows.push(splitMarkdownRow(lines[i]));
        i += 1;
      }
      const headHtml = headers.map((h) => `<th>${renderInlineMarkdownToHtml(h)}</th>`).join("");
      const bodyHtml = bodyRows
        .map(
          (row) =>
            `<tr>${headers.map((_, idx) => `<td>${renderInlineMarkdownToHtml(row[idx] ?? "")}</td>`).join("")}</tr>`,
        )
        .join("");
      out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 2, 6);
      out.push(`<h${level} class="md-h">${renderInlineMarkdownToHtml(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${renderInlineMarkdownToHtml(quoteLines.join(" "))}</blockquote>`);
      continue;
    }

    if (/^(\d+\.\s+|[-*]\s+)/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\d+\.\s+/.test(lines[i].trim()) : /^[-*]\s+/.test(lines[i].trim()))
      ) {
        items.push(lines[i].trim().replace(/^(\d+\.|[-*])\s+/, ""));
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag} class="md-list">${items.map((item) => `<li>${renderInlineMarkdownToHtml(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    const paraLines: string[] = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s+|>\s?|\d+\.\s+|[-*]\s+)/.test(lines[i].trim()) &&
      !(lines[i].trim().includes("|") && i + 1 < lines.length && isSeparatorLine(lines[i + 1]))
    ) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p class="md-p">${renderInlineMarkdownToHtml(paraLines.join(" "))}</p>`);
  }

  return out.join("\n");
}

function buildTableHtml(table: GraphTable | null | undefined): string {
  if (!table || !table.columns.length || !table.rows.length) return "";
  const rowCount = table.row_count ?? table.rows.length;
  const headHtml = table.columns
    .map((col, idx) => {
      const isNum = idx === table.value_column || idx === table.share_column;
      return `<th${isNum ? ' class="num"' : ""}>${escapeHtml(String(col))}</th>`;
    })
    .join("");
  const bodyHtml = table.rows
    .map((row) => {
      const cells = table.columns
        .map((_, idx) => {
          const val = row[idx] ?? "";
          const isNum =
            idx === table.value_column || idx === table.share_column || typeof val === "number";
          return `<td${isNum ? ' class="num"' : ""}>${escapeHtml(String(val))}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `
    <section class="report-section">
      <div class="section-head">
        <h2>数据表格</h2>
        <span>共 ${rowCount} 行</span>
      </div>
      <table>
        <thead><tr>${headHtml}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </section>
  `;
}

export function buildPrintableReportHtml(input: PrintableReportInput): string {
  const reportTitle = escapeHtml(input.title?.trim() || "健康数据分析报告");
  const questionText = escapeHtml(input.question.trim() || "健康数据分析");
  const chartTypeText = input.chartType ? escapeHtml(input.chartType) : "";
  const generatedAt = escapeHtml(
    input.generatedAt || new Date().toLocaleString("zh-CN", { hour12: false }),
  );
  const elapsedText =
    typeof input.executionTime === "number" ? `${input.executionTime.toFixed(2)}s` : "";

  const metricsHtml = input.report?.metrics?.length
    ? `<div class="kpi-grid">${input.report.metrics
        .slice(0, 3)
        .map(
          (m) => `
          <div class="kpi-card">
            <span class="kpi-label">${escapeHtml(m.label)}</span>
            <strong class="kpi-val">${escapeHtml(m.value)}</strong>
            ${m.hint ? `<span class="kpi-detail">${escapeHtml(m.hint)}</span>` : ""}
          </div>
        `,
        )
        .join("")}</div>`
    : "";

  const tableHtml = buildTableHtml(input.table);

  const mdHtml = input.analysisMarkdown ? markdownToPrintableHtml(input.analysisMarkdown) : "";
  const showSummaryCallout =
    Boolean(input.summary) && (!input.analysisMarkdown || !input.analysisMarkdown.includes(input.summary!));
  const summaryHtml = showSummaryCallout
    ? `<div class="summary-box"><strong>分析总结：</strong>${escapeHtml(input.summary || "")}</div>`
    : "";

  const analysisSectionHtml =
    metricsHtml || mdHtml || summaryHtml
      ? `
      <section class="report-section">
        <div class="section-head">
          <h2>分析结论与总结</h2>
        </div>
        ${metricsHtml}
        ${mdHtml ? `<div class="md-wrap">${mdHtml}</div>` : ""}
        ${summaryHtml}
      </section>
    `
      : "";

  const safeChartDataUrl =
    input.chartDataUrl && input.chartDataUrl.startsWith("data:image/") ? input.chartDataUrl : "";
  const chartSectionHtml = safeChartDataUrl
    ? `
      <section class="report-section chart-section">
        <div class="section-head">
          <h2>ECharts 图表展示</h2>
          ${chartTypeText ? `<span>${chartTypeText}</span>` : ""}
        </div>
        <div class="chart-box">
          <img class="chart-img" src="${safeChartDataUrl}" alt="${reportTitle}" />
        </div>
      </section>
    `
    : "";

  const docTitle = escapeHtml(sanitizePdfFilename(input.question));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${docTitle}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 14mm;
    }
    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", -apple-system, BlinkMacSystemFont, sans-serif;
      color: #1b2842;
      background: #ffffff;
      font-size: 12.5px;
      line-height: 1.65;
    }
    .report-shell {
      max-width: 100%;
    }
    .report-header {
      padding: 14px 16px;
      border: 1px solid #dce4f4;
      border-top: 4px solid #5263f3;
      border-radius: 8px;
      background: #f7f9fe;
      margin-bottom: 16px;
    }
    .report-kicker {
      font-size: 11px;
      font-weight: 700;
      color: #4f61e8;
      letter-spacing: 0.04em;
      margin-bottom: 4px;
    }
    .report-header h1 {
      margin: 0 0 8px;
      font-size: 19px;
      line-height: 1.3;
      color: #142038;
    }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 16px;
      font-size: 11.5px;
      color: #55657f;
    }
    .meta-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: #e9efff;
      color: #3f52df;
      font-weight: 600;
    }
    .report-section {
      margin-bottom: 16px;
    }
    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      border-bottom: 1px solid #e2e8f4;
      padding-bottom: 5px;
      margin-bottom: 10px;
    }
    .section-head h2 {
      margin: 0;
      font-size: 14.5px;
      color: #17243d;
    }
    .section-head span {
      font-size: 11px;
      color: #6f7f98;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .kpi-card {
      padding: 8px 10px;
      border: 1px solid #e2e8f5;
      border-radius: 7px;
      background: #f9fbff;
    }
    .kpi-label {
      display: block;
      font-size: 10.5px;
      color: #6b7b94;
    }
    .kpi-val {
      display: block;
      font-size: 16px;
      color: #17243d;
      margin: 2px 0;
    }
    .kpi-detail {
      display: block;
      font-size: 10.5px;
      color: #7c8ca4;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11.5px;
      margin-bottom: 8px;
    }
    thead {
      display: table-header-group;
    }
    tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    th, td {
      padding: 7px 10px;
      border: 1px solid #e1e7f3;
      text-align: left;
      word-break: break-word;
    }
    th {
      background: #f3f6fd;
      color: #3f4f69;
      font-weight: 600;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .md-wrap {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .md-h {
      margin: 6px 0 2px;
      font-size: 13px;
      color: #17243d;
    }
    .md-p {
      margin: 0;
    }
    .md-list {
      margin: 0;
      padding-left: 20px;
    }
    .md-list li {
      margin-bottom: 4px;
    }
    .md-quote {
      margin: 2px 0;
      padding: 6px 10px;
      border-left: 3px solid #5c6ef5;
      background: #f6f8ff;
      color: #495973;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      padding: 1px 4px;
      border-radius: 3px;
      background: #eef2fc;
      color: #3a4ec2;
    }
    .summary-box {
      margin-top: 8px;
      padding: 9px 12px;
      border: 1px solid #d9e3fb;
      border-radius: 7px;
      background: #f4f7ff;
      color: #223454;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .chart-section {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .chart-box {
      border: 1px solid #e2e8f4;
      border-radius: 8px;
      padding: 10px;
      text-align: center;
      background: #ffffff;
    }
    .chart-img {
      max-width: 100%;
      max-height: 360px;
      width: auto;
      height: auto;
      display: inline-block;
    }
  </style>
</head>
<body>
  <main class="report-shell">
    <header class="report-header">
      <div class="report-kicker">健康数据分析智能体 · LangGraph 主管模式报告</div>
      <h1>${reportTitle}</h1>
      <div class="meta-row">
        <span><strong>分析问题：</strong>${questionText}</span>
        ${chartTypeText ? `<span class="meta-pill">${chartTypeText}</span>` : ""}
        ${elapsedText ? `<span><strong>耗时：</strong>${elapsedText}</span>` : ""}
        <span><strong>导出时间：</strong>${generatedAt}</span>
      </div>
    </header>
    ${tableHtml}
    ${analysisSectionHtml}
    ${chartSectionHtml}
  </main>
</body>
</html>`;
}

function waitForImages(doc: Document, timeoutMs = 1500): Promise<void> {
  const images = Array.from(doc.querySelectorAll("img"));
  if (images.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let remaining = images.length;
    const done = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
    };
    const timer = setTimeout(resolve, timeoutMs);
    for (const img of images) {
      if (img.complete) {
        done();
      } else {
        img.addEventListener("load", () => {
          clearTimeout(timer);
          done();
        }, { once: true });
        img.addEventListener("error", () => {
          clearTimeout(timer);
          done();
        }, { once: true });
      }
    }
  });
}

export async function exportAnalysisReportPdf(input: PrintableReportInput): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("PDF 导出仅可在浏览器环境中使用。");
  }

  const html = buildPrintableReportHtml(input);
  const suggestedTitle = sanitizePdfFilename(input.question);
  const originalTitle = document.title;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";

  document.body.appendChild(iframe);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    document.title = originalTitle;
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };

  try {
    const win = iframe.contentWindow;
    const doc = win?.document || iframe.contentDocument;
    if (!win || !doc) {
      throw new Error("无法创建打印视图");
    }

    doc.open();
    doc.write(html);
    doc.close();

    await waitForImages(doc);

    document.title = suggestedTitle;
    win.addEventListener("afterprint", cleanup, { once: true });
    window.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(cleanup, 60_000);

    win.focus();
    win.print();
  } catch {
    cleanup();
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) {
      throw new Error("浏览器拦截了导出窗口，请允许弹窗或使用浏览器打印保存为 PDF。");
    }
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.focus();
    popup.print();
  }
}
