import { probeChatService } from "@/lib/chat-proxy";
import { asrStatus, getBackendDefaultCollection, fetchFastApiConfig } from "@/lib/asr-config";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reports FastAPI reachability, ASR readiness, and backend system config. */
export async function GET() {
  try {
    const [chat, asr, collection, backendSys] = await Promise.all([
      probeChatService(),
      asrStatus(),
      getBackendDefaultCollection(),
      fetchFastApiConfig(),
    ]);

    return apiOk("success", {
      chat,
      asr,
      defaults: { collection_name: collection || "rag_knowledge" },
      backend_config: backendSys,
    });
  } catch (error) {
    return fromError(error);
  }
}
