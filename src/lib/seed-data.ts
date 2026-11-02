export type SeedDoc = {
  id: string;
  collectionName: string;
  originalName: string;
  storedName: string;
  fileType: string;
  chunkStrategy: string;
  description: string;
  status: string;
  createdBy: number;
  updatedBy: number | null;
  versionNo: number;
  hoursAgo: number;
  content: string;
};

export const SEED_DOCS: SeedDoc[] = [
  {
    id: "11111111-1111-4111-8111-111111111101",
    collectionName: "产品知识库",
    originalName: "知栈产品手册.md",
    storedName: "知栈产品手册_seed01.md",
    fileType: "md",
    chunkStrategy: "adaptive",
    description: "产品能力、入库字段与状态流转说明",
    status: "active",
    createdBy: 1,
    updatedBy: 1,
    versionNo: 2,
    hoursAgo: 30,
    content: `# 知栈产品手册

知栈负责把业务文档送进知识库。一次入库固定做两件事：把原文件写入对象桶，再在 knowledge_files 登记元数据。

## 入库字段

- collection_name：知识集合，例如「产品知识库」
- file_name：对象桶中的存储名，会附加短随机后缀避免重名
- file_type：文件后缀
- minio_path：对象路径，形如 knowledge-base/文件名
- chunk_strategy：默认 adaptive
- status：上传完成后为 uploaded

## 支持的文件

pdf、doc、docx、xls、xlsx、txt、sql、json、md。其他类型会在写入存储之前被拒绝。

## 状态怎么用

uploaded 表示文件已经落桶并完成登记，还没有纳入检索。核对内容后改为 active。暂时停用标 inactive，需要留痕时标 archived。
`,
  },
  {
    id: "11111111-1111-4111-8111-111111111102",
    collectionName: "产品知识库",
    originalName: "入库常见问题.txt",
    storedName: "入库常见问题_seed02.txt",
    fileType: "txt",
    chunkStrategy: "adaptive",
    description: "上传限制、状态含义与失败时的处理",
    status: "uploaded",
    createdBy: 1,
    updatedBy: null,
    versionNo: 1,
    hoursAgo: 6,
    content: `问：上传后文件存在哪里？
答：写入对象桶 knowledge-base，路径记在 minio_path。数据库只保存元数据，不保存文件正文。

问：为什么新文件的状态是 uploaded？
答：上传接口会把 status 固定写成 uploaded，分块策略默认 adaptive。激活是后续人工确认，不是上传的副作用。

问：单文件上限是多少？
答：50MB。空文件会被拒绝，不会创建记录。

问：不支持的类型会怎样？
答：返回 415。对象桶和 knowledge_files 都不会留下半成品。

问：更新描述会不会覆盖文件？
答：不会。更新只改元数据，并把 version_no 加一。
`,
  },
  {
    id: "11111111-1111-4111-8111-111111111103",
    collectionName: "运维知识库",
    originalName: "发布检查清单.md",
    storedName: "发布检查清单_seed03.md",
    fileType: "md",
    chunkStrategy: "recursive",
    description: "发布前核对对象路径、大小与激活状态",
    status: "active",
    createdBy: 2,
    updatedBy: 2,
    versionNo: 3,
    hoursAgo: 18,
    content: `# 发布检查清单

发布知识库前，按这份清单过一遍，不要只看文件名。

1. 确认集合名称与环境一致，避免把演练文档写进正式集合。
2. 打开记录，核对 file_type、file_size 与本地文件一致。
3. 用下载接口取回原文件，确认 minio_path 仍然可读。
4. 已核对的文档把状态改为 active，并记下操作者。
5. 若发布回滚，改为 inactive。不要先删除，删除会同时清掉对象文件。

操作者约定：林知衡为 1，周简为 2。
`,
  },
  {
    id: "11111111-1111-4111-8111-111111111104",
    collectionName: "运维知识库",
    originalName: "备份与恢复.txt",
    storedName: "备份与恢复_seed04.txt",
    fileType: "txt",
    chunkStrategy: "fixed",
    description: "对象桶与元数据的备份恢复顺序",
    status: "inactive",
    createdBy: 2,
    updatedBy: 1,
    versionNo: 2,
    hoursAgo: 52,
    content: `备份范围
- 对象桶 knowledge-base 中的原始文件
- knowledge_files 表中的元数据

恢复顺序
1. 先恢复对象文件，保持对象名不变。
2. 再恢复数据库记录，使 minio_path 与对象键一致。
3. 抽查下载接口，确认正文可读、大小未变。

当前状态
本文件为 inactive，不参与检索，只给运维留存。恢复演练结束后再决定是否重新激活。
`,
  },
  {
    id: "11111111-1111-4111-8111-111111111105",
    collectionName: "数据字典",
    originalName: "knowledge_files.sql",
    storedName: "knowledge_files_seed05.sql",
    fileType: "sql",
    chunkStrategy: "paragraph",
    description: "知识文件表结构与查询索引",
    status: "active",
    createdBy: 1,
    updatedBy: null,
    versionNo: 1,
    hoursAgo: 72,
    content: `-- 知识文件存储表
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
`,
  },
  {
    id: "11111111-1111-4111-8111-111111111106",
    collectionName: "数据字典",
    originalName: "术语表.json",
    storedName: "术语表_seed06.json",
    fileType: "json",
    chunkStrategy: "semantic",
    description: "入库字段与状态枚举",
    status: "uploaded",
    createdBy: 1,
    updatedBy: null,
    versionNo: 1,
    hoursAgo: 3,
    content: `{
  "collection_name": "知识文件所属集合",
  "file_name": "对象桶中的存储名",
  "file_type": "文件后缀",
  "minio_path": "对象存储路径",
  "chunk_strategy": "文档分块策略，默认 adaptive",
  "status": {
    "uploaded": "已上传，待处理",
    "active": "已激活",
    "inactive": "未激活",
    "archived": "已归档"
  }
}
`,
  },
  {
    id: "11111111-1111-4111-8111-111111111107",
    collectionName: "培训材料",
    originalName: "新人指引.md",
    storedName: "新人指引_seed07.md",
    fileType: "md",
    chunkStrategy: "adaptive",
    description: "新同学第一天的入库练习",
    status: "active",
    createdBy: 2,
    updatedBy: 2,
    versionNo: 1,
    hoursAgo: 12,
    content: `# 新人指引

欢迎加入知识库小组。先读产品手册，再按下面的顺序自己走一遍。

## 今天要完成

- 在「培训材料」集合上传一份 txt 或 md
- 打开记录，核对文件类型、对象路径和版本号
- 把描述补全。保存后 version_no 会加一，原文件不会被覆盖
- 下载原文件，确认内容和本地一致

## 不要做的事

不要把含有密钥、口令或连接串的配置文件上传到知识库。对象桶里的文件会被后续流程读取。
`,
  },
  {
    id: "11111111-1111-4111-8111-111111111108",
    collectionName: "培训材料",
    originalName: "归档规范.txt",
    storedName: "归档规范_seed08.txt",
    fileType: "txt",
    chunkStrategy: "fixed",
    description: "何时归档、何时保留、何时才能删除",
    status: "archived",
    createdBy: 1,
    updatedBy: 2,
    versionNo: 4,
    hoursAgo: 96,
    content: `归档规范

满足以下任一条件，可将文件标记为 archived：

- 文档已被新版本替代
- 业务集合已停用，但仍需保留审计痕迹
- 制度要求留存，且不再参与检索

归档后仍可下载。删除会同时移除对象桶中的文件和数据库记录，只在确认无人引用后再做。
`,
  },
];
