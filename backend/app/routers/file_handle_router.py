from fastapi import status, UploadFile, File, Form

from .base_router import BaseRouter
from ..services.knowledge_file_service import KnowledgeFileService
from ..schemas.common import ApiResponse
from ..utils.file_handler import UploadFile as FileUploader
from ..config import settings
from ..exceptions.base_api_exception import (
    DatabaseException,
    ValidationException,
    UnsupportedFileTypeException
)
import logging

logger = logging.getLogger(__name__)
knowledge_file_service = KnowledgeFileService()

# 配置
KB_BUCKET_NAME = settings.KB_BUCKET_NAME
# 支持的文件类型
SUPPORTED_EXTENSIONS = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'txt': 'text/plain',
    'sql': 'text/sql',
    'json': 'application/json',
    'md': 'text/markdown'
}
class FileHandleRouter(BaseRouter):
    def __init__(self):
        logger.info("Initializing FileHandleRouter")
        super().__init__()
        self.router = self._register_routes()

    def _register_routes(self):
        """注册所有路由处理方法并添加Swagger文档注解"""
        # 上传知识文件
        self.router.post(
            "/uploadFile",
            response_model=ApiResponse,
            status_code=status.HTTP_201_CREATED,
            summary="上传知识文件",
            description="上传文档文件（如PDF、TXT等）到系统，用于后续解析和处理",
            tags=["知识管理"]
        )(self.upload_knowledge_file)

        return self.router


    async def upload_knowledge_file(
            self,
            # 1. 所有参数显式标记，文件用 File，普通字段用 Form
            file: UploadFile = File(..., description="待上传的知识文件（支持 pdf/docx/txt/xlsx）"),
            collection_name: str = Form(..., description="知识文件所属的集合名称（必填）")
    ):
        """上传知识文件并创建记录"""
        try:
            if not file:
                raise ValidationException("No file provided")

            # 获取文件后缀并验证
            file_extension = file.filename.split('.')[-1].lower() if file.filename else ''
            if file_extension not in SUPPORTED_EXTENSIONS:
                raise UnsupportedFileTypeException(f"Unsupported file type: {file_extension}")

            # 上传文件到存储
            uploaded_file = FileUploader()
            logger.info(f"KB_BUCKET_NAME:{KB_BUCKET_NAME}")
            uploaded_object = await uploaded_file.upload_file_form(file,
                                                                   KB_BUCKET_NAME)  # 假设upload_file方法已适配FastAPI的UploadFile

            if not uploaded_object:
                raise DatabaseException("Failed to upload file")

            # 创建数据库记录
            knowledge_file_param = {
                "collection_name": collection_name,
                "file_name": uploaded_object.get('stored_filename'),
                "file_type": file_extension,
                "minio_path": uploaded_object.get('file_url'),
                "chunk_strategy": 'adaptive',
                "status": 'uploaded'
            }

            knowledge_file = knowledge_file_service.save_knowledge_file(knowledge_file_param)
            logger.info(f"Uploaded knowledge file: {knowledge_file.id}")

            return ApiResponse(
                status=200,
                message="File uploaded successfully",
                data=knowledge_file.to_dict()
            )
        except ValidationException as e:
            raise
        except UnsupportedFileTypeException as e:
            raise
        except Exception as e:
            logger.error(f"Error uploading knowledge file: {str(e)}", exc_info=True)
            raise DatabaseException("Failed to upload knowledge file") from e
