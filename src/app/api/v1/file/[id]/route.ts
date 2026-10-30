import { deleteKnowledgeFile, getKnowledgeFile, updateKnowledgeFile } from "@/lib/knowledge";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return apiOk("success", await getKnowledgeFile(id));
  } catch (error) {
    return fromError(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return apiFail(400, "请求体不能为空");

    const updated = await updateKnowledgeFile(id, {
      collectionName: typeof body.collection_name === "string" ? body.collection_name : undefined,
      description: body.description === undefined ? undefined : body.description == null ? null : String(body.description),
      status: typeof body.status === "string" ? body.status : undefined,
      chunkStrategy: typeof body.chunk_strategy === "string" ? body.chunk_strategy : undefined,
      updatedBy: body.updated_by == null ? undefined : Number(body.updated_by),
    });
    return apiOk("知识文件已更新", updated);
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    return apiOk("文件已删除", await deleteKnowledgeFile(id));
  } catch (error) {
    return fromError(error);
  }
}
