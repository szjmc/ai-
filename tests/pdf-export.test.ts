import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrintableReportHtml,
  escapeHtml,
  markdownToPrintableHtml,
  sanitizePdfFilename,
} from "../src/lib/pdf-export";

test("sanitizePdfFilename keeps readable Chinese question and strips unsafe path characters", () => {
  assert.equal(sanitizePdfFilename("查询高风险(饼图)"), "健康数据分析报告-查询高风险(饼图)");
  assert.equal(sanitizePdfFilename('a/b\\c:d*e?"<>|'), "健康数据分析报告-a b c d e");
  assert.equal(sanitizePdfFilename("   "), "健康数据分析报告");
});

test("escapeHtml and markdownToPrintableHtml escape XSS payloads while formatting Markdown", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");

  const mdHtml = markdownToPrintableHtml(
    "### 核心发现\n1. 高风险 **14人** `<script>bad</script>`\n\n> 重点随访\n\n**总结**：需要关注。",
  );
  assert.doesNotMatch(mdHtml, /<script>/);
  assert.match(mdHtml, /<ol class="md-list">/);
  assert.match(mdHtml, /<strong>14人<\/strong>/);
  assert.match(mdHtml, /<blockquote class="md-quote">重点随访<\/blockquote>/);
});

test("buildPrintableReportHtml includes title, table, metrics, summary, and chart image safely", () => {
  const html = buildPrintableReportHtml({
    title: "营养风险等级分布统计",
    question: "查询高风险(饼图)",
    chartType: "饼图",
    executionTime: 0.42,
    generatedAt: "2026-11-16 10:00:00",
    report: {
      metrics: [
        { label: "总人数", value: "50", hint: "3 个等级" },
        { label: "高风险", value: "14", hint: "占比 28%" },
      ],
      summary: "高风险占比 28%。",
      insight: "建议重点干预。",
      insight_tone: "warn",
    },
    table: {
      columns: ["风险等级", "人数", "占比"],
      rows: [
        ["高风险", 14, "28%"],
        ["中风险", 11, "22%"],
        ["低风险", 25, "50%"],
      ],
      value_column: 1,
      share_column: 2,
      row_count: 3,
    },
    analysisMarkdown: "### 核心发现\n1. 高风险占比 28%。\n\n**总结**：建议优先介入。",
    summary: "高风险占比 28%，建议优先介入。",
    chartDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  });

  assert.match(html, /@page\s*\{\s*size:\s*A4 portrait/);
  assert.match(html, /营养风险等级分布统计/);
  assert.match(html, /查询高风险\(饼图\)/);
  assert.match(html, /饼图/);
  assert.match(html, /0\.42s/);
  assert.match(html, /<th>风险等级<\/th>/);
  assert.match(html, /<td>高风险<\/td>/);
  assert.match(html, /<img class="chart-img" src="data:image\/png;base64,iVBORw0KGgoAAAANSUhEUg=="/);
  assert.match(html, /建议优先介入/);

  // Reject unsafe non-image URLs in chartDataUrl
  const unsafeHtml = buildPrintableReportHtml({
    question: "测试",
    chartDataUrl: "javascript:alert(1)",
  });
  assert.doesNotMatch(unsafeHtml, /javascript:/);
});
