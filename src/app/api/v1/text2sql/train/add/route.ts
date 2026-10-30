import { forwardAddTraining } from "@/lib/text2sql-proxy";
import { apiFail, apiOk, fromError } from "@/lib/http";
import type { SqlTrainingItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiFail(400, "请求体必须是包含 ddl / document / sql 的 JSON 对象");
    }

    const docSource = "document" in body ? body.document : body.documentation;
    const result = await forwardAddTraining({
      ddl: body.ddl as string | string[] | undefined,
      document: docSource as string | string[] | undefined,
      sql: body.sql as SqlTrainingItem | SqlTrainingItem[] | undefined,
      question: typeof body.question === "string" ? body.question : undefined,
      auto_train: typeof body.auto_train === "boolean" ? body.auto_train : true,
    });
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
