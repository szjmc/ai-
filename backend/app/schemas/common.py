from typing import Optional, Any

from pydantic import BaseModel, Field


class ApiResponse(BaseModel):
    """
    通用API响应模型，适用于所有需要返回 status/message/data 结构的接口

    示例:
    {
        "status": 200,
        "message": "操作成功",
        "data": {...}
    }
    """
    status: int = Field(..., description="状态码：200表示成功，非200表示错误")
    message: str = Field(..., description="响应信息：成功/错误描述")
    data: Optional[Any] = Field(None, description="业务数据：成功时返回具体数据，错误时可为None")
    page: Optional[Any] = Field(None, description="分页信息")

    model_config = {
        # 关键修改1：允许从对象属性解析数据（对应旧版 orm_mode=True）
        "from_attributes": True,
        # 关键修改2：允许 data/page 字段为任意类型（如嵌套字典、列表）
        "arbitrary_types_allowed": True,
        "json_schema_extra": {
            "examples": [
                {
                    "status": 200,
                    "message": "success",
                    "data": {"id": "123", "name": "示例数据"},
                    "page": {"pageSize": 10, "pageNum": 1}
                },
                {
                    "status": 404,
                    "message": "资源不存在",
                    "data": None
                }
            ]
        }
    }
