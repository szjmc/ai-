import { forwardRagQuery } from "@/lib/chat-proxy";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The query embeds the question, hits Milvus and runs the LLM.
export const maxDuration = 600;

/**
 * Pure passthrough to FastAPI POST /api/v1/chat/systemRagQuery.
 * No retrieval or LLM logic lives here; the body is forwarded unchanged.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiFail(400, "请求体必须是 JSON 对象");
    }
    // The backend's UserQueryRequest requires all three.
    if (typeof body.question !== "string" || !body.question.trim()) {
      return apiFail(400, "缺少 question（请描述患者信息）");
    }
    if (typeof body.file_id !== "string" || !body.file_id.trim()) {
      return apiFail(400, "缺少 file_id（请先选择知识文件）");
    }
    if (typeof body.collection_name !== "string" || !body.collection_name.trim()) {
      return apiFail(400, "缺少 collection_name（Milvus 集合名）");
    }

    const result = await forwardRagQuery({
      question: body.question,
      file_id: body.file_id,
      collection_name: body.collection_name,
      top_k: typeof body.top_k === "number" ? body.top_k : undefined,
    });
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
