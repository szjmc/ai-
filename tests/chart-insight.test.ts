import assert from "node:assert/strict";
import test from "node:test";
import type { EChartsOption } from "echarts";
import { buildChartReport, buildChartTable, chartTitle } from "../src/lib/chart-insight";

const OPTION = {
  title: { text: "营养风险等级统计", left: "center" },
  xAxis: { type: "category", data: ["低风险", "高风险", "中风险"] },
  yAxis: { type: "value", name: "数量" },
  series: [{ name: "数量", type: "bar", data: [25, 14, 11] }],
} as EChartsOption;

test("builds the table from the SQL rows the backend returns", () => {
  const rows = [
    { disease_type: "肿瘤", high_risk: "16" },
    { disease_type: "慢性病急性发作", high_risk: "33" },
  ];
  const table = buildChartTable(OPTION, rows);
  assert.ok(table);
  assert.deepEqual(table.columns, ["disease_type", "high_risk", "占比"]);
  assert.deepEqual(table.rows[0], ["肿瘤", 16, "32.7%"]);
  assert.deepEqual(table.rows[1], ["慢性病急性发作", 33, "67.3%"]);
  assert.equal(table.valueColumn, 1);
  assert.equal(table.shareColumn, 2);
});

test("falls back to the ECharts option when no rows are returned", () => {
  const table = buildChartTable(OPTION, null);
  assert.ok(table);
  assert.deepEqual(table.columns, ["分组", "数量", "占比"]);
  assert.deepEqual(table.rows[0], ["低风险", 25, "50%"]);
  assert.deepEqual(table.rows[2], ["中风险", 11, "22%"]);
});

test("reads pie series names and values", () => {
  const pie = {
    series: [{ type: "pie", name: "占比", data: [{ name: "高风险", value: 3 }, { name: "低风险", value: 7 }] }],
  } as EChartsOption;
  const table = buildChartTable(pie);
  assert.ok(table);
  assert.deepEqual(table.rows, [["高风险", 3, "30%"], ["低风险", 7, "70%"]]);
});

test("report summarises totals, top share and risk call-out", () => {
  const table = buildChartTable(OPTION);
  const report = buildChartReport(OPTION, table);
  assert.ok(report);
  assert.equal(report.metrics[0].value, "50");
  assert.equal(report.metrics[1].value, "50%");
  assert.match(report.summary, /低风险.*最多.*25（50%）/);
  // 「高风险」is 14 of 50 (28%) → a risk call-out instead of the plain top-share note.
  assert.ok(report.insight);
  assert.match(report.insight || "", /^高风险合计 14 条，占 28%/);
  assert.equal(report.insightTone, "warn");
});

test("report stays informational for non-risk data and tolerates single groups", () => {
  const table = buildChartTable({ xAxis: { data: ["A", "B"] }, series: [{ type: "bar", data: [9, 1] }] } as EChartsOption);
  const report = buildChartReport(null, table);
  assert.ok(report);
  assert.equal(report.insightTone, "info");
  assert.match(report.insight || "", /A/);
  assert.equal(buildChartReport(null, null), null);
  assert.equal(buildChartTable({} as EChartsOption), null);
});

test("chart title comes from option.title.text", () => {
  assert.equal(chartTitle(OPTION), "营养风险等级统计");
  assert.equal(chartTitle({ title: [{ text: "组合标题" }] } as EChartsOption), "组合标题");
  assert.equal(chartTitle(null), "");
});
