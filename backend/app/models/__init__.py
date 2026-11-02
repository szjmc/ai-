# 包导出：chatbot_query_router 使用 `from app.models import KnowledgeFile`
# knowledge_file.py 位于 app/models/mysql/ 下，这里补充导出以支持包级导入。
from app.models.mysql.knowledge_file import KnowledgeFile, DatabaseManager  # noqa: F401

__all__ = ["KnowledgeFile", "DatabaseManager"]
