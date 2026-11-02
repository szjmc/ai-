import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { ApiError } from "../src/lib/errors";
import {
  fetchTrainingCorpus,
  forwardAddTraining,
  forwardDeleteTrainingItem,
  forwardFullTrain,
  forwardTableInfo,
  forwardText2SqlQuery,
  probeText2SqlService,
} from "../src/lib/text2sql-proxy";

const realFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env = { ...originalEnv };
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("probeText2SqlService reports online health and offline hints accurately", async () => {
  stubFetch(() =>
    jsonResponse({
      status: 200,
      message: "服务运行正常",
      data: {
        status: "healthy",
        database_connected: true,
        model_loaded: true,
        llm_model: "qwen3:0.6b",
        mysql_db: "test_db",
      },
    }),
  );
  const online = await probeText2SqlService();
  assert.equal(online.service.reachable, true);
  assert.equal(online.health?.database_connected, true);
  assert.equal(online.health?.model_loaded, true);

  stubFetch(() => {
    throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
  });
  const offline = await probeText2SqlService();
  assert.equal(offline.service.reachable, false);
  assert.match(offline.service.hint || "", /python main\.py/);
});

test("fetchTrainingCorpus reads repository JSON fallback when FastAPI is offline", async () => {
  stubFetch(() => {
    throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
  });
  const corpus = await fetchTrainingCorpus();
  assert.equal(corpus.source, "local_json");
  assert.equal(corpus.counts.ddl, 1);
  assert.equal(corpus.counts.document, 1);
  assert.equal(corpus.counts.sql, 5);
  assert.equal(corpus.counts.total, 7);
});

test("forwardAddTraining sends normalized ddl/document/sql to FastAPI /train/add", async () => {
  let calledUrl = "";
  let sentBody: Record<string, unknown> | null = null;
  stubFetch((url, init) => {
    calledUrl = url;
    sentBody = JSON.parse(String(init?.body || "{}"));
    return jsonResponse({
      status: 200,
      message: "新增训练完成：语料已写入 JSON 文件并同步至 Vanna 模型",
      data: {
        ddl: ["CREATE TABLE t1 (id INT);"],
        document: ["业务规则说明"],
        sql: [{ question: "查全部", sql: "SELECT * FROM t1" }],
        counts: { ddl: 2, document: 2, sql: 6, total: 10 },
        added: { ddl: 1, document: 1, sql: 1 },
        skipped_duplicates: { ddl: 0, document: 0, sql: 0 },
        trained: true,
        trained_counts: { ddl: 1, document: 1, sql: 1 },
        file_name: "vanna_training_data.json",
        updated_at: "2026-10-30 12:00:00",
      },
    });
  });

  const res = await forwardAddTraining({
    ddl: "  CREATE TABLE t1 (id INT);  ",
    document: "业务规则说明",
    sql: "SELECT * FROM t1",
    question: "查全部",
    auto_train: true,
  });

  assert.match(calledUrl, /\/api\/v1\/text2sql\/train\/add$/);
  assert.deepEqual(sentBody, {
    ddl: ["CREATE TABLE t1 (id INT);"],
    document: ["业务规则说明"],
    sql: [{ question: "查全部", sql: "SELECT * FROM t1" }],
    auto_train: true,
  });
  assert.equal(res.data.trained, true);
  assert.equal(res.data.source, "fastapi_backend");
  assert.equal(res.data.counts.total, 10);
});

test("forwardAddTraining supports local JSON persistence when auto_train=false and FastAPI is down", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "t2s-json-"));
  tempDirs.push(dir);
  const tempFile = path.join(dir, "vanna_training_data.json");
  process.env.VANNA_TRAINING_FILE = tempFile;

  stubFetch(() => {
    throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
  });

  // auto_train=true when offline must reject rather than faking vector training
  const err = await forwardAddTraining({ sql: "SELECT 1", auto_train: true }).catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.statusCode, 503);

  // auto_train=false saves cleanly to JSON file and deduplicates
  const saved = await forwardAddTraining({
    ddl: "CREATE TABLE demo (id INT);",
    document: "demo 说明",
    sql: ["SELECT * FROM demo"],
    auto_train: false,
  });
  assert.equal(saved.data.trained, false);
  assert.equal(saved.data.source, "local_json");
  assert.deepEqual(saved.data.added, { ddl: 1, document: 1, sql: 1 });

  const rawJson = JSON.parse(await readFile(tempFile, "utf8"));
  assert.deepEqual(Object.keys(rawJson), ["ddl", "document", "sql"]);
  assert.equal(rawJson.sql.length, 1);

  const afterDel = await forwardDeleteTrainingItem("sql", 0);
  assert.equal(afterDel.data.counts.sql, 0);
});

test("forwardText2SqlQuery, forwardFullTrain, and forwardTableInfo proxy responses cleanly", async () => {
  stubFetch((url) => {
    if (url.endsWith("/api/v1/text2sql/query")) {
      return jsonResponse({
        success: true,
        question: "统计各风险等级人数",
        generated_sql: "SELECT risk_level, COUNT(*) AS cnt FROM user_health_risk_assessment GROUP BY risk_level",
        result: [{ risk_level: "高风险", cnt: 12 }],
        execution_time: 0.35,
      });
    }
    if (url.endsWith("/api/v1/text2sql/train")) {
      return jsonResponse({
        status: 200,
        message: "模型训练完成",
        data: { trained_counts: { ddl: 1, document: 1, sql: 5 } },
      });
    }
    return jsonResponse({
      status: 200,
      message: "success",
      data: [
        {
          TABLE_NAME: "user_health_risk_assessment",
          COLUMN_NAME: "risk_level",
          DATA_TYPE: "enum",
          COLUMN_COMMENT: "风险等级",
        },
      ],
    });
  });

  const q = await forwardText2SqlQuery({ question: "统计各风险等级人数", limit: 10 });
  assert.equal(q.data.result?.[0]?.risk_level, "高风险");
  assert.match(q.data.generated_sql || "", /GROUP BY risk_level/);

  const tr = await forwardFullTrain();
  assert.equal(tr.data.trained_counts?.sql, 5);

  const cols = await forwardTableInfo("user_health_risk_assessment");
  assert.equal(cols.data[0].COLUMN_NAME, "risk_level");
});
