import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), "backend");

export type BackendFile = {
  path: string;
  group: string;
  label: string;
  note: string;
  code: string;
  lines: number;
  bytes: number;
};

type Entry = { path: string; group: string; label: string; note: string };

export const BACKEND_ENTRIES: Entry[] = [
  { path: "sql/knowledge_files.sql", group: "SQL 脚本", label: "sql/knowledge_files.sql", note: "MySQL knowledge_files 建表与索引" },
  { path: ".env", group: "入口", label: ".env", note: "MinIO (127.0.0.1:9100) 与 MySQL (127.0.0.1:3306/test_db) 配置" },
  { path: "main.py", group: "入口", label: "main.py", note: "FastAPI 实例与路由挂载" },
  { path: "app/config.py", group: "入口", label: "app/config.py", note: "Settings 配置封装" },
  { path: "app/routers/base_router.py", group: "路由", label: "base_router.py", note: "路由基类" },
  {
    path: "app/routers/file_handle_router.py",
    group: "路由",
    label: "file_handle_router.py",
    note: "POST /uploadFile",
  },
  {
    path: "app/services/knowledge_file_service.py",
    group: "业务层",
    label: "knowledge_file_service.py",
    note: "保存知识文件",
  },
  {
    path: "app/dao/knowledge_file_dao.py",
    group: "数据访问",
    label: "knowledge_file_dao.py",
    note: "增删改查与分页",
  },
  {
    path: "app/models/mysql/knowledge_file.py",
    group: "数据模型",
    label: "models/mysql/knowledge_file.py",
    note: "SQLAlchemy 模型与 DatabaseManager",
  },
  { path: "app/schemas/common.py", group: "数据结构", label: "schemas/common.py", note: "ApiResponse" },
  {
    path: "app/schemas/knowledge_file.py",
    group: "数据结构",
    label: "schemas/knowledge_file.py",
    note: "知识文件 Schema",
  },
  {
    path: "app/exceptions/base_api_exception.py",
    group: "异常",
    label: "exceptions/base_api_exception.py",
    note: "统一异常体系",
  },
  { path: "app/utils/file_handler.py", group: "工具", label: "utils/file_handler.py", note: "上传封装" },
  { path: "app/utils/minio_client.py", group: "工具", label: "utils/minio_client.py", note: "MinIO 客户端" },
  { path: "requirements.txt", group: "运行", label: "requirements.txt", note: "运行依赖" },
  { path: "README.md", group: "运行", label: "README.md", note: "目录说明与启动方式" },
];

function resolveSafe(relative: string) {
  const target = path.resolve(ROOT, relative);
  if (!target.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("路径不合法");
  }
  return target;
}

export async function loadBackendFiles(): Promise<BackendFile[]> {
  const files: BackendFile[] = [];
  for (const entry of BACKEND_ENTRIES) {
    try {
      const code = await readFile(resolveSafe(entry.path), "utf8");
      files.push({
        ...entry,
        code,
        lines: code.split("\n").length,
        bytes: Buffer.byteLength(code, "utf8"),
      });
    } catch {
      // Missing file: keep the catalogue honest instead of failing the page.
      files.push({ ...entry, code: "// 文件尚未写入", lines: 1, bytes: 0 });
    }
  }
  return files;
}

export async function readBackendFile(relative: string) {
  const entry = BACKEND_ENTRIES.find((item) => item.path === relative);
  if (!entry) return null;
  const code = await readFile(resolveSafe(entry.path), "utf8");
  return { entry, code };
}
