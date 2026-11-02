import { getBackendConfig } from "./backend-config";
import { ApiError } from "./errors";
import { resolveAsr, normalizeAsrEndpoint } from "./asr-config";

/**
 * Transport layer for the FastAPI RAG query service (app/routers/chatbot_query_router.py).
 *
 * Contains NO retrieval, BM25, rerank or LLM logic — all of that lives in the Python
 * services. This file only forwards the request and translates failures into readable
 * messages. The frontend is deliberately "dumb" here.
 */

const PROBE_TIMEOUT_MS = 1500;
/** A RAG query embeds the question, hits Milvus and runs the LLM; allow a few minutes. */
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;

export type ChatServiceStatus = {
  reachable: boolean;
  base_url: string;
  endpoint: string;
  reason?: string;
  hint?: string;
};

export type RagQueryPayload = {
  question: string;
  file_id: string;
  collection_name: string;
  top_k?: number;
};

export async function probeChatService(): Promise<ChatServiceStatus> {
  const cfg = getBackendConfig();
  const status: ChatServiceStatus = {
    reachable: false,
    base_url: cfg.fastapiUrl,
    endpoint: `${cfg.fastapiUrl}/api/v1/chat/systemRagQuery`,
  };
  try {
    const response = await fetch(`${cfg.fastapiUrl}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      return { ...status, reason: `后端返回 HTTP ${response.status}`, hint: "请检查 FastAPI 服务日志" };
    }
    return { ...status, reachable: true };
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ...status,
      reason: aborted ? `连接 ${cfg.fastapiUrl} 超时` : `无法连接 ${cfg.fastapiUrl}`,
      hint: "请在 backend/ 目录执行 python main.py 启动查询服务（默认 8018 端口）",
    };
  }
}

type UpstreamBody = { status?: number; message?: string; data?: unknown; detail?: unknown };

export async function forwardRagQuery(payload: RagQueryPayload): Promise<{ message: string; data: unknown }> {
  const cfg = getBackendConfig();
  const url = `${cfg.fastapiUrl}/api/v1/chat/systemRagQuery`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (aborted) {
      throw new ApiError(504, `查询超时（已等待 ${QUERY_TIMEOUT_MS / 60000} 分钟）。后端可能在生成向量或等待 LLM，请查看 FastAPI 日志。`);
    }
    throw new ApiError(503, `无法连接查询服务 ${cfg.fastapiUrl}。请确认 FastAPI 已启动（backend/ 目录执行 python main.py）。`);
  }

  const raw = await response.text();
  let body: UpstreamBody | null = null;
  try { body = raw ? (JSON.parse(raw) as UpstreamBody) : null; } catch { body = null; }

  if (!response.ok) {
    if (response.status === 500) {
      throw new ApiError(502, "查询服务返回 500：请求已到达后端但未完成。常见原因是 Milvus 无数据、Ollama 模型未拉取或 LLM 输出不是合法 JSON，详细原因请查看 FastAPI 控制台日志。");
    }
    const detail = typeof body?.detail === "string" ? body.detail : "";
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      detail || body?.message || `查询服务返回 HTTP ${response.status}`,
    );
  }
  if (!body) throw new ApiError(502, "查询服务返回的内容无法解析为 JSON，请查看 FastAPI 日志。");
  if (typeof body.status === "number" && body.status >= 400) {
    throw new ApiError(body.status, body.message || "查询失败");
  }
  if (body.data == null) {
    throw new ApiError(502, "查询服务未返回结果数据，请查看 FastAPI 控制台日志确认检索与 LLM 是否正常。");
  }
  return { message: body.message || "查询完成", data: body.data };
}

/* ------------------------------------------------------------------ */
/* 语音转文字（ASR）                                                    */
/* ------------------------------------------------------------------ */

/**
 * Forwards recorded audio to an OpenAI-compatible /audio/transcriptions endpoint.
 * Config resolution (this app's env, then backend/.env) lives in asr-config.ts.
 * No ASR processing happens in this app — it is a transport only.
 */
export async function forwardAsr(
  audio: File,
  override?: { apiKey?: string; baseUrl?: string; model?: string },
): Promise<string> {
  const asr = await resolveAsr();
  const endpoint = override?.baseUrl ? normalizeAsrEndpoint(override.baseUrl) : asr.endpoint;
  const model = override?.model || asr.model;
  const apiKey = override?.apiKey !== undefined ? override.apiKey : asr.apiKey;

  if (!endpoint || !model) {
    throw new ApiError(
      501,
      "语音识别服务未配置。请在项目根目录 .env.local 或 backend/.env 中设置 ASR_BASE_URL 与 ASR_MODEL（需要时加 ASR_API_KEY）。",
    );
  }

  const form = new FormData();
  form.set("file", audio, audio.name || "speech.webm");
  form.set("model", model);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ApiError(
      503,
      aborted
        ? "语音识别超时（120 秒）。录音过长或网络较慢，请缩短后重试。"
        : `无法连接语音识别服务 ${asr.endpoint}，请检查 ASR_BASE_URL 与网络。`,
    );
  }

  const raw = await response.text();
  let parsed: { text?: string; error?: { message?: string } | string; message?: string } | null = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

  if (!response.ok) {
    const providerMessage =
      (typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message) ||
      parsed?.message ||
      raw.slice(0, 200);
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, `语音识别服务鉴权失败（HTTP ${response.status}）：请检查 ASR_API_KEY 是否正确、是否与 ASR_BASE_URL 的账号匹配。`);
    }
    if (response.status === 404) {
      throw new ApiError(502, `语音识别接口不存在（HTTP 404）：${asr.endpoint}。请确认 ASR_BASE_URL（base 或完整 /audio/transcriptions 均可）与 ASR_MODEL=${asr.model}。`);
    }
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      `语音识别失败（HTTP ${response.status}）：${providerMessage || "服务未返回原因"}`,
    );
  }

  // 兼容 {text} / {data:{text}} / 纯文本三种返回
  const text =
    (typeof parsed?.text === "string" && parsed.text.trim()) ||
    (typeof (parsed as { data?: { text?: string } } | null)?.data?.text === "string" &&
      String((parsed as { data?: { text?: string } }).data?.text).trim()) ||
    (!parsed && raw.trim() && !raw.trim().startsWith("{") ? raw.trim() : "");
  if (!text) throw new ApiError(422, "语音识别服务未返回文字，可能录音过短或无声。请重试并靠近麦克风。");
  return text;
}
