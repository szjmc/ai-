import { getBackendConfig } from "@/lib/backend-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

// 业务逻辑（图表配置解析、表格与报告生成）都在 FastAPI，这里只做同源转发。
// 目前只开放三种图表类型，和后端 CHART_TYPE_ALIASES 保持一致。
const CHART_TYPES = ["柱状图", "折线图", "饼图"];

// 面向用户的提示：后端地址、路由挂载、上游状态码等细节只写服务端日志。
const MSG_BAD_TYPE = "图表类型仅支持柱状图、折线图、饼图";
const MSG_UNAVAILABLE = "分析服务暂时不可用，请稍后重试。";
const MSG_TIMEOUT = "分析超时，请稍后重试。";

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "请求格式无效" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).question !== "string" || !(body as Record<string, string>).question.trim() || typeof (body as Record<string, unknown>).echarts_type !== "string" || !(body as Record<string, string>).echarts_type.trim()) {
    return Response.json({ error: "请输入问题并选择图表类型" }, { status: 400 });
  }
  if (!CHART_TYPES.includes((body as Record<string, string>).echarts_type.trim())) {
    return Response.json({ error: MSG_BAD_TYPE }, { status: 400 });
  }
  try {
    const upstream = `${getBackendConfig().fastapiUrl}/api/v1/text2echarts/generate`;
    const response = await fetch(upstream, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      cache: "no-store", signal: AbortSignal.timeout(300000),
    });
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch {
      console.error(`[text2echarts] 上游返回了非 JSON 响应（${response.status}）：${text.slice(0, 500)}`);
      return Response.json({ error: MSG_UNAVAILABLE }, { status: 502 });
    }
    if (!response.ok) {
      // 后端对图表类型的校验结果可以透传；其它错误只记日志，不下发内部细节。
      const detail = (data as { detail?: unknown })?.detail;
      if (response.status === 400 && detail === MSG_BAD_TYPE) return Response.json({ error: MSG_BAD_TYPE }, { status: 400 });
      console.error(`[text2echarts] 上游失败：${response.status} ${JSON.stringify(data).slice(0, 500)}`);
      return Response.json({ error: MSG_UNAVAILABLE }, { status: 502 });
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    console.error(`[text2echarts] 请求上游失败（${getBackendConfig().fastapiUrl}）：`, error);
    return Response.json({ error: timeout ? MSG_TIMEOUT : MSG_UNAVAILABLE }, { status: timeout ? 504 : 503 });
  }
}
