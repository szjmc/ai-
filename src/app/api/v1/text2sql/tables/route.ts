import { forwardTableInfo } from "@/lib/text2sql-proxy";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tableName = searchParams.get("table_name") || "user_health_risk_assessment";
    const result = await forwardTableInfo(tableName);
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
