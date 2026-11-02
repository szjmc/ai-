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

    SILICON_FLOW_LLM_MODEL: str = os.getenv("SILICON_FLOW_LLM_MODEL")
    SILICON_FLOW_EMBEDDING_MODEL: str = os.getenv("SILICON_FLOW_EMBEDDING_MODEL")
    # 新增策略配置
    LLM_STRATEGY: str = os.getenv("LLM_STRATEGY")
    EMBEDDING_STRATEGY: str = os.getenv("EMBEDDING_STRATEGY")
    SILICON_FLOW_API_KEY: str = os.getenv("SILICON_FLOW_API_KEY")
    SILICON_FLOW_BASE_URL: str = os.getenv("SILICON_FLOW_BASE_URL")
    # API配置
    API_HOST: str = os.getenv("API_HOST", "0.0.0.0")
    API_PORT: int = int(os.getenv("API_PORT", "8000"))
    API_KEY: Optional[str] = os.getenv("API_KEY")

    # mongodb
    MONGO_DB_HOST: str = os.getenv("MONGO_DB_HOST", "")
    MONGO_DB_PORT: int = int(os.getenv("MONGO_DB_PORT", "27017"))
    MONGO_DB_NAME: str = os.getenv("MONGO_DB_NAME", "")
    MONGO_DB_USER: str = os.getenv("MONGO_DB_USER", "")
    MONGO_DB_PASSWORD: str = os.getenv("MONGO_DB_PASSWORD", "")
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
    REDIS_PORT = int(os.getenv("REDIS_PORT", 16379))  # 修复：原来读成REDIS_URL
    REDIS_MAX_CONNECTIONS: int = int(os.getenv("REDIS_MAX_CONNECTIONS", 10000))
    REDIS_SOCKET_TIMEOUT: int = int(os.getenv("REDIS_SOCKET_TIMEOUT", 30))
    REDIS_SOCKET_CONNECT_TIMEOUT: int = int(os.getenv("REDIS_SOCKET_CONNECT_TIMEOUT", 5))

    # Milvus 补齐默认值
    MILVUS_URI: str = os.getenv("MILVUS_URI", "http://127.0.0.1:19530")
    MILVUS_HOST: str = os.getenv("MILVUS_HOST", "127.0.0.1")
    MILVUS_PORT: int = int(os.getenv("MILVUS_PORT", "19530"))
    MILVUS_DEFAULT_COLLECTION: str = os.getenv("MILVUS_DEFAULT_COLLECTION", "rag_collection")
    MILVUS_DEFAULT_ALIAS: str = os.getenv("MILVUS_DEFAULT_ALIAS", "default")
    MILVUS_DEFAULT_DB: str = os.getenv("MILVUS_DEFAULT_DB") or "default"

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


# 创建配置实例
settings = Settings()
