import { getBackendConfig } from "@/lib/backend-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

// 业务逻辑（图表配置解析、表格与报告生成）都在 FastAPI，这里只做同源转发。
// 目前只开放三种图表类型，和后端 CHART_TYPE_ALIASES 保持一致。
const CHART_TYPES = ["柱状图", "折线图", "饼图"];

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "请求格式无效" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).question !== "string" || !(body as Record<string, string>).question.trim() || typeof (body as Record<string, unknown>).echarts_type !== "string" || !(body as Record<string, string>).echarts_type.trim()) {
    return Response.json({ error: "请输入问题并选择图表类型" }, { status: 400 });
  }
  if (!CHART_TYPES.includes((body as Record<string, string>).echarts_type.trim())) {
    return Response.json({ error: "图表类型仅支持柱状图、折线图、饼图" }, { status: 400 });
  }
  try {
    const response = await fetch(`${getBackendConfig().fastapiUrl}/api/v1/text2echarts/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      cache: "no-store", signal: AbortSignal.timeout(300000),
    });
    if (response.status === 404) return Response.json({ error: "Text2Echarts 接口未找到。请确认 FastAPI 已挂载 /api/v1/text2echarts 路由。" }, { status: 502 });
    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { return Response.json({ error: "图表服务返回了无法解析的响应" }, { status: 502 }); }
    if (!response.ok) {
      const detail = (data as { detail?: unknown })?.detail;
      return Response.json({ error: typeof detail === "string" ? detail : `图表服务请求失败（${response.status}），请检查后端日志。` }, { status: 502 });
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error && error.name === "TimeoutError" ? "图表生成超时，请稍后重试" : "无法连接图表服务，请检查 FastAPI 是否运行及 FASTAPI_URL 配置。" }, { status: 503 });
  }
}
