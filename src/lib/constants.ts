import { CHUNK_STRATEGIES, FILE_STATUSES, FILE_TYPES, type ChunkStrategy, type FileStatus, type FileType, type Operator } from "./types";

export { CHUNK_STRATEGIES, FILE_STATUSES, FILE_TYPES };

export const DEFAULT_BUCKET = "knowledge-base";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = "adaptive";
export const DEFAULT_STATUS: FileStatus = "uploaded";

export const CONTENT_TYPES: Record<FileType, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  sql: "text/sql",
  json: "application/json",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const IMAGE_TYPES = new Set<string>(["png", "jpg", "jpeg", "webp", "gif"]);
export const FASTAPI_FILE_TYPES = new Set<string>(["pdf", "doc", "docx", "xls", "xlsx", "txt", "sql", "json", "md"]);

export const STATUS_META: Record<FileStatus, { label: string; hint: string }> = {
  uploaded: { label: "已上传", hint: "已入库，等待解析或激活" },
  active: { label: "已激活", hint: "可进入后续分块与检索" },
  inactive: { label: "未激活", hint: "保留文件，暂不使用" },
  archived: { label: "已归档", hint: "历史留存，仍可下载" },
};

export const STRATEGY_META: Record<ChunkStrategy, { label: string; hint: string }> = {
  adaptive: { label: "自适应", hint: "按文档结构自动切分" },
  fixed: { label: "固定长度", hint: "等长窗口切分" },
  semantic: { label: "语义切分", hint: "沿语义边界切开" },
  recursive: { label: "递归切分", hint: "按标题层级递归" },
  paragraph: { label: "段落切分", hint: "以自然段落为单位" },
};

export const OPERATORS = [
  { id: 1, name: "林知衡", role: "知识库管理员" },
  { id: 2, name: "周简", role: "文档归档员" },
] as const;

export const TEXT_PREVIEW_TYPES = new Set(["txt", "sql", "json", "md"]);

export function isFileType(value: string): value is FileType {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, value);
}

export function isFileStatus(value: string): value is FileStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_META, value);
}

export function isChunkStrategy(value: string): value is ChunkStrategy {
  return Object.prototype.hasOwnProperty.call(STRATEGY_META, value);
}

export function operatorName(id: number | null | undefined, operators: readonly Operator[] = OPERATORS) {
  const found = operators.find((item) => item.id === id) || OPERATORS.find((item) => item.id === id);
  if (found) return found.name;
  if (!id) return "未登记";
  return `操作员 ${id}`;
}

export function statusLabel(status: string) {
  return isFileStatus(status) ? STATUS_META[status].label : status || "未知";
}

export function strategyLabel(strategy: string) {
  return isChunkStrategy(strategy) ? STRATEGY_META[strategy].label : strategy || "未设置";
}
