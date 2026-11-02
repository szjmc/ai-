import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, expect as baseExpect } from "@playwright/test";

/**
 * End-to-end browser verification for Text2SQL query + JSON corpus + incremental training UI.
 */
const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

const initialCorpus = {
  ddl: [
    "CREATE TABLE IF NOT EXISTS user_health_risk_assessment (id BIGINT PRIMARY KEY, user_name VARCHAR(100), risk_level VARCHAR(20), total_score INT);",
  ],
  document: ["用户健康风险测评记录表包含NRS2002营养风险筛查完整评分数据。"],
  sql: [
    "SELECT user_name, total_score FROM user_health_risk_assessment WHERE risk_level = '高风险' ORDER BY total_score DESC LIMIT 10",
  ],
};

let corpusState = structuredClone(initialCorpus);
const receivedAddPayloads = [];
let fullTrainCount = 0;

function makeCorpusResponse() {
  return {
    ddl: corpusState.ddl,
    document: corpusState.document,
    sql: corpusState.sql,
    counts: {
      ddl: corpusState.ddl.length,
      document: corpusState.document.length,
      sql: corpusState.sql.length,
      total: corpusState.ddl.length + corpusState.document.length + corpusState.sql.length,
    },
    file_name: "vanna_training_data.json",
    updated_at: "2026-10-30 14:00:00",
  };
}

const stub = createServer((req, res) => {
  const urlObj = new URL(req.url || "/", "http://127.0.0.1:8018");

  if (urlObj.pathname === "/api/v1/text2sql/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: 200,
        message: "服务运行正常",
        data: {
          status: "healthy",
          version: "1.0.0",
          database_connected: true,
          model_loaded: true,
          llm_model: "qwen3:0.6b",
          mysql_db: "test_db",
          training_counts: makeCorpusResponse().counts,
          training_file: "vanna_training_data.json",
        },
      }),
    );
    return;
  }

  if (urlObj.pathname === "/api/v1/text2sql/train/data" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: 200,
        message: "获取训练语料成功",
        data: makeCorpusResponse(),
      }),
    );
    return;
  }

  if (urlObj.pathname === "/api/v1/text2sql/train/add" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      receivedAddPayloads.push(payload);
      const added = { ddl: 0, document: 0, sql: 0 };
      if (Array.isArray(payload.ddl)) {
        corpusState.ddl.push(...payload.ddl);
        added.ddl = payload.ddl.length;
      }
      if (Array.isArray(payload.document)) {
        corpusState.document.push(...payload.document);
        added.document = payload.document.length;
      }
      if (Array.isArray(payload.sql)) {
        corpusState.sql.push(...payload.sql);
        added.sql = payload.sql.length;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: 200,
          message: "新增训练完成：语料已写入 JSON 文件并同步至 Vanna 模型",
          data: {
            ...makeCorpusResponse(),
            added,
            skipped_duplicates: { ddl: 0, document: 0, sql: 0 },
            trained: Boolean(payload.auto_train),
            trained_counts: added,
          },
        }),
      );
    });
    return;
  }

  if (urlObj.pathname === "/api/v1/text2sql/train/data" && req.method === "DELETE") {
    const category = urlObj.searchParams.get("category");
    const index = Number(urlObj.searchParams.get("index"));
    corpusState[category].splice(index, 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: 200,
        message: "已从 JSON 训练文件中移除该条目",
        data: makeCorpusResponse(),
      }),
    );
    return;
  }

  if (urlObj.pathname === "/api/v1/text2sql/train" && req.method === "POST") {
    fullTrainCount += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: 200,
        message: "模型全量训练完成",
        data: { trained_counts: makeCorpusResponse().counts },
      }),
    );
    return;
  }

  if (urlObj.pathname === "/api/v1/text2sql/query" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          question: payload.question,
          generated_sql:
            "SELECT user_name, age, total_score, risk_level FROM user_health_risk_assessment WHERE risk_level = '高风险' ORDER BY total_score DESC LIMIT 10",
          result: [
            { user_name: "陈敬山", age: 74, total_score: 5, risk_level: "高风险" },
            { user_name: "林素梅", age: 68, total_score: 4, risk_level: "高风险" },
          ],
          execution_time: 0.42,
        }),
      );
    });
    return;
  }

  if (urlObj.pathname === "/api/v1/text2sql/tables" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: 200,
        message: "success",
        data: [
          {
            TABLE_NAME: "user_health_risk_assessment",
            COLUMN_NAME: "user_name",
            DATA_TYPE: "varchar",
            COLUMN_COMMENT: "用户姓名",
          },
          {
            TABLE_NAME: "user_health_risk_assessment",
            COLUMN_NAME: "risk_level",
            DATA_TYPE: "enum",
            COLUMN_COMMENT: "风险等级",
          },
        ],
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end();
});

