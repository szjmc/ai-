import { getBackendConfig } from "@/lib/backend-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const ALLOWED_CHART_TYPES = new Set(["柱状图", "折线图", "饼图", "bar", "line", "pie"]);
const UPSTREAM_TIMEOUT_MS = 300_000;

const MSG_EMPTY = "请输入分析问题";
const MSG_BAD_TYPE = "图表类型仅支持柱状图、折线图、饼图";
const MSG_UNAVAILABLE = "分析服务暂时不可用，请稍后重试。";
const MSG_TIMEOUT = "分析超时，请稍后重试。";

function combineSignals(requestSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  if (!requestSignal) return timeoutSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([requestSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (requestSignal.aborted) {
    controller.abort();
    return controller.signal;
  }
  requestSignal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

async function forwardGraphRequest(
  payload: Record<string, unknown>,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const rawQuestion =
    typeof payload.question === "string"
      ? payload.question
      : typeof payload.query === "string"
        ? payload.query
        : typeof payload.input === "string"
          ? payload.input
          : "";

  if (!rawQuestion.trim()) {
    return Response.json({ error: MSG_EMPTY }, { status: 400 });
  }

  const rawChartType =
    typeof payload.echarts_type === "string"
      ? payload.echarts_type.trim()
      : typeof payload.chart_type === "string"
        ? payload.chart_type.trim()
        : "";
  if (rawChartType && !ALLOWED_CHART_TYPES.has(rawChartType.toLowerCase()) && !ALLOWED_CHART_TYPES.has(rawChartType)) {
    return Response.json({ error: MSG_BAD_TYPE }, { status: 400 });
  }

  const upstreamUrl = getBackendConfig().graphGenerateUrl;

  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({
        ...payload,
        question: rawQuestion.trim(),
        stream: payload.stream !== false,
      }),
      cache: "no-store",
      signal: combineSignals(requestSignal),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      let errorJson: { detail?: unknown; error?: unknown; message?: unknown } | null = null;
      try {
        errorJson = errorText ? JSON.parse(errorText) : null;
      } catch {
        errorJson = null;
      }
      const detail = errorJson?.detail;
      if (response.status === 400 && detail === MSG_BAD_TYPE) {
        return Response.json({ error: MSG_BAD_TYPE }, { status: 400 });
      }
      if (response.status === 400 && detail === MSG_EMPTY) {
        return Response.json({ error: MSG_EMPTY }, { status: 400 });
      }
      console.error(`[graph_generate] 上游失败：${response.status} ${errorText.slice(0, 500)}`);
      return Response.json({ error: MSG_UNAVAILABLE }, { status: 502 });
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/event-stream") && response.body) {
      return new Response(response.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`[graph_generate] 上游返回了非 JSON/SSE 响应（${response.status}）：${text.slice(0, 500)}`);
      return Response.json({ error: MSG_UNAVAILABLE }, { status: 502 });
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (requestSignal?.aborted) {
      return Response.json({ error: "分析已取消" }, { status: 499 });
    }
    const timeout = error instanceof Error && error.name === "TimeoutError";
    console.error(`[graph_generate] 请求上游失败（${upstreamUrl}）：`, error);
    return Response.json({ error: timeout ? MSG_TIMEOUT : MSG_UNAVAILABLE }, { status: timeout ? 504 : 503 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式无效" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: MSG_EMPTY }, { status: 400 });
  }
  return forwardGraphRequest(body as Record<string, unknown>, request.signal);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const question = searchParams.get("question") || "";
  const echartsType = searchParams.get("echarts_type") || searchParams.get("chart_type") || undefined;
  const streamParam = searchParams.get("stream");
  const payload: Record<string, unknown> = {
    question,
    stream: streamParam !== "false",
  };
  if (echartsType) payload.echarts_type = echartsType;
  return forwardGraphRequest(payload, request.signal);
}
