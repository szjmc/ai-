"""
Text2SQL 独立启动入口（可选）
当本机未启动 Milvus（原 main.py 中的 ChatBotQueryRouter 构造时需连接 Milvus）时，
可通过 python text2sql_main.py 直接在 8018 端口运行 Text2SQL 与配置路由。
"""

import logging
import uvicorn
from fastapi import FastAPI

from app.routers.config_router import ConfigRouter
from app.routers.text2sql_router import Text2SqlRouter

logger = logging.getLogger()
logger.setLevel(logging.INFO)
for handler in logger.handlers[:]:
    logger.removeHandler(handler)
console_handler = logging.StreamHandler()
console_handler.setFormatter(
    logging.Formatter("%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s")
)
logger.addHandler(console_handler)

app = FastAPI(title="知栈入库台 · Text2SQL 服务")

app.include_router(ConfigRouter()._register_routes(), prefix="/api/v1/config")
app.include_router(Text2SqlRouter()._register_routes(), prefix="/api/v1/text2sql")


@app.get("/")
async def root():
    return {"message": "Hello World", "module": "text2sql"}


if __name__ == "__main__":
    uvicorn.run(
        "text2sql_main:app",
        host="0.0.0.0",
        port=8018,
        workers=1,
        timeout_keep_alive=600,
        reload=True,
    )
