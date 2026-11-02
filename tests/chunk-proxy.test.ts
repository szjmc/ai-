import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { forwardParseFile, probeChunkService } from "../src/lib/chunk-proxy";
import { ApiError } from "../src/lib/errors";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("probe reports the FastAPI chunk endpoint when the service answers", async () => {
  stubFetch(() => new Response("{}", { status: 200 }));
  const status = await probeChunkService();
  assert.equal(status.reachable, true);
  assert.match(status.endpoint, /\/api\/v1\/chunks\/parseFile$/);
});

test("probe explains how to start the service when it is down", async () => {
  stubFetch(() => { throw Object.assign(new Error("fetch failed"), { name: "TypeError" }); });
  const status = await probeChunkService();
  assert.equal(status.reachable, false);
  assert.match(status.reason || "", /无法连接/);
  assert.match(status.hint || "", /python main\.py/);
});

test("a successful parse passes the backend payload straight through", async () => {
  const upstream = {
    file_id: "f-1", file_name: "doc_ab12cd34.md", minio_path: "knowledge-base/doc_ab12cd34.md",
    chunks_processed: 3, chunk_ids: [11, 22, 33], process_time: "2026-10-27T05:00:00",
  };
  let sentBody = "";
  let sentUrl = "";
  stubFetch((url, init) => {
    sentUrl = url; sentBody = String(init?.body ?? "");
    return jsonResponse({ status: 200, message: "text splitter successfully", data: upstream, page: null });
  });

  const result = await forwardParseFile({ file_id: "f-1", minio_path: "knowledge-base/doc_ab12cd34.md", file_name: "doc_ab12cd34.md" });
  assert.match(sentUrl, /\/api\/v1\/chunks\/parseFile$/);
  // The body must reach the backend unchanged: no renaming, no extra fields.
  assert.deepEqual(JSON.parse(sentBody), { file_id: "f-1", minio_path: "knowledge-base/doc_ab12cd34.md", file_name: "doc_ab12cd34.md" });
  assert.equal(result.message, "text splitter successfully");
  assert.deepEqual(result.data, upstream);
});

test("an upstream 500 is explained as a backend-side failure, not a frontend bug", async () => {
  // chunk_router catches exceptions without returning, so FastAPI answers 500.
  stubFetch(() => new Response("Internal Server Error", { status: 500 }));
  const error = await forwardParseFile({ file_id: "f-1", minio_path: "p" }).catch((caught) => caught);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 502);
  assert.match(error.message, /Ollama、Milvus 或 MinIO/);
  assert.match(error.message, /日志/);
});

test("a 200 response without data is reported instead of being shown as success", async () => {
  stubFetch(() => jsonResponse({ status: 200, message: "text splitter successfully", data: null, page: null }));
  const error = await forwardParseFile({ file_id: "f-1", minio_path: "p" }).catch((caught) => caught);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 502);
  assert.match(error.message, /未返回结果数据/);
});

test("connection refused asks the user to start FastAPI", async () => {
  stubFetch(() => { throw Object.assign(new Error("fetch failed"), { name: "TypeError" }); });
  const error = await forwardParseFile({ file_id: "f-1", minio_path: "p" }).catch((caught) => caught);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 503);
  assert.match(error.message, /python main\.py/);
});

test("a timeout warns against resubmitting a job that may still be running", async () => {
  stubFetch(() => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
  const error = await forwardParseFile({ file_id: "f-1", minio_path: "p" }).catch((caught) => caught);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 504);
  assert.match(error.message, /不要立即重复提交/);
});

test("a backend 4xx keeps its own status code and message", async () => {
  stubFetch(() => jsonResponse({ detail: "minio_metadata中必须包含minio_path" }, 422));
  const error = await forwardParseFile({ file_id: "f-1", minio_path: "p" }).catch((caught) => caught);
  assert.ok(error instanceof ApiError);
  assert.equal(error.statusCode, 422);
  assert.match(error.message, /必须包含minio_path/);
});
