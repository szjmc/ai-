import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { IMAGE_TYPES, MAX_FILE_BYTES, TEXT_PREVIEW_TYPES } from "./constants";
import { ApiError } from "./errors";
import { localDelete, localGet, localList, localReadObject, localSave, localStats, localUpdate, localUpdateContent } from "./local-ledger";
import { getBackendConfig, getObjectMetadata, readFromMinioBucket, removeFromMinioBucket, uploadToMinioBucket, type MysqlKnowledgeRow } from "./mysql-minio";
import { parseObjectKey, putObject, readObject, removeObject } from "./object-storage";
import { deriveContentType, normalizeQuery, normalizeUpdate, normalizeUpload, toDict, type ListQuery, type Row, type UpdateInput, type UploadInput } from "./records";
import { displayFileNameSql, mysqlFileWhere } from "./mysql-search";
import { createHash } from "node:crypto";
import { getDocxAssets, putDocxAssets } from "./docx-assets";
import { convertDocx, previewSpreadsheet } from "./office-preview";
import { resolveStorage } from "./storage-mode";
import type { FileDict, PreviewPayload, Stats } from "./types";

export type { ListQuery, UpdateInput, UploadInput };
const columns = sql`id, version_no, collection_name, file_name, file_type, minio_path, chunk_strategy, description, status, created_time, updated_time, created_by, updated_by`;

async function queryRows<T>(statement: SQL): Promise<T[]> {
  const [rows] = await db.execute(statement);
  return rows as unknown as T[];
}
function mapRow(row: MysqlKnowledgeRow): Row {
  return {
    id: row.id, versionNo: row.version_no, collectionName: row.collection_name,
    fileName: row.file_name, fileType: row.file_type, minioPath: row.minio_path,
    chunkStrategy: row.chunk_strategy, description: row.description, status: row.status,
    createdTime: row.created_time, updatedTime: row.updated_time,
    createdBy: row.created_by, updatedBy: row.updated_by,
  };
}
async function mapLimit<T, U>(items: T[], task: (item: T) => Promise<U>): Promise<U[]> {
  const result = new Array<U>(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, 6) }, async () => {
    while (index < items.length) {
      const current = index++;
      result[current] = await task(items[current]);
    }
  }));
  return result;
}
async function enrich(row: MysqlKnowledgeRow, minioReachable: boolean) {
  const mapped = mapRow(row);
  if (minioReachable) {
    const located = parseObjectKey(row.minio_path, row.file_name);
    const metadata = await getObjectMetadata(located.objectName, located.bucket);
    if (metadata) {
      mapped.fileSize = metadata.size;
      mapped.originalName = metadata.originalName;
    }
  }
  return toDict(mapped);
}
async function findRow(id: string) {
  const rows = await queryRows<MysqlKnowledgeRow>(sql`SELECT ${columns} FROM knowledge_files WHERE id = ${id} LIMIT 1`);
  if (!rows[0]) throw new ApiError(404, "知识文件不存在，可能已被删除");
  return rows[0];
}

async function mysqlList(query: ListQuery, minioReachable: boolean) {
  const normalized = normalizeQuery(query);
  const where = mysqlFileWhere(normalized);
  const counts = await queryRows<{ total: number }>(sql`SELECT COUNT(*) AS total FROM knowledge_files ${where}`);
  const total = Number(counts[0]?.total || 0);
  const pages = Math.max(1, Math.ceil(total / normalized.perPage));
  const page = Math.min(normalized.page, pages);
  const offset = (page - 1) * normalized.perPage;
  let items: FileDict[];
  if (normalized.sort === "size") {
    const rows = await queryRows<MysqlKnowledgeRow>(sql`SELECT ${columns} FROM knowledge_files ${where} ORDER BY id`);
    const all = await mapLimit(rows, (row) => enrich(row, minioReachable));
    items = all.sort((a, b) => b.file_size - a.file_size || a.id.localeCompare(b.id)).slice(offset, offset + normalized.perPage);
  } else {
    const order = normalized.sort === "created_asc" ? sql`created_time ASC, id ASC`
      : normalized.sort === "name" ? sql`${displayFileNameSql} ASC, id ASC` : sql`created_time DESC, id ASC`;
    const rows = await queryRows<MysqlKnowledgeRow>(sql`SELECT ${columns} FROM knowledge_files ${where} ORDER BY ${order} LIMIT ${normalized.perPage} OFFSET ${offset}`);
    items = await mapLimit(rows, (row) => enrich(row, minioReachable));
  }
  return { items, page: { page, per_page: normalized.perPage, total, pages } };
}

