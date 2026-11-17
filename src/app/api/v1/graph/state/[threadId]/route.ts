import { getBackendConfig } from "@/lib/backend-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const cleanId = (threadId || "").trim();
  if (!cleanId) {
    return Response.json({ error: "缺少 threadId" }, { status: 400 });
  }

  const upstreamUrl = `${getBackendConfig().graphBaseUrl}/state/${encodeURIComponent(cleanId)}`;
  try {
    const response = await fetch(upstreamUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) {
      return Response.json({ error: "未找到对应的线程检查点" }, { status: 404 });
    }
    if (!response.ok) {
      return Response.json({ error: "查询检查点状态失败" }, { status: 502 });
    }
    const data = await response.json();
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "分析服务暂时不可用" }, { status: 503 });
  }
}