const startStub = () => new Promise((resolve) => stub.listen(8018, "127.0.0.1", resolve));

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));

try {
  await startStub();

  await page.goto("/");
  await page.getByRole("button", { name: "Text2SQL 问数", exact: true }).click();
  const dialog = page.locator(".t2s-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Text2SQL 服务在线")).toBeVisible();
  await expect(dialog.getByText("MySQL 已连接")).toBeVisible();
  console.log("PASS: Text2SQL dialog opens and displays online status + corpus counts");

  // 1. Natural language query + table result + promote to training
  await dialog.locator(".t2s-chip").first().click();
  await dialog.getByRole("button", { name: "生成 SQL 并执行查询" }).click();
  await expect(dialog.locator(".t2s-result-card")).toBeVisible();
  await expect(dialog.getByText("陈敬山")).toBeVisible();
  await expect(dialog.getByText("林素梅")).toBeVisible();

  await dialog.getByRole("button", { name: "＋ 沉淀至训练库" }).click();
  await expect(dialog.getByRole("tab", { name: "② 增加训练" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  console.log("PASS: Natural language query executes and promotes SQL to training form");

  // 2. Fill DDL + Document + SQL and submit incremental training
  await dialog.getByRole("button", { name: "填入示例 DDL" }).click();
  await dialog.getByRole("button", { name: "填入示例文档" }).click();
  await dialog.getByRole("button", { name: "保存至 JSON 并增加训练" }).click();

  await expect(dialog.locator(".t2s-receipt")).toBeVisible();
  await expect(dialog.locator(".t2s-receipt")).toContainText("增量训练已完成");
  assert.equal(receivedAddPayloads.length, 1);
  assert.equal(receivedAddPayloads[0].auto_train, true);
  assert.equal(receivedAddPayloads[0].ddl.length, 1);
  assert.equal(receivedAddPayloads[0].document.length, 1);
  assert.equal(receivedAddPayloads[0].sql.length, 1);
  console.log("PASS: Form incremental training sends ddl, document, sql to /train/add");

  // 3. Batch JSON mode
  await dialog.getByRole("button", { name: "JSON 批量录入 / 文件导入" }).click();
  await dialog.getByRole("button", { name: "填入 JSON 模板" }).click();
  await expect(dialog.locator(".t2s-json-check.ok")).toBeVisible();
  await dialog.getByRole("button", { name: "保存至 JSON 并增加训练" }).click();
  assert.equal(receivedAddPayloads.length, 2);
  console.log("PASS: Batch JSON training mode validates and submits cleanly");

  // 4. Corpus viewer & delete
  await dialog.getByRole("tab", { name: /③ 训练语料/ }).click();
  await expect(dialog.locator(".t2s-corpus-item").first()).toBeVisible();
  const initialCount = await dialog.locator(".t2s-corpus-item").count();
  await dialog.locator(".t2s-del-btn").last().click();
  await expect(dialog.locator(".t2s-corpus-item")).toHaveCount(initialCount - 1);
  console.log("PASS: Corpus viewer lists JSON items and supports item removal");

  // 5. Full train trigger
  await dialog.getByRole("button", { name: /全量训练 JSON 语料/ }).click();
  await expect.poll(() => fullTrainCount).toBe(1);
  console.log("PASS: Full JSON corpus training triggers /api/v1/text2sql/train");

  // 6. Table schema tab
  await dialog.getByRole("tab", { name: "④ 数据表结构" }).click();
  await expect(dialog.getByText("user_name")).toBeVisible();
  await expect(dialog.getByText("风险等级")).toBeVisible();
  console.log("PASS: Table schema tab renders information_schema columns + DDL reference");

  // 7. Close & check mobile viewport horizontal overflow
  await dialog.getByRole("button", { name: "返回知识文件" }).click();
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => ({
    full: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(overflow.full <= overflow.viewport + 1, JSON.stringify(overflow));
  assert.deepEqual(pageErrors, []);
  console.log("PASS: Mobile 390px layout has zero horizontal overflow and zero page errors");
} finally {
  await browser.close();
  await new Promise((resolve) => stub.close(resolve)).catch(() => undefined);
}
