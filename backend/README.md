# 知识文件后端（FastAPI + MinIO + MySQL）

这里保存的是你提供的后端代码与配置，未改动任何业务代码。

```
backend/
├── main.py                                  # FastAPI 入口：/api/v1/file、/api/v1/chunks、/api/v1/chat
├── .env                                     # MinIO (127.0.0.1:9100) + MySQL (127.0.0.1:3306/test_db)
├── sql/knowledge_files.sql                  # MySQL knowledge_files 建表与索引脚本
├── requirements.txt                         # 运行所需依赖
└── app/
    ├── config.py                            # Settings 配置封装
    ├── routers/
    │   ├── base_router.py                   # 路由基类
    │   └── file_handle_router.py            # POST /uploadFile
    ├── services/knowledge_file_service.py   # 业务层
    ├── dao/knowledge_file_dao.py            # 数据访问层
    ├── models/mysql/knowledge_file.py       # SQLAlchemy 模型 + DatabaseManager
    ├── schemas/
    │   ├── common.py                        # ApiResponse
    │   └── knowledge_file.py                # 知识文件 Schema
    ├── exceptions/
    │   ├── base_api_exception.py            # 异常体系
    │   └── rag_exception.py                 # RAG 流程异常
    ├── routers/chunk_router.py              # POST /parseFile 文档分片
    ├── routers/chatbot_query_router.py      # POST /systemRagQuery NRS2002 问答
    ├── services/rag_query_service.py        # 向量检索 + LLM 评分
    ├── services/rag_query_rerank_service.py # 多路召回 + 重排
    ├── services/chunk_service.py            # 下载 → 加载 → 分片 → 元数据 → Milvus
    ├── designer/strategy/chunk/             # 策略模式
    │   ├── chunking_strategy.py             # 分片策略接口
    │   ├── jieba_chunking_strategy.py       # Jieba 中文分词分片
    │   ├── metadata_strategy.py             # 元数据策略接口
    │   └── minio_metadata_strategy.py       # MinIO 文档元数据处理
    └── utils/
        ├── file_handler.py                  # 上传封装
        └── minio_client.py                  # MinIO 客户端
```

## 需要粘进 config.py 的配置

`backend/patches/config_additions.txt` 已列好可直接粘贴的 12 项（Milvus 6 项、LLM/Embedding 策略 2 项、
硅基流动 4 项）。`backend/.env` 里对应环境变量也已备好。

## ⚠️ 启动前必须补充 config.py

`app/services/chunk_service.py` 的构造函数默认参数引用了三个配置项：

```python
milvus_host: str = settings.MILVUS_HOST,
milvus_port: str = settings.MILVUS_PORT,
milvus_collection: str = settings.MILVUS_DEFAULT_COLLECTION,
```

但当前 `app/config.py` 里**没有这三项**。Python 的默认参数在**类定义时**求值，所以 `import chunk_service`
会立即抛 `AttributeError: 'Settings' object has no attribute 'MILVUS_HOST'`，
进而导致 `ChunkRouter` 导入失败、**整个 FastAPI 起不来**（连原来的上传接口也用不了）。

我没有改你的代码。请在 `app/config.py` 的 `Settings` 类里加上：

```python
    # Milvus配置
    MILVUS_HOST: str = os.getenv("MILVUS_HOST", "127.0.0.1")
    MILVUS_PORT: str = os.getenv("MILVUS_PORT", "19530")
    MILVUS_DEFAULT_COLLECTION: str = os.getenv("MILVUS_DEFAULT_COLLECTION", "knowledge_chunks")
```

并在 `.env` 中补充（已为你预留，值按实际环境改）：

```dotenv
MILVUS_HOST=127.0.0.1
MILVUS_PORT=19530
MILVUS_DEFAULT_COLLECTION=knowledge_chunks
```

## 分片功能的额外依赖

`/api/v1/chunks/parseFile` 需要这些服务同时就绪，缺一不可：

| 依赖 | 用途 | 不可用时的表现 |
| --- | --- | --- |
| MinIO | 下载原文件 | `从MinIO下载文件失败` |
| Ollama | 生成向量（`EMBEDDING_MODEL`） | `嵌入模型初始化失败` |
| Milvus | 存储分片向量 | `Milvus初始化失败` |

