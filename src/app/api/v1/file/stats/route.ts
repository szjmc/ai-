import { getStats } from "@/lib/knowledge";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return apiOk("success", await getStats());
  } catch (error) {
    return fromError(error);
  }
}
