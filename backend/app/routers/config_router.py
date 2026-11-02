import os
import logging
from typing import Dict, Any
from fastapi import status

from app.routers.base_router import BaseRouter
from app.schemas.common import ApiResponse
from app.config import settings

logger = logging.getLogger("ConfigRouter")


def normalize_asr_endpoint(base_url: str) -> str:
    """标准化 ASR 端点：兼容基础地址与完整地址"""
    trimmed = (base_url or "").strip().rstrip("/")
    if not trimmed:
        return ""
    if trimmed.lower().endswith("/audio/transcriptions") or trimmed.lower().endswith("/audio/transcribe"):
        return trimmed
    return f"{trimmed}/audio/transcriptions"


class ConfigRouter(BaseRouter):
    """系统配置路由：供前端直接调用获取后端的真实配置"""

    def __init__(self):
        logger.info("Initializing ConfigRouter")
        super().__init__()
        self.router = self._register_routes()

    def _register_routes(self):
        # 系统配置获取端点
        self.router.get(
            "/systemConfig",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="获取后端系统配置",
            description="供前端获取后端配置的 ASR 语音模型、Milvus 集合、Ollama/硅基流动策略等",
            tags=["系统配置"]
        )(self.get_system_config)

        # 根路径别名，兼容直接请求 /api/v1/config/
        self.router.get(
            "/",
            response_model=ApiResponse,
            status_code=status.HTTP_200_OK,
            summary="获取后端系统配置（别名）",
            include_in_schema=False
        )(self.get_system_config)

        return self.router

    async def get_system_config(self) -> ApiResponse:
        """获取后端真实配置，向前端暴露可用的服务状态（密钥等敏感凭据不返回明文）"""
        try:
            asr_base = os.getenv("ASR_BASE_URL", getattr(settings, "ASR_BASE_URL", ""))
            asr_model = os.getenv("ASR_MODEL", getattr(settings, "ASR_MODEL", ""))
            asr_key = os.getenv("ASR_API_KEY", getattr(settings, "ASR_API_KEY", ""))

            milvus_host = os.getenv("MILVUS_HOST", getattr(settings, "MILVUS_HOST", "127.0.0.1"))
            milvus_port = os.getenv("MILVUS_PORT", getattr(settings, "MILVUS_PORT", "19530"))
            milvus_collection = os.getenv("MILVUS_DEFAULT_COLLECTION", getattr(settings, "MILVUS_DEFAULT_COLLECTION", "rag_knowledge"))

            ollama_url = os.getenv("OLLAMA_BASE_URL", getattr(settings, "OLLAMA_BASE_URL", "http://127.0.0.1:11434"))
            llm_model = os.getenv("LLM_MODEL", getattr(settings, "LLM_MODEL", "qwen3:8b"))
            emb_model = os.getenv("EMBEDDING_MODEL", getattr(settings, "EMBEDDING_MODEL", "bge-m3:latest"))

            llm_strategy = os.getenv("LLM_STRATEGY", getattr(settings, "LLM_STRATEGY", "ollama"))
            emb_strategy = os.getenv("EMBEDDING_STRATEGY", getattr(settings, "EMBEDDING_STRATEGY", "ollama"))

            asr_endpoint = normalize_asr_endpoint(asr_base)
            is_asr_configured = bool(asr_endpoint and asr_model)

            config_data: Dict[str, Any] = {
                "asr": {
                    "configured": is_asr_configured,
                    "model": asr_model,
                    "base_url": asr_base,
                    "endpoint": asr_endpoint,
                    "has_api_key": bool(asr_key),
                    "source": "fastapi_backend",
                },
                "milvus": {
                    "host": milvus_host,
                    "port": milvus_port,
                    "default_collection": milvus_collection,
                },
                "ollama": {
                    "base_url": ollama_url,
                    "llm_model": llm_model,
                    "embedding_model": emb_model,
                },
                "strategy": {
                    "llm_strategy": llm_strategy,
                    "embedding_strategy": emb_strategy,
                },
            }

            return ApiResponse(
                status=200,
                message="获取后端配置成功",
                data=config_data
            )
        except Exception as e:
            logger.error(f"获取后端配置失败: {str(e)}", exc_info=True)
            return ApiResponse(status=500, message=f"获取配置失败: {str(e)}", data=None)
