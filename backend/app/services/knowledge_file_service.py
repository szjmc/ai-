import uuid
from typing import Dict, Any
import logging
from app.models.mysql.knowledge_file import KnowledgeFile,DatabaseManager
from app.dao.knowledge_file_dao import KnowledgeFileDAO
from app.config import settings
logger = logging.getLogger(__name__)

db_manager = DatabaseManager(settings.MYSQL_URI)
file_dao = KnowledgeFileDAO(db_manager)
class KnowledgeFileService:
    """知识文件服务类，封装知识文件相关的数据库操作"""
    def __init__(self):
        # 初始化服务
        pass


    def save_knowledge_file(self, model_param: Dict[str, Any]) -> KnowledgeFile:
        """保存新的知识文件"""
        logger.info("保存新知识文件")
        try:
            # 使用get方法简化字段赋值，设置合理默认值
            id = uuid.uuid4()
            # 转换为字符串
            model_param['id'] = str(id)
            knowledge_file = file_dao.create_file(model_param)
            logger.info(f"知识文件保存成功! ID: {knowledge_file.id}")
            return knowledge_file
        except Exception as e:
            logger.error(f"保存知识文件失败: {str(e)}", exc_info=True)
            raise
