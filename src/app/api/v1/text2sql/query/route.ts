import { forwardText2SqlQuery } from "@/lib/text2sql-proxy";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiFail(400, "请求体必须是 JSON 对象");
    }
    if (typeof body.question !== "string" || !body.question.trim()) {
      return apiFail(400, "缺少 question（请输入自然语言查询问题）");
    }

    const result = await forwardText2SqlQuery({
      question: body.question,
      user_id: typeof body.user_id === "string" ? body.user_id : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      auto_execute: typeof body.auto_execute === "boolean" ? body.auto_execute : true,
    });
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