async function mysqlStats(minioReachable: boolean): Promise<Stats> {
  const cfg = getBackendConfig();
  const rows = await queryRows<MysqlKnowledgeRow>(sql`SELECT ${columns} FROM knowledge_files`);
  const group = (field: "collection_name" | "status" | "file_type") => {
    const groups = new Map<string, number>();
    for (const row of rows) {
      const key = row[field] || "";
      if (key) groups.set(key, (groups.get(key) || 0) + 1);
    }
    return [...groups].map(([key, count]) => ({ key, count }));
  };
  const statuses = group("status");
  const objects = minioReachable ? await mapLimit(rows, (row) => enrich(row, true)) : [];
  return {
    total: rows.length, bytes: objects.reduce((sum, file) => sum + file.file_size, 0),
    active: statuses.find((s) => s.key === "active")?.count || 0,
    uploaded: statuses.find((s) => s.key === "uploaded")?.count || 0,
    inactive: statuses.find((s) => s.key === "inactive")?.count || 0,
    archived: statuses.find((s) => s.key === "archived")?.count || 0,
    collections: group("collection_name").map(({ key, count }) => ({ name: key, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN")),
    types: group("file_type"), statuses, bucket: cfg.kbBucketName,
    storage_mode: "mysql", storage_note: `${cfg.mysqlDb}.knowledge_files`, minio_endpoint: cfg.minioEndpoint, mysql_db: cfg.mysqlDb,
  };
}

async function mysqlSave(input: UploadInput): Promise<FileDict> {
  const cfg = getBackendConfig();
  const normalized = normalizeUpload(input, MAX_FILE_BYTES);
  const id = randomUUID();
  const now = new Date();
  const uploaded = await uploadToMinioBucket(input.storedName, input.bytes, normalized.contentType, cfg.kbBucketName, input.originalName);
  try {
    await db.execute(sql`INSERT INTO knowledge_files (${columns}) VALUES (
      ${id}, 1, ${normalized.collectionName}, ${input.storedName}, ${normalized.fileType},
      ${uploaded.objectPath}, ${normalized.chunkStrategy}, ${normalized.description}, 'uploaded',
      ${now}, ${now}, ${normalized.createdBy}, NULL
    )`);
    return toDict({
      id, versionNo: 1, collectionName: normalized.collectionName, fileName: input.storedName,
      fileType: normalized.fileType, minioPath: uploaded.objectPath, chunkStrategy: normalized.chunkStrategy,
      description: normalized.description, status: "uploaded", createdTime: now, updatedTime: now,
      createdBy: normalized.createdBy, updatedBy: null, originalName: input.originalName, fileSize: input.bytes.length,
    });
  } catch (error) {
    await removeFromMinioBucket(input.storedName, cfg.kbBucketName).catch(() => undefined);
    throw error;
  }
}

async function mysqlUpdate(id: string, input: UpdateInput, minioReachable: boolean) {
  const patch = normalizeUpdate(input);
  await findRow(id);
  const sets: SQL[] = [sql`version_no = COALESCE(version_no, 0) + 1`, sql`updated_time = ${new Date()}`];
  if (patch.collectionName !== undefined) sets.push(sql`collection_name = ${patch.collectionName}`);
  if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
  if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
  if (patch.chunkStrategy !== undefined) sets.push(sql`chunk_strategy = ${patch.chunkStrategy}`);
  if (patch.updatedBy !== undefined) sets.push(sql`updated_by = ${patch.updatedBy}`);
  await db.execute(sql`UPDATE knowledge_files SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
  return enrich(await findRow(id), minioReachable);
}
async function mysqlDelete(id: string) {
  const row = await findRow(id);
  const { objectName, bucket } = parseObjectKey(row.minio_path, row.file_name);
  await removeFromMinioBucket(objectName, bucket);
  await db.execute(sql`DELETE FROM knowledge_files WHERE id = ${id}`);
  await removeObject(objectName, bucket).catch(() => undefined);
  return { id };
}
async function mysqlReadObject(id: string) {
  const record = await findRow(id);
  const located = parseObjectKey(record.minio_path, record.file_name);
  let bytes: Buffer;
  try {
    // Read the exact key with current credentials, not the expired URL stored by older backends.
    bytes = await readFromMinioBucket(located.objectName, located.bucket);
  } catch (error) {
    // Compatibility for records saved in the earlier local-cache implementation.
    try { bytes = await readObject(located.objectName, located.bucket); }
    catch {
      const code = (error as { code?: string }).code;
      if (code === "NoSuchKey" || code === "NoSuchBucket" || code === "NotFound") {
        throw new ApiError(404, "记录存在，但 MinIO 中未找到对应文件。请检查存储桶和对象路径，或重新上传原文件。");
      }
      throw new ApiError(503, "文件暂时无法读取，请检查 MinIO 服务和访问权限后重试");
    }
  }
  return { row: { ...toDict(mapRow(record)), file_size: bytes.length }, bytes };
}

export async function listKnowledgeFiles(query: ListQuery = {}) {
  const probe = await resolveStorage();
  return probe.ok ? mysqlList(query, probe.minioReachable) : localList(query);
}
export async function getStats(): Promise<Stats> {
  const probe = await resolveStorage();
  if (probe.ok) return mysqlStats(probe.minioReachable);
  return { ...await localStats(), storage_reason: probe.reason, storage_hint: probe.hint };
}
export async function getKnowledgeFile(id: string) {
  const probe = await resolveStorage();
  return probe.ok ? enrich(await findRow(id), probe.minioReachable) : localGet(id);
}
export async function saveUploadedFile(input: UploadInput) {
  const probe = await resolveStorage();
  return probe.ok ? mysqlSave(input) : localSave(input);
}
export type UpdateContentInput = {
  bytes: Buffer;
  originalName?: string;
  updatedBy?: number | null;
  description?: string | null;
};

async function mysqlUpdateContent(id: string, input: UpdateContentInput, minioReachable: boolean): Promise<FileDict> {
  const row = await findRow(id);
  const cfg = getBackendConfig();
  const located = parseObjectKey(row.minio_path, row.file_name);
  const now = new Date();

  const { buildStoredName } = await import("./object-storage");
  let originalName = input.originalName || row.file_name || "file";
  let newStoredName = input.originalName ? buildStoredName(input.originalName) : (row.file_name || buildStoredName(originalName));
  let newFileType = input.originalName ? (input.originalName.split(".").pop()?.toLowerCase() || row.file_type || "") : (row.file_type || "");
  let minioPath = row.minio_path || "";

  const contentType = deriveContentType(newFileType, originalName);

  if (minioReachable) {
    const uploaded = await uploadToMinioBucket(newStoredName, input.bytes, contentType, cfg.kbBucketName, originalName);
    minioPath = uploaded.objectPath;
    if (row.file_name && newStoredName !== row.file_name && located.objectName) {
      await removeFromMinioBucket(located.objectName, located.bucket).catch(() => undefined);
    }
  } else {
    minioPath = await putObject(newStoredName, input.bytes, cfg.kbBucketName);
    if (row.file_name && newStoredName !== row.file_name && located.objectName) {
      await removeObject(located.objectName, located.bucket).catch(() => undefined);
    }
  }
  await putObject(newStoredName, input.bytes, cfg.kbBucketName);

  const nextVersion = (row.version_no || 0) + 1;
  const updatedBy = input.updatedBy ?? row.updated_by ?? 1;

  const sets: SQL[] = [
    sql`file_name = ${newStoredName}`,
    sql`file_type = ${newFileType}`,
    sql`minio_path = ${minioPath}`,
    sql`version_no = ${nextVersion}`,
    sql`updated_time = ${now}`,
    sql`updated_by = ${updatedBy}`,
  ];
  if (input.description !== undefined && input.description !== null) {
    sets.push(sql`description = ${input.description}`);
  }

  await db.execute(sql`UPDATE knowledge_files SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
  return enrich(await findRow(id), minioReachable);
}

export async function updateKnowledgeFileContent(id: string, input: UpdateContentInput) {
  const probe = await resolveStorage();
  return probe.ok
    ? mysqlUpdateContent(id, input, probe.minioReachable)
    : localUpdateContent(id, input);
}

export async function updateKnowledgeFile(id: string, input: UpdateInput) {
  const probe = await resolveStorage();
  return probe.ok ? mysqlUpdate(id, input, probe.minioReachable) : localUpdate(id, input);
}
export async function deleteKnowledgeFile(id: string) {
  return (await resolveStorage()).ok ? mysqlDelete(id) : localDelete(id);
}
export async function readKnowledgeObject(id: string) {
  return (await resolveStorage()).ok ? mysqlReadObject(id) : localReadObject(id);
}
export async function previewKnowledgeFile(id: string, sheet?: string | null): Promise<PreviewPayload> {
  const row = await getKnowledgeFile(id);
  if (row.file_type === "pdf" || IMAGE_TYPES.has(row.file_type)) {
    return { kind: row.file_type === "pdf" ? "pdf" : "image", text: "", truncated: false, content_type: row.content_type };
  }
  if (!["docx", "xlsx", "xls"].includes(row.file_type) && !TEXT_PREVIEW_TYPES.has(row.file_type)) {
    return { kind: "binary", text: "", truncated: false, content_type: row.content_type };
  }
  const { bytes } = await readKnowledgeObject(id);
  if (row.file_type === "docx") {
    const key = docxCacheKey(row);
    const stamp = createHash("sha1").update(key).digest("hex").slice(0, 12);
    // Images are served separately (see readDocxAsset) instead of being inlined as base64.
    const converted = await convertDocx(bytes, (index) => `/api/v1/file/${encodeURIComponent(id)}/preview-asset?i=${index}&v=${stamp}`);
    putDocxAssets(key, converted.assets);
    return { kind: "document", text: "", truncated: converted.truncated, content_type: row.content_type, document_html: converted.html, warnings: converted.warnings };
  }
  if (row.file_type === "xlsx" || row.file_type === "xls") return previewSpreadsheet(bytes, row.content_type, sheet);
  const text = bytes.toString("utf8");
  return { kind: "text", text: text.slice(0, 200000), truncated: text.length > 200000, content_type: row.content_type };
}

/** Cache key that changes whenever the record is edited or the object is replaced. */
function docxCacheKey(row: FileDict) {
  return `${row.id}:${row.version_no}:${row.updated_time}:${row.file_size}`;
}

/** One image embedded in a DOCX; rebuilt from the original file if the short-lived cache has expired. */
export async function readDocxAsset(id: string, index: number) {
  const row = await getKnowledgeFile(id);
  if (row.file_type !== "docx") throw new ApiError(404, "该文件没有可显示的内嵌图片");
  const key = docxCacheKey(row);
  let assets = getDocxAssets(key);
  if (!assets) {
    const { bytes } = await readKnowledgeObject(id);
    assets = (await convertDocx(bytes, () => "")).assets;
    putDocxAssets(key, assets);
  }
  const asset = assets[index];
  if (!asset) throw new ApiError(404, "图片不存在");
  return asset;
}
