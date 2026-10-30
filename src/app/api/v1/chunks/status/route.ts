import { probeChunkService } from "@/lib/chunk-proxy";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reports whether the FastAPI chunking service is reachable. */
export async function GET() {
  try {
    return apiOk("success", await probeChunkService());
  } catch (error) {
    return fromError(error);
  }
}
