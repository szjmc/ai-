import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, expect as baseExpect } from "@playwright/test";

/**
 * End-to-end browser test for 健康数据分析智能体 (SSE streaming workflow + table + summary + ECharts).
 * Requires Next.js running on TEST_BASE_URL (default http://127.0.0.1:3000) pointing FASTAPI_URL at 127.0.0.1:8018.
 */
const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

let lastRequestPayload = null;

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const stub = createServer((req, res) => {
  const urlObj = new URL(req.url || "/", "http://127.0.0.1:8018");

  if (urlObj.pathname === "/api/v1/graph/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: 200, message: "ok", data: { service: "graph_generate" } }));
    return;
  }

  if (urlObj.pathname === "/api/v1/graph/graph_generate" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", async () => {
      lastRequestPayload = JSON.parse(raw || "{}");
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      writeSse(res, "step", { type: "step", step: 0, message: "开始处理请求" });
      await sleep(80);
      writeSse(res, "step", { type: "step", step: 1, message: "1. 正在生成 SQL..." });
      await sleep(120);
      writeSse(res, "step", { type: "step", step: 2, message: "2. SQL 生成完成" });
      writeSse(res, "step", { type: "step", step: 3, message: "3. 正在执行 SQL 查询..." });
      await sleep(120);
      writeSse(res, "step", { type: "step", step: 4, message: "4. SQL 执行完成，返回 14 行数据" });
      writeSse(res, "step", { type: "step", step: 5, message: "5. 正在格式化数据..." });
      await sleep(60);
      writeSse(res, "step", { type: "step", step: 6, message: "6. 数据格式化完成" });
      writeSse(res, "step", { type: "step", step: 7, message: "7. 正在生成分析结论..." });
      await sleep(80);
      writeSse(res, "step", { type: "step", step: 8, message: "8. 分析结论生成完成" });

      const table = {
        columns: ["风险等级", "人数", "占比"],
        rows: [
          ["高风险", 14, "28%"],
          ["中风险", 11, "22%"],
          ["低风险", 25, "50%"],
        ],
        value_column: 1,
        value_label: "人数",
        row_count: 3,
      };
      const analysis =
        "| 风险等级 | 人数 | 占比 |\n| --- | --- | --- |\n| 高风险 | 14 | 28% |\n| 中风险 | 11 | 22% |\n| 低风险 | 25 | 50% |\n\n### 核心发现\n1. 高风险人群共 14 人，占比 28%。\n2. 总体以低风险为主，需重点随访高风险人群。\n\n**总结**：高风险共 14 人，建议优先安排营养干预。";
      const summary = "高风险共 14 人，建议优先安排营养干预。";

      writeSse(res, "analysis", {
        type: "analysis",
        question: lastRequestPayload.question,
        chart_type: "饼图",
        table,
        analysis,
        summary,
      });

      await sleep(80);
      writeSse(res, "step", { type: "step", step: 9, message: "9. 正在生成 ECharts 配置..." });
      writeSse(res, "step", { type: "step", step: 10, message: "10. 图表配置生成完成" });
      const echarts_option = {
        title: { text: "营养风险等级分布统计", left: "center" },
        tooltip: { trigger: "item" },
        legend: { bottom: 0 },
        series: [
          {
            name: "人数",
            type: "pie",
            radius: ["40%", "66%"],
            data: [
              { name: "高风险", value: 14 },
              { name: "中风险", value: 11 },
              { name: "低风险", value: 25 },
            ],
          },
        ],
      };
      writeSse(res, "chart", {
        type: "chart",
        chart_type: "饼图",
        title: "营养风险等级分布统计",
        subtitle: "饼图 · 共 14 条记录",
        echarts_option,
      });
      writeSse(res, "step", { type: "step", step: 11, message: "所有步骤完成" });
      writeSse(res, "result", {
        type: "result",
        success: true,
        chart_type: "饼图",
        table,
        analysis,
        summary,
        echarts_option,
        execution_time: 0.62,
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ detail: "not found" }));
});

await new Promise((resolve) => stub.listen(8018, "127.0.0.1", resolve));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));

try {
  await page.goto(baseURL);
  await page.getByRole("button", { name: "健康数据分析智能体", exact: true }).click();
  await expect(page.locator("main .hg-shell")).toBeVisible();
  await expect(page.getByText("SSE 流式输出")).toBeVisible();
  await expect(page.getByText("LangGraph 主管模式")).toBeVisible();
  await expect(page.getByText("图表自动渲染")).toBeVisible();

  const chartGroup = page.getByRole("group", { name: "图表类型" });
  for (const label of ["柱状图", "折线图", "饼图"]) {
    await expect(chartGroup.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  const textarea = page.locator("#hg-question-input");
  await textarea.fill("查询高风险(饼图)");
  await expect(page.getByText("9 / 300")).toBeVisible();
  await expect(chartGroup.getByRole("button", { name: "饼图", exact: true })).toHaveAttribute("aria-pressed", "true");

  await chartGroup.getByRole("button", { name: "折线图", exact: true }).click();
  await expect(chartGroup.getByRole("button", { name: "折线图", exact: true })).toHaveAttribute("aria-pressed", "true");
  await chartGroup.getByRole("button", { name: "饼图", exact: true }).click();

  await page.getByRole("button", { name: "开始分析" }).click();

  // Streaming step appears on the left before the final completion step arrives
  await expect(page.locator(".hg-step-list")).toContainText("开始处理请求");
  await expect(page.locator(".hg-step-list")).toContainText("1. 正在生成 SQL...");
  await expect(page.locator(".hg-step-list")).toContainText("所有步骤完成");

  // Right panel displays table, analysis/summary, and rendered ECharts canvas
  await expect(page.locator(".hg-table")).toContainText("高风险");
  await expect(page.locator(".hg-answer-panel")).toContainText("建议优先安排营养干预");
  const canvasBox = await page.locator(".hg-chart-card canvas").first().boundingBox();
  assert.ok(canvasBox && canvasBox.width > 200 && canvasBox.height > 200, "ECharts canvas should render");
  assert.equal(lastRequestPayload?.question, "查询高风险(饼图)");

  // Standalone /graph route & mobile responsiveness
  await page.goto(`${baseURL}/graph`);
  await expect(page.locator(".hg-shell")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  assert.equal(overflow, false, "Mobile /graph layout should not overflow horizontally");
  assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join("; ")}`);

  console.log("PASS: 健康数据分析智能体 streaming workflow, table, summary, and ECharts verified");
} finally {
  await browser.close();
  stub.close();
}
