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
  const result = { success: true, question: payload.question, result: [{ answer: JSON.stringify({ series: [{ type: "bar", data: [1, 2] }] }) }], execution_time: 1 };
  globalThis.fetch = (async (input, init) => { assert.equal(String(input), "http://fastapi:8018/api/v1/text2echarts/generate"); assert.deepEqual(JSON.parse(String(init?.body)), payload); return Response.json(result); }) as typeof fetch;
  const response = await POST(request(payload));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result);
});

test("reports validation, missing route, and unavailable upstream", async () => {
  assert.equal((await POST(request({ question: "", echarts_type: "柱状图" }))).status, 400);
  globalThis.fetch = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
  let response = await POST(request({ question: "问题", echarts_type: "柱状图" }));
  assert.equal(response.status, 502); assert.match((await response.json()).error, /未找到/);
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  response = await POST(request({ question: "问题", echarts_type: "柱状图" }));
  assert.equal(response.status, 503); assert.match((await response.json()).error, /无法连接/);
});
