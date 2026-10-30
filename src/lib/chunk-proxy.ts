import { getBackendConfig } from "./backend-config";
import { ApiError } from "./errors";

/**
 * Thin transport layer for the FastAPI chunking service.
 *
 * Deliberately contains no chunking, tokenisation, embedding or vector-store logic:
 * all of that lives in the Python backend (app/services/chunk_service.py). This file
 * only forwards the request and turns transport failures into readable messages.
 */

/** Probing must stay fast so the console can poll it without feeling sluggish. */
const PROBE_TIMEOUT_MS = 1500;
/** Chunking downloads from MinIO, runs jieba, embeds and writes to Milvus. */
const PARSE_TIMEOUT_MS = 10 * 60 * 1000;

export type ChunkServiceStatus = {
  reachable: boolean;
  base_url: string;
  endpoint: string;
  reason?: string;
  hint?: string;
};

export async function probeChunkService(): Promise<ChunkServiceStatus> {
  const cfg = getBackendConfig();
  const status: ChunkServiceStatus = {
    reachable: false,
    base_url: cfg.fastapiUrl,
    endpoint: `${cfg.fastapiUrl}/api/v1/chunks/parseFile`,
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
      hint: "请在 backend/ 目录执行 python main.py 启动解析服务（默认 8018 端口）",
    };
  }
}

export type ParsePayload = Record<string, unknown>;

/** Shape returned by the backend's ApiResponse model. */
export type UpstreamBody = {
  status?: number;
  message?: string;
  data?: unknown;
  page?: unknown;
  detail?: unknown;
};

export async function forwardParseFile(payload: ParsePayload): Promise<{ message: string; data: unknown }> {
  const cfg = getBackendConfig();
  const url = `${cfg.fastapiUrl}/api/v1/chunks/parseFile`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (aborted) {
      throw new ApiError(504, `解析超时（已等待 ${PARSE_TIMEOUT_MS / 60000} 分钟）。任务可能仍在后端运行，请查看后端日志确认结果，不要立即重复提交。`);
    }
    throw new ApiError(503, `无法连接解析服务 ${cfg.fastapiUrl}。请确认 FastAPI 已启动（backend/ 目录执行 python main.py）。`);
  }

  const raw = await response.text();
  let body: UpstreamBody | null = null;
  try {
    body = raw ? (JSON.parse(raw) as UpstreamBody) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    // chunk_router.parse_file 捕获异常后既不 raise 也不 return，FastAPI 校验
    // response_model=ApiResponse 时会得到 None，从而回 500。此时真实原因只在后端日志里。
    if (response.status === 500) {
      throw new ApiError(502, "解析服务返回 500：请求已到达后端但未返回结果。常见原因是 Ollama、Milvus 或 MinIO 未就绪，详细原因请查看 FastAPI 控制台日志。");
    }
    const detail = typeof body?.detail === "string" ? body.detail : "";
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      detail || body?.message || `解析服务返回 HTTP ${response.status}`,
    );
  }

  if (!body || body.data == null) {
    throw new ApiError(502, "解析服务未返回结果数据，请查看 FastAPI 控制台日志确认处理是否成功。");
  }
  if (typeof body.status === "number" && body.status >= 400) {
    throw new ApiError(body.status, body.message || "解析失败");
  }

  return { message: body.message || "解析完成", data: body.data };
}
