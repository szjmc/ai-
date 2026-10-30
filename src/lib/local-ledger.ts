import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_BYTES } from "./constants";
import { ApiError } from "./errors";
import { getBackendConfig } from "./backend-config";
import { bucketName, parseObjectKey, putObject, readObject, removeObject } from "./object-storage";
import { matchRow, normalizeQuery, normalizeUpdate, normalizeUpload, sortRows, toDict, type ListQuery, type Row, type UpdateInput, type UploadInput } from "./records";
import type { Stats } from "./types";

/** Resolved lazily so deployments (and tests) can relocate storage via KB_STORAGE_ROOT. */
function storageRoot() {
  return process.env.KB_STORAGE_ROOT || path.join(process.cwd(), "storage");
}
function ledgerFile() {
  return path.join(storageRoot(), "ledger.json");
}
const state = globalThis as typeof globalThis & { __kbLocalQueue?: Promise<unknown> };
function serialize<T>(task: () => Promise<T>) {
  const run = (state.__kbLocalQueue || Promise.resolve()).then(task, task);
  state.__kbLocalQueue = run.catch(() => undefined);
  return run;
}
async function readRows(): Promise<Row[] | null> {
  try {
    const document = JSON.parse(await readFile(/* turbopackIgnore: true */ ledgerFile(), "utf8")) as { rows?: Row[] };
    if (!Array.isArray(document.rows)) throw new ApiError(503, "本地演示台账格式不正确，请先备份并检查数据文件");
    return document.rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeRows(rows: Row[]) {
  await mkdir(/* turbopackIgnore: true */ storageRoot(), { recursive: true });
  const file = ledgerFile();
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(/* turbopackIgnore: true */ temp, JSON.stringify({ rows }, null, 2));
  await rename(/* turbopackIgnore: true */ temp, /* turbopackIgnore: true */ file);
}
async function withRows<T>(task: (rows: Row[]) => Promise<T> | T) {
  return serialize(async () => {
    // No sample data is ever generated: the ledger only contains files you uploaded.
    return task((await readRows()) ?? []);
  });
}
export async function localList(query: ListQuery = {}) {
  const normalized = normalizeQuery(query);
  return withRows((rows) => {
    const found = sortRows(rows.filter((row) => matchRow(row, normalized)), normalized.sort);
    const pages = Math.max(1, Math.ceil(found.length / normalized.perPage));
    const page = Math.min(normalized.page, pages);
    const start = (page - 1) * normalized.perPage;
    return { items: found.slice(start, start + normalized.perPage).map(toDict), page: { page, per_page: normalized.perPage, total: found.length, pages } };
  });
}
export async function localStats(): Promise<Stats> {
  return withRows((rows) => {
    const cfg = getBackendConfig();
    const count = (status: string) => rows.filter((row) => row.status === status).length;
    const group = (field: "collectionName" | "fileType" | "status") => {
      const counts = new Map<string, number>();
      for (const row of rows) { const key = row[field] || ""; if (key) counts.set(key, (counts.get(key) || 0) + 1); }
      return [...counts].map(([key, count]) => ({ key, count }));
    };
    return {
      total: rows.length, bytes: rows.reduce((sum, row) => sum + (row.fileSize || 0), 0),
      active: count("active"), uploaded: count("uploaded"), inactive: count("inactive"), archived: count("archived"),
      bucket: bucketName(), collections: group("collectionName").map(({ key, count }) => ({ name: key, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN")),
      types: group("fileType"), statuses: group("status"), storage_mode: "local", storage_note: "storage/ledger.json",
      minio_endpoint: cfg.minioEndpoint, mysql_db: cfg.mysqlDb,
    };
  });
}
export async function localGet(id: string) {
  return withRows((rows) => {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new ApiError(404, "知识文件不存在，可能已被删除");
    return toDict(row);
  });
}
export async function localSave(input: UploadInput) {
  const normalized = normalizeUpload(input, MAX_FILE_BYTES);
  const now = new Date().toISOString();
  const minioPath = await putObject(input.storedName, input.bytes);
  const row: Row = {
    id: randomUUID(), versionNo: 1, collectionName: normalized.collectionName,
    fileName: input.storedName, fileType: normalized.fileType, minioPath,
    chunkStrategy: normalized.chunkStrategy, description: normalized.description, status: "uploaded",
    createdTime: now, updatedTime: now, createdBy: normalized.createdBy, updatedBy: null,
    originalName: input.originalName, fileSize: input.bytes.length, contentType: normalized.contentType,
  };
  try { return await withRows(async (rows) => { await writeRows([row, ...rows]); return toDict(row); }); }
  catch (error) { await removeObject(input.storedName).catch(() => undefined); throw error; }
}
export async function localUpdate(id: string, input: UpdateInput) {
  const patch = normalizeUpdate(input);
  return withRows(async (rows) => {
    const current = rows.find((row) => row.id === id);
    if (!current) throw new ApiError(404, "知识文件不存在");
    const next = { ...current, ...patch, versionNo: (current.versionNo || 0) + 1, updatedTime: new Date().toISOString() };
    await writeRows(rows.map((row) => row.id === id ? next : row));
    return toDict(next);
  });
}
export async function localDelete(id: string) {
  return withRows(async (rows) => {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new ApiError(404, "知识文件不存在");
    const located = parseObjectKey(row.minioPath, row.fileName);
    await removeObject(located.objectName, located.bucket);
    await writeRows(rows.filter((row) => row.id !== id));
    return { id };
  });
}
export async function localUpdateContent(id: string, input: { bytes: Buffer; originalName?: string; updatedBy?: number | null; description?: string | null }) {
  return withRows(async (rows) => {
    const current = rows.find((row) => row.id === id);
    if (!current) throw new ApiError(404, "知识文件不存在");
    const located = parseObjectKey(current.minioPath, current.fileName);
    let fileName = current.fileName;
    let fileType = current.fileType;
    let originalName = current.originalName;
    let minioPath = current.minioPath;

    if (input.originalName) {
      const ext = input.originalName.split(".").pop()?.toLowerCase() || current.fileType || "";
      fileType = ext;
      originalName = input.originalName;
      const { buildStoredName } = await import("./object-storage");
      const newStoredName = buildStoredName(input.originalName);
      fileName = newStoredName;
      minioPath = await putObject(newStoredName, input.bytes, located.bucket);
      if (located.objectName && located.objectName !== newStoredName) {
        await removeObject(located.objectName, located.bucket).catch(() => undefined);
      }
    } else {
      if (located.objectName) {
        await putObject(located.objectName, input.bytes, located.bucket);
      }
    }

    const next: Row = {
      ...current,
      fileName,
      fileType,
      originalName,
      minioPath,
      fileSize: input.bytes.length,
      versionNo: (current.versionNo || 0) + 1,
      updatedTime: new Date().toISOString(),
      updatedBy: input.updatedBy ?? current.updatedBy ?? 1,
      description: input.description !== undefined ? input.description : current.description,
    };
    await writeRows(rows.map((row) => (row.id === id ? next : row)));
    return toDict(next);
  });
}
export async function localReadObject(id: string) {
  const row = await localGet(id);
  const located = parseObjectKey(row.minio_path, row.file_name);
  try { return { row, bytes: await readObject(located.objectName, located.bucket) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(404, "记录存在，但原文件已丢失，请重新上传原文件");
    throw error;
  }
}
