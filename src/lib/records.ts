import { CONTENT_TYPES, DEFAULT_CHUNK_STRATEGY, isChunkStrategy, isFileStatus, isFileType } from "./constants";
import { ApiError } from "./errors";
import { matchesSearch, originalFileName } from "./file-search";
import { validateImage } from "./file-content";
import type { FileDict } from "./types";

export type Row = {
  id: string;
  versionNo: number | null;
  collectionName: string | null;
  fileName: string | null;
  fileType: string | null;
  minioPath: string | null;
  chunkStrategy: string | null;
  description: string | null;
  status: string | null;
  createdTime: Date | string | null;
  updatedTime: Date | string | null;
  createdBy: number | null;
  updatedBy: number | null;
  originalName?: string | null;
  fileSize?: number | null;
  contentType?: string | null;
};
export type ListQuery = {
  collectionName?: string; status?: string; fileType?: string; q?: string;
  page?: number; perPage?: number; sort?: string;
};
export type UploadInput = {
  originalName: string; bytes: Buffer; collectionName: string;
  description?: string | null; chunkStrategy?: string | null; createdBy?: number | null; storedName: string;
};
export type UpdateInput = {
  collectionName?: string; description?: string | null; status?: string;
  chunkStrategy?: string; updatedBy?: number | null;
};

function iso(value: Date | string | null) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function deriveOriginalName(fileName: string | null | undefined) {
  return originalFileName(fileName || "");
}

export function deriveFileType(fileType?: string | null, fileName?: string | null) {
  const supplied = (fileType || "").replace(/^\./, "").toLowerCase();
  if (isFileType(supplied)) return supplied;
  return fileName?.split(".").pop()?.toLowerCase() || supplied;
}

export function deriveContentType(fileType?: string | null, fileName?: string | null) {
  const type = deriveFileType(fileType, fileName);
  return isFileType(type) ? CONTENT_TYPES[type] : "application/octet-stream";
}

export function toDict(row: Row): FileDict {
  const fileName = row.fileName || "";
  const fileType = deriveFileType(row.fileType, fileName);
  return {
    id: row.id, collection_name: row.collectionName || "", file_name: fileName, file_type: fileType,
    minio_path: row.minioPath || "", chunk_strategy: row.chunkStrategy || "",
    description: row.description || "", status: row.status || "",
    created_time: iso(row.createdTime), updated_time: iso(row.updatedTime),
    created_by: row.createdBy ?? 0, updated_by: row.updatedBy ?? 0, version_no: row.versionNo ?? 0,
    original_name: row.originalName || deriveOriginalName(fileName), file_size: row.fileSize ?? 0,
    content_type: deriveContentType(fileType, fileName),
    file_url: `/api/v1/file/${encodeURIComponent(row.id)}/download`,
  };
}

export function normalizeUpload(input: UploadInput, maxBytes: number) {
  if (!input.originalName || input.originalName.length > 255) throw new ApiError(400, "文件名须为 1–255 个字符");
  const fileType = input.originalName.split(".").pop()?.toLowerCase() || "";
  if (!isFileType(fileType)) throw new ApiError(415, `不支持的文件类型：${fileType || "未知"}`);
  if (!input.bytes.length) throw new ApiError(400, "文件内容为空");
  if (input.bytes.length > maxBytes) throw new ApiError(413, "文件大小超过 50MB 限制");
  validateImage(input.bytes, fileType);
  const collectionName = input.collectionName.trim();
  if (!collectionName || collectionName.length > 256) throw new ApiError(400, "集合名称须为 1–256 个字符");
  const description = input.description?.trim() || null;
  if (description && description.length > 255) throw new ApiError(400, "描述不能超过 255 个字符");
  const chunkStrategy = (input.chunkStrategy || DEFAULT_CHUNK_STRATEGY).trim();
  if (!isChunkStrategy(chunkStrategy)) throw new ApiError(400, "不支持的分块策略");
  const createdBy = input.createdBy ?? 1;
  if (!Number.isSafeInteger(createdBy) || createdBy < 1 || createdBy > 2147483647) throw new ApiError(400, "创建者 ID 不合法");
  return { fileType, contentType: CONTENT_TYPES[fileType], collectionName, description, chunkStrategy, createdBy };
}

export function normalizeUpdate(input: UpdateInput) {
  const patch: Partial<Omit<Row, "id" | "createdTime">> = {};
  if (input.collectionName !== undefined) {
    const name = input.collectionName.trim();
    if (!name || name.length > 256) throw new ApiError(400, "集合名称须为 1–256 个字符");
    patch.collectionName = name;
  }
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description && description.length > 255) throw new ApiError(400, "描述不能超过 255 个字符");
    patch.description = description;
  }
  if (input.status !== undefined) {
    if (!isFileStatus(input.status)) throw new ApiError(400, "不支持的文件状态");
    patch.status = input.status;
  }
  if (input.chunkStrategy !== undefined) {
    if (!isChunkStrategy(input.chunkStrategy)) throw new ApiError(400, "不支持的分块策略");
    patch.chunkStrategy = input.chunkStrategy;
  }
  if (input.updatedBy != null) {
    if (!Number.isSafeInteger(input.updatedBy) || input.updatedBy < 1 || input.updatedBy > 2147483647) throw new ApiError(400, "操作人 ID 不合法");
    patch.updatedBy = input.updatedBy;
  }
  return patch;
}

export function normalizeQuery(query: ListQuery) {
  const integer = (value: number | undefined, fallback: number, max: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value!))) : fallback;
  return {
    page: integer(query.page, 1, 1000000), perPage: integer(query.perPage, 8, 50),
    collectionName: query.collectionName?.trim() || undefined,
    status: query.status?.trim() || undefined,
    fileType: query.fileType?.trim().toLowerCase() || undefined,
    q: query.q?.normalize("NFKC").trim().slice(0, 256) || undefined,
    sort: query.sort || "created_desc",
  };
}

export function matchRow(row: Row, query: ReturnType<typeof normalizeQuery>) {
  if (query.collectionName && row.collectionName !== query.collectionName) return false;
  if (query.status && row.status !== query.status) return false;
  if (query.fileType && deriveFileType(row.fileType, row.fileName) !== query.fileType) return false;
  return !query.q || matchesSearch(query.q, [
    row.originalName, deriveOriginalName(row.fileName), row.fileName,
    row.description, row.collectionName, row.fileType,
  ]);
}

export function sortRows(rows: Row[], sort: string) {
  return [...rows].sort((a, b) => {
    let order = 0;
    if (sort === "name") order = (a.originalName || deriveOriginalName(a.fileName)).localeCompare(b.originalName || deriveOriginalName(b.fileName), "zh-CN");
    else if (sort === "size") order = (b.fileSize ?? 0) - (a.fileSize ?? 0);
    else order = (new Date(a.createdTime || 0).getTime() - new Date(b.createdTime || 0).getTime()) * (sort === "created_asc" ? 1 : -1);
    return order || a.id.localeCompare(b.id);
  });
}
