import { Client as MinioSdkClient } from "minio";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getBackendConfig } from "./backend-config";
import { MAX_FILE_BYTES } from "./constants";
import { ApiError } from "./errors";

export { getBackendConfig } from "./backend-config";
export type MysqlKnowledgeRow = {
  id: string; version_no: number | null; collection_name: string | null;
  file_name: string | null; file_type: string | null; minio_path: string | null;
  chunk_strategy: string | null; description: string | null; status: string | null;
  created_time: Date | string | null; updated_time: Date | string | null;
  created_by: number | null; updated_by: number | null;
};
export type ObjectMetadata = { size: number; originalName?: string; contentType?: string };
const state = globalThis as typeof globalThis & {
  __kbMinioClient?: MinioSdkClient;
  __kbObjectMetadata?: Map<string, { at: number; value: ObjectMetadata }>;
  __kbObjectSizes?: Map<string, number>;
};

export const objectCacheKey = (bucket: string, name: string) => `${bucket}/${name}`;
export function getSizeCache() { return state.__kbObjectSizes ??= new Map(); }
export function cacheObjectMetadata(bucket: string, name: string, metadata: ObjectMetadata) {
  const cache = state.__kbObjectMetadata ??= new Map();
  if (cache.size > 2000) cache.clear();
  cache.set(objectCacheKey(bucket, name), { at: Date.now(), value: metadata });
  getSizeCache().set(objectCacheKey(bucket, name), metadata.size);
}
export function getMinioClient() {
  if (!state.__kbMinioClient) {
    const cfg = getBackendConfig();
    if (!cfg.minioAccessKey || !cfg.minioSecretKey) throw new ApiError(503, "请在服务端配置 MinIO 访问凭据");
    state.__kbMinioClient = new MinioSdkClient({
      endPoint: cfg.minioHost, port: cfg.minioPort, useSSL: cfg.minioSecure,
      accessKey: cfg.minioAccessKey, secretKey: cfg.minioSecretKey,
    });
    // Each SDK operation and response stream is bounded below.
  }
  return state.__kbMinioClient;
}

/** Validate the existing table; never silently create a different schema/database. */
export async function ensureMysqlSchema() {
  await db.execute(sql`SELECT id, file_name, minio_path FROM knowledge_files LIMIT 0`);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(503, `${label}超时，请检查 MinIO 连接`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function ensureMinioBucket(bucket = getBackendConfig().kbBucketName) {
  const client = getMinioClient();
  if (!await withTimeout(client.bucketExists(bucket), 3000, "检查存储桶")) {
    try { await withTimeout(client.makeBucket(bucket), 3000, "创建存储桶"); }
    catch (error) {
      if (!await client.bucketExists(bucket)) throw error;
    }
  }
  return bucket;
}

export async function uploadToMinioBucket(name: string, bytes: Buffer, contentType: string, bucket = getBackendConfig().kbBucketName, originalName?: string) {
  await ensureMinioBucket(bucket);
  await withTimeout(getMinioClient().putObject(bucket, name, bytes, bytes.length, {
    "Content-Type": contentType,
    ...(originalName ? { "X-Amz-Meta-Original-Name": encodeURIComponent(originalName) } : {}),
  }), 60000, "上传文件");
  cacheObjectMetadata(bucket, name, { size: bytes.length, originalName, contentType });
  // Keep a stable key, not a URL that expires after seven days.
  return { storedName: name, bucket, objectPath: `${bucket}/${name}` };
}

export async function getObjectMetadata(name: string, bucket = getBackendConfig().kbBucketName): Promise<ObjectMetadata | null> {
  const key = objectCacheKey(bucket, name);
  const cached = state.__kbObjectMetadata?.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  try {
    const stat = await withTimeout(getMinioClient().statObject(bucket, name), 2000, "读取对象信息");
    const rawName = stat.metaData?.["original-name"] || stat.metaData?.["x-amz-meta-original-name"];
    let originalName: string | undefined;
    if (typeof rawName === "string") {
      try { originalName = decodeURIComponent(rawName); } catch { originalName = rawName; }
    }
    const metadata = { size: stat.size, originalName, contentType: stat.metaData?.["content-type"] as string | undefined };
    cacheObjectMetadata(bucket, name, metadata);
    return metadata;
  } catch { return null; }
}

export async function readFromMinioBucket(name: string, bucket = getBackendConfig().kbBucketName) {
  const stream = await withTimeout(getMinioClient().getObject(bucket, name), 8000, "读取文件");
  const timer = setTimeout(() => stream.destroy(new ApiError(503, "读取文件超时，请稍后重试")), 60000);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_FILE_BYTES) throw new ApiError(413, "文件超过 50MB 在线预览限制");
      chunks.push(bytes);
    }
    getSizeCache().set(objectCacheKey(bucket, name), size);
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); stream.destroy(); }
}

export async function removeFromMinioBucket(name: string, bucket = getBackendConfig().kbBucketName) {
  await withTimeout(getMinioClient().removeObject(bucket, name), 5000, "删除对象");
  const key = objectCacheKey(bucket, name);
  state.__kbObjectMetadata?.delete(key);
  getSizeCache().delete(key);
}
