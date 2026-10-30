import { forwardAsr } from "@/lib/chat-proxy";
import { getBackendConfig } from "@/lib/backend-config";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * 语音转文字路由：
 * 1. 支持前端直接传入覆盖参数（custom_api_key / custom_base_url / custom_model）
 * 2. 优先调用后端的 ASR 接口 POST {FASTAPI_URL}/api/v1/asr/transcribe
 * 3. 回退由当前服务端直接代理请求 ASR 远端服务
 */
export async function POST(request: Request) {
  try {
    const form = await request.formData().catch(() => null);
    const entry = form?.get("audio");
    if (!entry || typeof entry === "string" || !("arrayBuffer" in entry)) {
      return apiFail(400, "缺少 audio（录音文件）");
    }
    const audio = entry as File;
    if (!audio.size) return apiFail(400, "录音内容为空");
    if (audio.size > MAX_AUDIO_BYTES) return apiFail(413, "录音超过 20MB，请缩短时长");

    const customKey = String(form?.get("custom_api_key") || "").trim();
    const customBase = String(form?.get("custom_base_url") || "").trim();
    const customModel = String(form?.get("custom_model") || "").trim();

    // 1. 如果没有自定义参数，优先尝试由后端 FastAPI 执行转录
    if (!customKey && !customBase && !customModel) {
      const cfg = getBackendConfig();
      const backendAsrUrl = `${cfg.fastapiUrl}/api/v1/asr/transcribe`;
      try {
        const upstreamForm = new FormData();
        upstreamForm.append("file", audio, audio.name || "audio.webm");

        const backendResp = await fetch(backendAsrUrl, {
          method: "POST",
          body: upstreamForm,
          signal: AbortSignal.timeout(120_000),
        });

        if (backendResp.ok) {
          const backendJson = (await backendResp.json().catch(() => null)) as {
            status?: number;
            data?: { text?: string };
            message?: string;
          } | null;

          if (backendJson?.data?.text) {
            return apiOk("success", { text: backendJson.data.text, source: "fastapi_backend" });
          }
        }
      } catch {
        // 后端转录接口未开启或超时，继续回退处理
      }
    }

    // 2. 回退：由当前服务代理请求 ASR 远端服务（支持自定义覆盖参数）
    const text = await forwardAsr(audio, {
      apiKey: customKey || undefined,
      baseUrl: customBase || undefined,
      model: customModel || undefined,
    });
    return apiOk("success", { text });
  } catch (error) {
    return fromError(error);
  }
}
