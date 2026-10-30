import { forwardParseFile } from "@/lib/chunk-proxy";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Chunking is long-running: downloading, jieba, embedding and the Milvus write.
export const maxDuration = 800;

/**
 * Pure passthrough to FastAPI POST /api/v1/chunks/parseFile.
 * No chunking logic lives here; the request body is forwarded unchanged.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiFail(400, "请求体必须是 JSON 对象");
    }
    // The backend requires these two; checking here gives a clearer message than a 500.
    if (typeof body.file_id !== "string" || !body.file_id.trim()) {
      return apiFail(400, "缺少 file_id");
    }
    if (typeof body.minio_path !== "string" || !body.minio_path.trim()) {
      return apiFail(400, "缺少 minio_path");
    }

    const result = await forwardParseFile(body);
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
