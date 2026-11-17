import { getBackendConfig } from "@/lib/backend-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式无效" }, { status: 400 });
  }
  const threadId =
    body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).thread_id === "string"
      ? String((body as Record<string, unknown>).thread_id).trim()
      : "";

  if (!threadId) {
    return Response.json({ error: "缺少 thread_id" }, { status: 400 });
  }

  const upstreamUrl = `${getBackendConfig().graphBaseUrl}/interrupt`;
  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: threadId }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return Response.json({ error: "发送中断指令失败" }, { status: 502 });
    }
    const data = await response.json().catch(() => ({ status: 200, data: { thread_id: threadId, pause_requested: true } }));
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "分析服务暂时不可用" }, { status: 503 });
  }
}
