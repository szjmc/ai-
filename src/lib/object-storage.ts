import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_BUCKET } from "./constants";
import { ApiError } from "./errors";

/** Resolved lazily so deployments (and tests) can relocate storage via KB_STORAGE_ROOT. */
function bucketsRoot() {
  return path.join(process.env.KB_STORAGE_ROOT || path.join(process.cwd(), "storage"), "buckets");
}
export function bucketName() { return process.env.KB_BUCKET_NAME?.trim() || DEFAULT_BUCKET; }

export function assertSafeObjectName(name: string) {
  if (!name || name.length > 1024 || name.startsWith("/") || /[\\\x00-\x1f]/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ApiError(400, "对象名不合法");
  }
}
function assertSafeBucket(bucket: string) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new ApiError(400, "存储桶名称不合法");
}
function objectFile(bucket: string, name: string) {
  assertSafeBucket(bucket);
  assertSafeObjectName(name);
  const base = path.resolve(bucketsRoot(), bucket);
  const file = path.resolve(base, name);
  if (!file.startsWith(base + path.sep)) throw new ApiError(400, "对象路径不合法");
  return file;
}
export function objectKey(name: string, bucket = bucketName()) { return `${bucket}/${name}`; }
export function buildStoredName(original: string) {
  const leaf = original.split(/[/\\]/).pop() || "file";
  const safe = leaf.replace(/[^\w\-.\u4e00-\u9fa5]/g, "_");
  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 ? safe.slice(dot).toLowerCase() : "";
  const base = (dot > 0 ? safe.slice(0, dot) : safe) || "file";
  return `${base.slice(0, 180)}_${randomUUID().replace(/-/g, "").slice(0, 8)}${extension}`;
}
export async function putObject(name: string, bytes: Buffer, bucket = bucketName()) {
  const file = objectFile(bucket, name);
  await mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  await writeFile(/* turbopackIgnore: true */ file, bytes);
  return objectKey(name, bucket);
}
export async function readObject(name: string, bucket = bucketName()) {
  return readFile(/* turbopackIgnore: true */ objectFile(bucket, name));
}
export async function removeObject(name: string, bucket = bucketName()) {
  try { await unlink(/* turbopackIgnore: true */ objectFile(bucket, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** minio_path is authoritative: it can point to a different bucket or a nested key. */
export function parseObjectKey(minioPath?: string | null, fallbackName?: string | null) {
  let bucket = bucketName();
  let objectName = "";
  const raw = minioPath?.trim();
  if (raw && /^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const parts = url.pathname.replace(/^\//, "").split("/");
      if (parts.length >= 2) {
        bucket = decodeURIComponent(parts.shift()!);
        objectName = decodeURIComponent(parts.join("/"));
      }
    } catch { throw new ApiError(400, "存储记录中的对象 URL 无法解析"); }
  } else if (raw?.includes("/")) {
    const normalized = raw.replace(/^\/+/, "");
    const slash = normalized.indexOf("/");
    bucket = normalized.slice(0, slash);
    objectName = normalized.slice(slash + 1);
  }
  if (!objectName) objectName = fallbackName || raw || "";
  assertSafeBucket(bucket);
  assertSafeObjectName(objectName);
  return { bucket, objectName };
}
