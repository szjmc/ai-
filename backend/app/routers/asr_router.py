import os
import logging
from typing import Dict, Any
from fastapi import status, UploadFile, File
import httpx

from app.routers.base_router import BaseRouter
from app.schemas.common import ApiResponse
from app.config import settings

logger = logging.getLogger("AsrRouter")


def get_asr_endpoint(base_url: str) -> str:
    trimmed = (base_url or "").strip().rstrip("/")
    if not trimmed:
        return ""
    if trimmed.lower().endswith("/audio/transcriptions") or trimmed.lower().endswith("/audio/transcribe"):
        return trimmed
    return f"{trimmed}/audio/transcriptions"


class AsrRouter(BaseRouter):
    """语音识别路由：由后端根据自己的配置直接调用 ASR 模型"""

    def __init__(self):
        logger.info("Initializing AsrRouter")
        super().__init__()
        self.router = self._register_routes()

    def _register_routes(self):
        self.router.post(
            "/transcribe",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="语音转文字",
            description="上传音频文件，调用后端配置的 ASR 模型（如 Qwen3-ASR、火山、Qwen3-Omni）进行转文字",
            tags=["语音识别"]
        )(self.transcribe_audio)

        return self.router

    async def transcribe_audio(
            self,
            file: UploadFile = File(..., description="待转录的音频文件（支持 wav/mp3/webm/m4a 等）")
    ) -> ApiResponse:
        try:
            asr_base = os.getenv("ASR_BASE_URL", getattr(settings, "ASR_BASE_URL", ""))
            asr_model = os.getenv("ASR_MODEL", getattr(settings, "ASR_MODEL", ""))
            asr_key = os.getenv("ASR_API_KEY", getattr(settings, "ASR_API_KEY", ""))

            endpoint = get_asr_endpoint(asr_base)
            if not endpoint or not asr_model:
                return ApiResponse(
                    status=501,
                    message="后端未配置 ASR_BASE_URL 或 ASR_MODEL，请检查后端的 .env 配置文件",
                    data=None
                )

            audio_content = await file.read()
            if not audio_content:
                return ApiResponse(status=400, message="音频文件内容为空", data=None)

            filename = file.filename or "audio.webm"
            headers = {}
            if asr_key:
                headers["Authorization"] = f"Bearer {asr_key}"

            files = {
                "file": (filename, audio_content, file.content_type or "audio/webm")
            }
            data = {
                "model": asr_model
            }

            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(endpoint, headers=headers, files=files, data=data)

            if resp.status_code == 401:
                return ApiResponse(
                    status=502,
                    message="后端调用 ASR 服务鉴权失败（401）：请检查后端的 ASR_API_KEY 是否正确",
                    data=None
                )

            if resp.status_code != 200:
                return ApiResponse(
                    status=502,
                    message=f"调用 ASR 模型失败（HTTP {resp.status_code}）：{resp.text[:200]}",
                    data=None
                )

            result_json = resp.json()
            text = (result_json.get("text") or "").strip()
            if not text and isinstance(result_json.get("data"), dict):
                text = (result_json["data"].get("text") or "").strip()

            if not text:
                return ApiResponse(
                    status=422,
                    message="ASR 模型未返回有效文字，可能录音时间过短或无声音",
                    data={"text": ""}
                )

            return ApiResponse(
                status=200,
                message="语音转文字成功",
                data={"text": text, "model": asr_model}
            )

        except Exception as e:
            logger.error(f"语音识别失败: {str(e)}", exc_info=True)
            return ApiResponse(status=500, message=f"语音识别服务内部异常: {str(e)}", data=None)
