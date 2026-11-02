# main.py
from fastapi import FastAPI, Depends
from app.routers.file_handle_router import FileHandleRouter
from app.routers.chunk_router import ChunkRouter
from app.routers.chatbot_query_router import ChatBotQueryRouter
from app.routers.config_router import ConfigRouter
from app.routers.asr_router import AsrRouter
from app.routers.text2sql_router import Text2SqlRouter
import logging.config
import uvicorn


# 配置logger
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# 移除所有现有的handler
for handler in logger.handlers[:]:
    logger.removeHandler(handler)

# 创建新的格式化器和handler
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s')
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)

# ------------------------------
# 核心修改：使用 lifespan 替代 on_event
# ------------------------------


# 创建 FastAPI 实例并绑定生命周期
app = FastAPI()



# 挂载路由（确保每个路由模块中定义了 router 实例）
app.include_router(FileHandleRouter()._register_routes(), prefix="/api/v1/file")
app.include_router(ChunkRouter()._register_routes(), prefix="/api/v1/chunks")
app.include_router(ChatBotQueryRouter()._register_routes(), prefix="/api/v1/chat")
app.include_router(ConfigRouter()._register_routes(), prefix="/api/v1/config")
app.include_router(AsrRouter()._register_routes(), prefix="/api/v1/asr")
app.include_router(Text2SqlRouter()._register_routes(), prefix="/api/v1/text2sql")

# Text2Echarts 依赖 Dify 客户端（requests / DIFY_API_KEY / DIFY_BASE_URL）等可选配置。
# 单独 try 包裹，避免图表功能缺失时连带整个后端无法启动。
try:
    from app.routers.text2echarts_router import Text2EchartsRouter
    app.include_router(Text2EchartsRouter()._register_routes(), prefix="/api/v1/text2echarts")
    logger.info("Text2Echarts 路由已挂载: /api/v1/text2echarts")
except Exception as exc:  # pragma: no cover - 依赖缺失或配置错误时降级
    logger.warning(f"Text2Echarts 路由未挂载，工作台智能图表将不可用: {exc}")
# 健康检查端点

@app.get("/")
async def root():
    return {"message": "Hello World"}



if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8018,workers=1, timeout_keep_alive=600 ,reload=True)
