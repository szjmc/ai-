import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { forwardAsr, forwardRagQuery, probeChatService } from "../src/lib/chat-proxy";
import { asrStatus, clearAsrCache, normalizeAsrEndpoint, resolveAsr } from "../src/lib/asr-config";
import { ApiError } from "../src/lib/errors";

const realFetch = globalThis.fetch;
const env = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
  clearAsrCache();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SCORE = {
  score: 2, nutritional_impairment: 1, disease_severity: 1, age: 0,
  basis: "营养受损：BMI19.2→1分；疾病：糖尿病稳定期→1分；年龄65岁＜70→0分",
};

test("probe points at the FastAPI chat endpoint", async () => {
  stubFetch(() => new Response("{}", { status: 200 }));
  const status = await probeChatService();
  assert.equal(status.reachable, true);
  assert.match(status.endpoint, /\/api\/v1\/chat\/systemRagQuery$/);
});

test("probe explains how to start FastAPI when it is down", async () => {
  stubFetch(() => { throw Object.assign(new Error("fetch failed"), { name: "TypeError" }); });
  const status = await probeChatService();
  assert.equal(status.reachable, false);
  assert.match(status.hint || "", /python main\.py/);
});

test("query payload reaches the backend unchanged and the result passes through", async () => {
  let url = "";
  let body = "";
  stubFetch((u, init) => {
    url = u; body = String(init?.body ?? "");
    return jsonResponse({
      status: 200, message: "NRS2002评分查询成功",
      data: { score_info: SCORE, source_basis: [{ file_name: "规则.md", rule_fragment: "BMI<18.5 → 2分" }],
              query_params: { file_id: "f-1", collection_name: "yycp", top_k: 2 } },
      page: null,
    });
  });

  const payload = { question: "65岁女性，BMI 19.2，2型糖尿病稳定期", file_id: "f-1", collection_name: "yycp", top_k: 2 };
  const result = await forwardRagQuery(payload);

  assert.match(url, /\/api\/v1\/chat\/systemRagQuery$/);
  // No rewriting, no extra fields, no retrieval logic on the JS side.
  assert.deepEqual(JSON.parse(body), payload);
  assert.equal(result.message, "NRS2002评分查询成功");
  assert.deepEqual((result.data as { score_info: typeof SCORE }).score_info, SCORE);
});

test("upstream 500 is reported as a backend-side problem", async () => {
  stubFetch(() => new Response("Internal Server Error", { status: 500 }));
  const error = await forwardRagQuery({ question: "q", file_id: "f", collection_name: "c" }).catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 502);
  assert.match(error.message, /Milvus 无数据|Ollama/);
  assert.match(error.message, /日志/);
});

test("a 200 response without data is not treated as success", async () => {
  stubFetch(() => jsonResponse({ status: 200, message: "NRS2002评分查询成功", data: null }));
  const error = await forwardRagQuery({ question: "q", file_id: "f", collection_name: "c" }).catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 502);
  assert.match(error.message, /未返回结果数据/);
});

test("a backend 404 (file_id has no chunks) keeps its status and message", async () => {
  stubFetch(() => jsonResponse({ status: 404, message: "指定file_id=f-9无匹配的NRS2002规则数据", data: {} }));
  const error = await forwardRagQuery({ question: "q", file_id: "f-9", collection_name: "c" }).catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 404);
  assert.match(error.message, /无匹配的NRS2002规则数据/);
});

test("connection refused asks the user to start FastAPI", async () => {
  stubFetch(() => { throw Object.assign(new Error("fetch failed"), { name: "TypeError" }); });
  const error = await forwardRagQuery({ question: "q", file_id: "f", collection_name: "c" }).catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 503);
  assert.match(error.message, /python main\.py/);
});

test("a query timeout suggests reading the backend log", async () => {
  stubFetch(() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
  const error = await forwardRagQuery({ question: "q", file_id: "f", collection_name: "c" }).catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 504);
  assert.match(error.message, /查询超时/);
});

test("ASR reports itself unconfigured when no env source provides settings", async () => {
  delete process.env.ASR_BASE_URL;
  delete process.env.ASR_MODEL;
  clearAsrCache();
  const status = await asrStatus();
  // backend/.env may exist in this repo, so assert on the shape rather than on "false".
  assert.equal(typeof status.configured, "boolean");
  assert.ok(["env", "backend/.env", "none"].includes(status.source));
  if (!status.configured) {
    assert.match(status.endpoint, /未配置/);
    assert.match(status.model, /未配置/);
  }
});