Python 依赖见 `requirements.txt`，分片相关的为 `jieba`、`langchain`、`langchain-community`、
`langchain-ollama`、`pymilvus`、`unstructured`。

> **注意**：`_init_vector_store` 里有 `utility.drop_collection` 和 `drop_old=True`，
> **每次调用 parseFile 都会先删除整个 Milvus 集合再重建**，即之前文件的分片会被清空。
> 这是你代码当前的行为，我没有改动；如果要累积多文件分片，需要你自己调整这段逻辑。

## 环境配置（`.env` / `backend/.env`）

```dotenv
MINIO_ENDPOINT="127.0.0.1:9100"
MINIO_ACCESS_KEY="minioadmin"
MINIO_SECRET_KEY="minioadmin"
MINIO_BUCKET="vanna-training-data"
MINIO_SECURE=False

KB_BUCKET_NAME="knowledge-base"

MYSQL_USER=root
MYSQL_PASSWORD=123456
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DB=test_db
MYSQL_URI="mysql+pymysql://${MYSQL_USER}:${MYSQL_PASSWORD}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}"
```

## 运行

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py          # http://0.0.0.0:8018
```

接口：`POST /api/v1/file/uploadFile`（multipart：`file` + `collection_name`）。
Swagger 文档：`http://127.0.0.1:8018/docs`。


---

## 智能问答（/api/v1/chat/systemRagQuery）

调用链：`chatbot_query_router.py` → `get_rag_service()` → `RAGQueryService.query_score()`
→ Milvus 向量检索 → `PromptTemplate` → LLM → 校验 JSON → 返回。

### 依赖

| 依赖 | 用途 |
| --- | --- |
| Ollama | 嵌入（`EMBEDDING_MODEL`）+ 生成（`LLM_MODEL`） |
| Milvus | 读取分片向量 |
| 硅基流动 | 可选，`LLM_STRATEGY=silicon_flow` 时启用 |

### 两个必须处理的问题

**1. 启动时就连接 Ollama/Milvus**

`ChatBotQueryRouter.__init__` 里有 `self.chunk_service = ChunkService()`，而 `main.py` 在模块级构造该
router。`ChunkService.__init__` 会连 Ollama + Milvus 并做嵌入测试，因此**任一服务未就绪，整个 FastAPI 起不来**。
建议改为惰性初始化：

```python
self._chunk_service = None

@property
def chunk_service(self):
    if self._chunk_service is None:
        self._chunk_service = ChunkService()
    return self._chunk_service
```

**2. 异常分支里的 `.code` 不存在**

```python
except (NotFoundException, ValidationException) as e:
    return ApiResponse(status=e.code, ...)   # AttributeError → 用户只看到 500
```

这两个异常只有 `.status_code`（`.code` 是 `RAGException` 的属性）。建议改为：

```python
return ApiResponse(status=getattr(e, "status_code", 400), message=str(getattr(e, "detail", e)), data={})
```

### 当前 HTTP 上没有多路召回

路由调用的是 `rag_query_service.query_score(user_question, file_id, collection_name)`，**没传
`retrieval_type`**，所以一律走默认的 `vector` 单路检索。
`rag_query_rerank_service.py` 的 `multi_retrieval_rerank`（多路召回 + 重排）目前只能通过它的
`__main__` 测试入口运行。

要开放的话：路由改成 `from app.services.rag_query_rerank_service import RAGQueryService`，
并给 `UserQueryRequest` 加
`retrieval_type: Literal["vector","bm25","hybrid","multi_rerank"] = "vector"`，再透传到 `query_score()`。

### 每次请求都会重建服务

`get_rag_service()` 每次调用都 `new RAGQueryService(...)`，重复做嵌入测试和连接，较慢。
若要提速可加缓存，例如：

```python
from functools import lru_cache

@lru_cache(maxsize=1)
def _build_rag_service() -> RAGQueryService:
    return RAGQueryService(...)

def get_rag_service() -> RAGQueryService:
    return _build_rag_service()
```
