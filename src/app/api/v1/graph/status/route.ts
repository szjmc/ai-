import { getBackendConfig } from "@/lib/backend-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 1500;

export async function GET() {
  const cfg = getBackendConfig();
  try {
    const response = await fetch(`${cfg.fastapiUrl}/api/v1/graph/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.ok) {
      return Response.json({ status: 200, message: "success", data: { reachable: true } }, { headers: { "Cache-Control": "no-store" } });
    }
    // 部分外部后端可能仅实现了 /api/v1/graph/graph_generate 或 / 根路由
    const rootProbe = await fetch(`${cfg.fastapiUrl}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    }).catch(() => null);
    return Response.json(
      {
        status: 200,
        message: "success",
        data: {
          reachable: Boolean(rootProbe?.ok),
          reason: rootProbe?.ok ? undefined : `服务返回 HTTP ${response.status}`,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        status: 200,
        message: "success",
        data: {
          reachable: false,
          reason: "后台分析服务暂未连接",
          hint: "请确认 FastAPI 后台服务已启动",
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