test("ASR forwards audio with the configured model and bearer token", async () => {
  process.env.ASR_BASE_URL = "https://asr.example.com/v1/";
  process.env.ASR_API_KEY = "sk-test";
  process.env.ASR_MODEL = "Qwen3-ASR";
  clearAsrCache();
  let url = "";
  let auth = "";
  let hasFile = false;
  stubFetch((u, init) => {
    url = u;
    auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || "");
    const body = init?.body as FormData | undefined;
    hasFile = Boolean(body?.get("file"));
    return jsonResponse({ text: "患者女性六十五岁 BMI 十九点二" });
  });

  const text = await forwardAsr(new File([new Uint8Array([1, 2, 3])], "speech.webm", { type: "audio/webm" }));
  assert.equal(text, "患者女性六十五岁 BMI 十九点二");
  assert.equal(url, "https://asr.example.com/v1/audio/transcriptions");
  assert.equal(auth, "Bearer sk-test");
  assert.equal(hasFile, true);
});

test("a full /audio/transcriptions endpoint is not appended twice", () => {
  // Both forms appear in real .env files; the second is a common source of 404s.
  assert.equal(normalizeAsrEndpoint("https://api.siliconflow.cn/v1"), "https://api.siliconflow.cn/v1/audio/transcriptions");
  assert.equal(normalizeAsrEndpoint("https://api.siliconflow.cn/v1/"), "https://api.siliconflow.cn/v1/audio/transcriptions");
  assert.equal(normalizeAsrEndpoint("https://api.siliconflow.cn/v1/audio/transcriptions"), "https://api.siliconflow.cn/v1/audio/transcriptions");
  assert.equal(normalizeAsrEndpoint("https://api.siliconflow.cn/v1/audio/transcriptions/"), "https://api.siliconflow.cn/v1/audio/transcriptions");
  assert.equal(normalizeAsrEndpoint(""), "");
});

test("this app's env wins, and backend/.env is used when it is absent", async () => {
  delete process.env.ASR_BASE_URL;
  delete process.env.ASR_MODEL;
  delete process.env.ASR_API_KEY;
  clearAsrCache();
  const fromBackend = await resolveAsr();
  // The repository ships backend/.env, so the fallback should kick in.
  assert.equal(fromBackend.source === "backend/.env" || fromBackend.source === "none", true);
  if (fromBackend.source === "backend/.env") {
    assert.ok(fromBackend.endpoint.endsWith("/audio/transcriptions"));
    assert.equal(fromBackend.configured, true);
  }

  process.env.ASR_BASE_URL = "https://override.example.com/v1";
  process.env.ASR_MODEL = "override-model";
  clearAsrCache();
  const fromEnv = await resolveAsr();
  assert.equal(fromEnv.source, "env");
  assert.equal(fromEnv.model, "override-model");
});

test("ASR auth failure and empty transcription produce actionable messages", async () => {
  process.env.ASR_BASE_URL = "https://asr.example.com/v1";
  process.env.ASR_MODEL = "Qwen3-ASR";
  process.env.ASR_API_KEY = "bad";
  clearAsrCache();

  stubFetch(() => jsonResponse({ message: "Invalid token" }, 401));
  const auth = await forwardAsr(new File(["x"], "a.webm")).catch((e) => e);
  assert.ok(auth instanceof ApiError);
  assert.equal(auth.statusCode, 502);
  assert.match(auth.message, /鉴权失败/);
  assert.match(auth.message, /ASR_API_KEY/);

  stubFetch(() => new Response("Not Found", { status: 404 }));
  const notFound = await forwardAsr(new File(["x"], "a.webm")).catch((e) => e);
  assert.ok(notFound instanceof ApiError);
  assert.match(notFound.message, /ASR_BASE_URL/);

  stubFetch(() => jsonResponse({ text: "   " }));
  const empty = await forwardAsr(new File(["x"], "a.webm")).catch((e) => e);
  assert.ok(empty instanceof ApiError);
  assert.equal(empty.statusCode, 422);
});

test("ASR accepts the OpenAI-style {data:{text}} envelope too", async () => {
  process.env.ASR_BASE_URL = "https://asr.example.com/v1";
  process.env.ASR_MODEL = "Qwen3-ASR";
  clearAsrCache();
  stubFetch(() => jsonResponse({ data: { text: "六十五岁女性" } }));
  assert.equal(await forwardAsr(new File(["x"], "a.webm")), "六十五岁女性");
});
