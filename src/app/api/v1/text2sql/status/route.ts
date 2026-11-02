import { getText2SqlStatus } from "@/lib/text2sql-proxy";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await getText2SqlStatus();
    return apiOk("success", status);
  } catch (error) {
    return fromError(error);
  }
}
