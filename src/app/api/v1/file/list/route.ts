import { listKnowledgeFiles } from "@/lib/knowledge";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") || "1");
    const perPage = Number(url.searchParams.get("per_page") || "8");
    const result = await listKnowledgeFiles({
      collectionName: url.searchParams.get("collection_name") || undefined,
      status: url.searchParams.get("status") || undefined,
      fileType: url.searchParams.get("file_type") || undefined,
      q: url.searchParams.get("q") || undefined,
      sort: url.searchParams.get("sort") || undefined,
      page: Number.isFinite(page) ? page : 1,
      perPage: Number.isFinite(perPage) ? perPage : 8,
    });
    return apiOk("success", result.items, result.page);
  } catch (error) {
    return fromError(error);
  }
}
