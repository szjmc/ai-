import { forwardText2SqlAsk } from "@/lib/text2sql-proxy";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const question = searchParams.get("question") || "";
    if (!question.trim()) {
      return apiFail(400, "缺少查询参数 question");
    }
    const limitRaw = searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const userId = searchParams.get("user_id") || undefined;

    const result = await forwardText2SqlAsk({
      question,
      limit: Number.isFinite(limit) ? limit : undefined,
      user_id: userId,
    });
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
