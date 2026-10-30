import os
from dotenv import load_dotenv
from typing import Optional
# 加载.env文件
load_dotenv()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Settings:
    # Ollama配置
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://10.10.10.243:11434")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "qwen3:0.6b")
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "bge-m3:latest")

    # API配置
    API_HOST: str = os.getenv("API_HOST", "0.0.0.0")
    API_PORT: int = int(os.getenv("API_PORT", "8000"))
    API_KEY: Optional[str] = os.getenv("API_KEY")
    

    # mongodb
    MONGO_DB_HOST: str = os.getenv("MONGO_DB_HOST","")
    MONGO_DB_PORT: int = os.getenv("MONGO_DB_PORT")
    MONGO_DB_NAME: str = os.getenv("MONGO_DB_NAME","")
    MONGO_DB_USER: str = os.getenv("MONGO_DB_USER","")
    MONGO_DB_PASSWORD: str = os.getenv("MONGO_DB_PASSWORD","")
    MONGO_URI: str = os.getenv("MONGO_URI", "")

    # MinIO配置
    MINIO_ENDPOINT: str = os.getenv("MINIO_ENDPOINT", "localhost:9000")
    MINIO_ACCESS_KEY: str = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    MINIO_SECRET_KEY: str = os.getenv("MINIO_SECRET_KEY", "minioadmin")
    MINIO_BUCKET: str = os.getenv("MINIO_BUCKET", "vanna-training-data")
    MINIO_SECURE: bool = os.getenv("MINIO_SECURE", "False").lower() == "true"

    KB_BUCKET_NAME: str = os.getenv("KB_BUCKET_NAME", "")

    REDIS_URL = os.getenv("REDIS_URL", "redis://10.10.10.18:16379/0")
    REDIS_HOST = os.getenv("REDIS_HOST", "10.10.10.18")
    REDIS_PORT = os.getenv("REDIS_URL", 16379)
    REDIS_MAX_CONNECTIONS: int = int(os.getenv("REDIS_MAX_CONNECTIONS",10000))
    REDIS_SOCKET_TIMEOUT: int = int(os.getenv("REDIS_SOCKET_TIMEOUT",30))
    REDIS_SOCKET_CONNECT_TIMEOUT: int = int(os.getenv("REDIS_SOCKET_CONNECT_TIMEOUT",5))

    MYSQL_HOST: str = os.getenv("MYSQL_HOST")
    MYSQL_PORT: str = os.getenv("MYSQL_PORT")
    MYSQL_USER: str = os.getenv("MYSQL_USER")
    MYSQL_PASSWORD: str = os.getenv("MYSQL_PASSWORD")
    MYSQL_DB: str = os.getenv("MYSQL_DB")
    MYSQL_URI = os.getenv("MYSQL_URI")
    # 文件上传
    MEDIA_URL = '/media/'
    MEDIA_ROOT = os.path.join(BASE_DIR, 'media')
    FILE_UPLOAD_MAX_MEMORY_SIZE = 50 * 1024 * 1024  # 50MB
    DATA_UPLOAD_MAX_MEMORY_SIZE = 50 * 1024 * 1024  # 50MB

    # 语音识别（ASR）配置（支持 Qwen3-ASR / 火山 / Qwen3-Omni / 硅基流动）
    ASR_BASE_URL: str = os.getenv("ASR_BASE_URL", "https://api.siliconflow.cn/v1/audio/transcriptions")
    ASR_MODEL: str = os.getenv("ASR_MODEL", "Qwen/Qwen3-ASR-1.7B")
    ASR_API_KEY: str = os.getenv("ASR_API_KEY", "")

    # Milvus 向量库配置
    MILVUS_HOST: str = os.getenv("MILVUS_HOST", "127.0.0.1")
    MILVUS_PORT: str = os.getenv("MILVUS_PORT", "19530")
    MILVUS_URI: str = os.getenv("MILVUS_URI", f"http://{os.getenv('MILVUS_HOST', '127.0.0.1')}:{os.getenv('MILVUS_PORT', '19530')}")
    MILVUS_DEFAULT_COLLECTION: str = os.getenv("MILVUS_DEFAULT_COLLECTION", "rag_knowledge")
    MILVUS_DEFAULT_ALIAS: str = os.getenv("MILVUS_DEFAULT_ALIAS", "default")
    MILVUS_DEFAULT_DB: str = os.getenv("MILVUS_DEFAULT_DB", "default")

    # 策略与模型配置
    LLM_STRATEGY: str = os.getenv("LLM_STRATEGY", "ollama")
    EMBEDDING_STRATEGY: str = os.getenv("EMBEDDING_STRATEGY", "ollama")

    # 硅基流动配置
    SILICON_FLOW_API_KEY: str = os.getenv("SILICON_FLOW_API_KEY", "")
    SILICON_FLOW_BASE_URL: str = os.getenv("SILICON_FLOW_BASE_URL", "https://api.siliconflow.cn/v1")
    SILICON_FLOW_LLM_URL: str = os.getenv("SILICON_FLOW_LLM_URL", "https://api.siliconflow.cn/v1/chat/completions")
    SILICON_FLOW_EMBEDDING_URL: str = os.getenv("SILICON_FLOW_EMBEDDING_URL", "https://api.siliconflow.cn/v1/embeddings")
    SILICON_FLOW_LLM_MODEL: str = os.getenv("SILICON_FLOW_LLM_MODEL", "deepseek-ai/DeepSeek-R1")
    SILICON_FLOW_EMBEDDING_MODEL: str = os.getenv("SILICON_FLOW_EMBEDDING_MODEL", "BAAI/bge-large-zh-v1.5")

# 创建配置实例
settings = Settings()
