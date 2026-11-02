import { previewKnowledgeFile } from "@/lib/knowledge";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const sheet = new URL(request.url).searchParams.get("sheet");
    if (sheet && sheet.length > 256) return apiFail(400, "工作表名称过长");
    return apiOk("success", await previewKnowledgeFile(id, sheet));
  } catch (error) { return fromError(error); }
}
