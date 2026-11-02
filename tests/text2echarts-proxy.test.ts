import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { POST } from "../src/app/api/v1/text2echarts/generate/route";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.FASTAPI_URL;
afterEach(() => { globalThis.fetch = originalFetch; if (originalUrl === undefined) delete process.env.FASTAPI_URL; else process.env.FASTAPI_URL = originalUrl; });
const request = (body: unknown) => new Request("http://localhost/api/v1/text2echarts/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("forwards the chart request and returns the actual upstream result", async () => {
  process.env.FASTAPI_URL = "http://fastapi:8018";
  const payload = { question: "各类别数量", echarts_type: "柱状图", auto_execute: true, limit: 10 };
  const result = {
    success: true, question: payload.question, chart_type: "柱状图",
    echarts_option: { series: [{ type: "bar", data: [1, 2] }] },
    table: { columns: ["分组", "数量", "占比"], rows: [["A", 1, "50%"], ["B", 1, "50%"]] },
    report: { metrics: [], summary: "共 2 条", insight: null },
    title: "各类别数量", subtitle: "数量", execution_time: 1,
  };
  globalThis.fetch = (async (input, init) => { assert.equal(String(input), "http://fastapi:8018/api/v1/text2echarts/generate"); assert.deepEqual(JSON.parse(String(init?.body)), payload); return Response.json(result); }) as typeof fetch;
  const response = await POST(request(payload));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result);
});

test("only bar, line and pie are accepted", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return Response.json({}); }) as typeof fetch;
  for (const unsupported of ["条形图", "散点图", "radar"]) {
    const response = await POST(request({ question: "问题", echarts_type: unsupported }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /柱状图、折线图、饼图/);
  }
  assert.equal(called, false, "unsupported types must never reach FastAPI");
  for (const supported of ["柱状图", "折线图", "饼图"]) {
    const response = await POST(request({ question: "问题", echarts_type: supported }));
    assert.equal(response.status, 200, supported);
  }
});

test("passes the chart-type rejection through but hides other upstream details", async () => {
  globalThis.fetch = (async () => Response.json({ detail: "图表类型仅支持柱状图、折线图、饼图" }, { status: 400 })) as typeof fetch;
  let response = await POST(request({ question: "问题", echarts_type: "柱状图" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /仅支持柱状图/);

  // 内部细节（SQL、表名、服务地址）不能出现在给用户的响应里。
  globalThis.fetch = (async () => Response.json({ detail: "Table 'test_db.user_health_risk' doesn't exist" }, { status: 500 })) as typeof fetch;
  response = await POST(request({ question: "问题", echarts_type: "柱状图" }));
  const body = await response.json() as { error: string };
  assert.equal(response.status, 502);
  assert.doesNotMatch(body.error, /test_db|SELECT|FastAPI|FASTAPI_URL|8018/i);
  assert.match(body.error, /分析服务暂时不可用/);
});

test("reports validation, missing route, and unavailable upstream", async () => {
  assert.equal((await POST(request({ question: "", echarts_type: "柱状图" }))).status, 400);
  globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
  let response = await POST(request({ question: "问题", echarts_type: "柱状图" }));
  assert.equal(response.status, 502);
  const missingRoute = (await response.json()) as { error: string };
  assert.match(missingRoute.error, /分析服务暂时不可用/);
  assert.doesNotMatch(missingRoute.error, /FastAPI|FASTAPI_URL|路由|8018/);
  globalThis.fetch = (async () => { throw new Error("fetch failed to http://127.0.0.1:8018"); }) as typeof fetch;
  response = await POST(request({ question: "问题", echarts_type: "柱状图" }));
  assert.equal(response.status, 503);
  const offline = (await response.json()) as { error: string };
  assert.match(offline.error, /分析服务暂时不可用/);
  assert.doesNotMatch(offline.error, /127\.0\.0\.1|8018|FASTAPI_URL/);
});
