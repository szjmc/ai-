import { buildStoredName, parseObjectKey } from "@/lib/object-storage";
import { saveUploadedFile, updateKnowledgeFile } from "@/lib/knowledge";
import { FASTAPI_FILE_TYPES, isFileType, MAX_FILE_BYTES } from "@/lib/constants";
import { apiFail, apiOk, fromError } from "@/lib/http";
import { cacheObjectMetadata, getBackendConfig } from "@/lib/mysql-minio";
import { deriveContentType, normalizeUpload, type UploadInput } from "@/lib/records";
import { ApiError } from "@/lib/errors";
import type { FileDict } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forwardDocument(input: UploadInput): Promise<{ file: FileDict; message: string } | null> {
  const normalized = normalizeUpload(input, MAX_FILE_BYTES);
  // The original Python whitelist is unchanged. Images use the existing Next.js MinIO/MySQL adapter.
  if (!FASTAPI_FILE_TYPES.has(normalized.fileType)) return null;
  const cfg = getBackendConfig();
  try {
    const response = await fetch(`${cfg.fastapiUrl}/`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (!response.ok) return null;
  } catch { return null; }
  const body = new FormData();
  body.set("file", new Blob([new Uint8Array(input.bytes)], { type: normalized.contentType }), input.originalName);
  body.set("collection_name", normalized.collectionName);
  let response: Response;
  try {
    response = await fetch(`${cfg.fastapiUrl}/api/v1/file/uploadFile`, { method: "POST", body, signal: AbortSignal.timeout(120000) });
  } catch { throw new ApiError(502, "后端上传响应中断，请先刷新列表确认是否已入库，再决定是否重试"); }
  const payload = await response.json().catch(() => null) as { status?: number; message?: string; detail?: unknown; data?: Partial<FileDict> } | null;
  if (!response.ok || !payload?.data?.id || (payload.status != null && payload.status >= 400)) {
    // Never silently submit a second copy after the upstream accepted the request.
    throw new ApiError(response.status >= 400 && response.status < 500 ? response.status : 502,
      typeof payload?.detail === "string" ? payload.detail : payload?.message || "后端未能完成上传，请查看服务日志后重试");
  }
  const raw = payload.data;
  const file: FileDict = {
    id: raw.id!, collection_name: raw.collection_name || normalized.collectionName,
    file_name: raw.file_name || input.storedName, file_type: raw.file_type || normalized.fileType,
    minio_path: raw.minio_path || "", chunk_strategy: raw.chunk_strategy || "adaptive",
    description: raw.description || "", status: raw.status || "uploaded",
    created_time: raw.created_time || "", updated_time: raw.updated_time || "",
    created_by: raw.created_by || 0, updated_by: raw.updated_by || 0, version_no: raw.version_no || 0,
    original_name: input.originalName, file_size: input.bytes.length,
    content_type: deriveContentType(raw.file_type, input.originalName),
    file_url: `/api/v1/file/${encodeURIComponent(raw.id!)}/download`,
  };
  const located = parseObjectKey(file.minio_path, file.file_name);
  cacheObjectMetadata(located.bucket, located.objectName, { size: input.bytes.length, originalName: input.originalName, contentType: file.content_type });
  let message = "文件上传成功";
  if (normalized.description || normalized.chunkStrategy !== "adaptive") {
    try {
      Object.assign(file, await updateKnowledgeFile(file.id, {
        description: normalized.description, chunkStrategy: normalized.chunkStrategy, updatedBy: normalized.createdBy,
      }));
    } catch { message = "文件已上传；补充信息保存失败，请在文件信息中重新编辑"; }
  }
  return { file, message };
}

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > MAX_FILE_BYTES + 1024 * 1024) return apiFail(413, "文件大小超过 50MB 限制");
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || !file.name) return apiFail(400, "未提供文件");
    const type = file.name.split(".").pop()?.toLowerCase() || "";
    if (!isFileType(type)) return apiFail(415, `不支持的文件类型：${type || "未知"}`);
    if (!file.size) return apiFail(400, "文件内容为空");
    if (file.size > MAX_FILE_BYTES) return apiFail(413, "文件大小超过 50MB 限制");
    const input: UploadInput = {
      originalName: file.name, bytes: Buffer.from(await file.arrayBuffer()),
      collectionName: String(form.get("collection_name") || ""),
      description: String(form.get("description") || ""),
      chunkStrategy: String(form.get("chunk_strategy") || "adaptive"),
      createdBy: Number(form.get("created_by") || 1), storedName: buildStoredName(file.name),
    };
    normalizeUpload(input, MAX_FILE_BYTES);
    const forwarded = await forwardDocument(input);
    if (forwarded) return apiOk(forwarded.message, forwarded.file, null, 201);
    return apiOk("文件上传成功", await saveUploadedFile(input), null, 201);
  } catch (error) { return fromError(error); }
}
