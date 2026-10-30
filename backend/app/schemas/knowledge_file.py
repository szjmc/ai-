from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel, Field, field_validator


# 修复的PyObjectId类，兼容Pydantic v2
class KnowledgeFileBase(BaseModel):
    collection_name: str = Field(None, max_length=256, description="集合名称")
    file_name: str = Field(None, max_length=255, description="文件名称")
    file_type: str = Field(None, max_length=20, description="文件类型")
    minio_path: str = Field(None, max_length=1000, description="MinIO中的存储路径")
    chunk_strategy: str = Field(None, max_length=20, description="分片策略")
    description: Optional[str] = Field(None, max_length=255, description="文件描述")
    status: str = Field(None, max_length=20, description="文件状态")
    version_no: Optional[int] = Field(None, description="版本号")

class KnowledgeFileCreate(KnowledgeFileBase):
    created_by: int = Field(..., max_value=2, description="创建者")

class KnowledgeFileUpdate(KnowledgeFileBase):
    id: str = Field(..., description="文件ID")

    updated_by: int = Field(None, max_value=2, description="更新者")

class KnowledgeFileDelete(KnowledgeFileBase):
    id: str = Field(..., description="文件ID")

class KnowledgeFileInDB(KnowledgeFileBase):
    created_time: datetime = Field(..., description="创建时间")
    updated_time: Optional[datetime] = Field(None, description="更新时间")
    created_by: int = Field(..., description="创建者")
    updated_by: Optional[int] = Field(None, description="更新者")

    model_config = {
        "validate_by_name": True
    }
class KnowledgeFileResponse(BaseModel):
    id: str
    collection_name: str
    file_name: str
    file_type: str
    minio_path: str
    chunk_strategy: str
    description: Optional[str] = ''
    status: str
    created_by: int
    updated_by: Optional[int] = 0
    created_time: Optional[str] = ''
    updated_time: Optional[str] = ''
    version_no: Optional[int] = 0

    # 自定义验证器，强制转换None为默认值
    @field_validator('*', mode='before')
    def replace_none_with_default(cls, v, values, **kwargs):
        field_name = kwargs['field_name']
        if v is None:
            if field_name in ['updated_by', 'version_no']:
                return 0
            elif field_name in ['created_time', 'updated_time', 'description']:
                return ''
        return v

    model_config = {
        "from_attributes": True,
        "extra": "ignore"
    }
