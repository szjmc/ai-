import { getBackendConfig } from "@/lib/backend-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const ALLOWED_ACTIONS = new Set(["approve", "resume", "cancel", "rerun_sql", "replay"]);
const ALLOWED_CHART_TYPES = new Set(["柱状图", "折线图", "饼图", "bar", "line", "pie"]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式无效" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "缺少恢复参数" }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const threadId = typeof payload.thread_id === "string" ? payload.thread_id.trim() : "";
  if (!threadId) {
    return Response.json({ error: "缺少 thread_id" }, { status: 400 });
  }

  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "approve";
  if (action && !ALLOWED_ACTIONS.has(action)) {
    return Response.json({ error: "不支持的恢复操作类型" }, { status: 400 });
  }

  const rawChartType =
    typeof payload.chart_type === "string"
      ? payload.chart_type.trim()
      : typeof payload.echarts_type === "string"
        ? payload.echarts_type.trim()
        : "";
  if (rawChartType && !ALLOWED_CHART_TYPES.has(rawChartType.toLowerCase()) && !ALLOWED_CHART_TYPES.has(rawChartType)) {
    return Response.json({ error: "图表类型仅支持柱状图、折线图、饼图" }, { status: 400 });
  }

  const upstreamUrl = `${getBackendConfig().graphBaseUrl}/resume`;

  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body: JSON.stringify({
        ...payload,
        thread_id: threadId,
        action: action || "approve",
        stream: payload.stream !== false,
      }),
      cache: "no-store",
      signal: request.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      if (response.status === 404) {
        return Response.json({ error: "未找到对应的检查点会话，请重新发起分析。" }, { status: 404 });
      }
      console.error(`[graph/resume] 上游失败：${response.status} ${errorText.slice(0, 500)}`);
      return Response.json({ error: "恢复执行失败，请稍后重试。" }, { status: 502 });
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
    try {
      return Response.json(JSON.parse(text), { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "分析服务返回了无效响应。" }, { status: 502 });
    }
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json({ error: "已取消恢复请求" }, { status: 499 });
    }
    console.error(`[graph/resume] 请求上游失败（${upstreamUrl}）：`, error);
    return Response.json({ error: "分析服务暂时不可用，请稍后重试。" }, { status: 503 });
  }
}
