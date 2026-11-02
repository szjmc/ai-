import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { fetchFastApiConfig, resolveAsr } from "../src/lib/asr-config";

const realFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...originalEnv };
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

test("fetchFastApiConfig directly retrieves system configuration from running FastAPI backend", async () => {
  let calledUrl = "";
  stubFetch((url) => {
    calledUrl = url;
    return jsonResponse({
      status: 200,
      message: "获取后端配置成功",
      data: {
        asr: {
          configured: true,
          model: "Qwen/Qwen3-ASR-1.7B",
          base_url: "https://api.siliconflow.cn/v1",
          endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
          has_api_key: true,
        },
        milvus: {
          host: "127.0.0.1",
          port: "19530",
          default_collection: "rag_knowledge",
        },
        ollama: {
          base_url: "http://127.0.0.1:11434",
          llm_model: "qwen3:0.6b",
          embedding_model: "bge-m3:latest",
        },
        strategy: {
          llm_strategy: "ollama",
          embedding_strategy: "ollama",
        },
      },
    });
  });

  const config = await fetchFastApiConfig();
  assert.match(calledUrl, /\/api\/v1\/config\/systemConfig$/);
  assert.ok(config !== null);
  assert.equal(config.asr.configured, true);
  assert.equal(config.asr.model, "Qwen/Qwen3-ASR-1.7B");
  assert.equal(config.milvus.default_collection, "rag_knowledge");
  assert.equal(config.asr.source, "fastapi_backend");
});

test("resolveAsr prioritizes live FastAPI backend config over local files", async () => {
  stubFetch(() =>
    jsonResponse({
      status: 200,
      message: "success",
      data: {
        asr: {
          configured: true,
          model: "Qwen/Qwen3-ASR-Remote",
          endpoint: "https://remote.example.com/v1/audio/transcriptions",
          has_api_key: true,
        },
      },
    })
  );

  const asr = await resolveAsr();
  assert.equal(asr.source, "fastapi_backend");
  assert.equal(asr.model, "Qwen/Qwen3-ASR-Remote");
  assert.equal(asr.configured, true);
  assert.equal(asr.endpoint, "https://remote.example.com/v1/audio/transcriptions");
});
