import { fetchTrainingCorpus, forwardDeleteTrainingItem } from "@/lib/text2sql-proxy";
import { apiFail, apiOk, fromError } from "@/lib/http";
import type { TrainingCategory } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const corpus = await fetchTrainingCorpus();
    return apiOk("获取训练语料成功", corpus);
  } catch (error) {
    return fromError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category") as TrainingCategory | null;
    const indexRaw = searchParams.get("index");
    if (!category || !["ddl", "document", "sql"].includes(category)) {
      return apiFail(400, "category 必须是 ddl、document 或 sql");
    }
    const index = indexRaw != null ? Number(indexRaw) : NaN;
    if (!Number.isInteger(index) || index < 0) {
      return apiFail(400, "index 必须是非负整数");
    }

    const result = await forwardDeleteTrainingItem(category, index);
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
