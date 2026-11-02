-- 知识文件存储表
CREATE TABLE knowledge_files (
    id VARCHAR(36) PRIMARY KEY,
    version_no INT,
    collection_name VARCHAR(256),
    file_name VARCHAR(255),
    file_type VARCHAR(20),
    minio_path VARCHAR(1000),
    chunk_strategy VARCHAR(20),
    description VARCHAR(255),
    status VARCHAR(20),
    created_time TIMESTAMP,
    updated_time TIMESTAMP,
    created_by INT,
    updated_by INT
);

CREATE INDEX idx_knowledge_files_collection ON knowledge_files(collection_name);
CREATE INDEX idx_knowledge_files_status ON knowledge_files(status);
CREATE INDEX idx_knowledge_files_created_time ON knowledge_files(created_time);
CREATE INDEX idx_knowledge_files_file_type ON knowledge_files(file_type);
CREATE INDEX idx_knowledge_files_collection_status ON knowledge_files(collection_name, status);
