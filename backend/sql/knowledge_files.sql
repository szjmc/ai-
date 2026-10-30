CREATE TABLE knowledge_files (
    id VARCHAR(36) PRIMARY KEY COMMENT '主键ID，使用UUID格式',
    version_no INT COMMENT '版本号',
    collection_name VARCHAR(256) COMMENT '知识库集合名称',
    file_name VARCHAR(255) COMMENT '文件名称',
    file_type VARCHAR(20) COMMENT '文件类型',
    minio_path VARCHAR(1000) COMMENT 'MinIO存储路径',
    chunk_strategy VARCHAR(20) COMMENT '文档分块策略',
    description VARCHAR(255) COMMENT '文件描述',
    status VARCHAR(20) COMMENT '文件状态(active/inactive/archived等)',
    created_time DATETIME COMMENT '创建时间',
    updated_time DATETIME COMMENT '更新时间',
    created_by INT COMMENT '创建者ID',
    updated_by INT COMMENT '更新者ID') COMMENT='知识文件存储表';
-- 添加索引以提高查询性能
CREATE INDEX idx_knowledge_files_collection ON knowledge_files(collection_name) COMMENT '按集合名称查询索引';
CREATE INDEX idx_knowledge_files_status ON knowledge_files(status) COMMENT '按状态查询索引';
CREATE INDEX idx_knowledge_files_created_time ON knowledge_files(created_time) COMMENT '按创建时间查询索引';
CREATE INDEX idx_knowledge_files_file_type ON knowledge_files(file_type) COMMENT '按文件类型查询索引';
-- 可选：添加复合索引
CREATE INDEX idx_knowledge_files_collection_status ON knowledge_files(collection_name, status) COMMENT '集合和状态复合索引';
