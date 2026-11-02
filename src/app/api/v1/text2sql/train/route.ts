import { forwardFullTrain } from "@/lib/text2sql-proxy";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST() {
  try {
    const result = await forwardFullTrain();
    return apiOk(result.message, result.data);
  } catch (error) {
    return fromError(error);
  }
}
