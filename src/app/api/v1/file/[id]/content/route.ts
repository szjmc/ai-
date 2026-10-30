import { getKnowledgeFile, readKnowledgeObject, updateKnowledgeFileContent } from "@/lib/knowledge";
import { isFileType, MAX_FILE_BYTES, TEXT_PREVIEW_TYPES } from "@/lib/constants";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Fetch raw text content for editable text files */
export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const file = await getKnowledgeFile(id);
    if (!TEXT_PREVIEW_TYPES.has(file.file_type) && !["txt", "md", "json", "sql"].includes(file.file_type)) {
      return apiFail(400, "该文件类型不支持在线直接读取文本");
    }
    const { bytes } = await readKnowledgeObject(id);
    const content = bytes.toString("utf8");
    return apiOk("success", { content, file });
  } catch (error) {
    return fromError(error);
  }
}

/** Online text content edit: updates the file in MinIO and MySQL/local storage */
export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const file = await getKnowledgeFile(id);

    const body = (await request.json().catch(() => null)) as {
      content?: unknown;
      updated_by?: unknown;
      description?: unknown;
    } | null;

    if (!body || typeof body.content !== "string") {
      return apiFail(400, "缺少要保存的文件文本内容");
    }

    const bytes = Buffer.from(body.content, "utf8");
    if (bytes.length > MAX_FILE_BYTES) {
      return apiFail(413, "文件内容大小超过 50MB 限制");
    }

    const updatedBy = body.updated_by != null ? Number(body.updated_by) : undefined;
    const description = typeof body.description === "string" ? body.description.trim() : undefined;

    const updated = await updateKnowledgeFileContent(id, {
      bytes,
      originalName: file.original_name,
      updatedBy,
      description,
    });

    return apiOk("文件内容已更新", updated);
  } catch (error) {
    return fromError(error);
  }
}

/** Replace file with new uploaded document/image/file */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const existing = await getKnowledgeFile(id);

    const form = await request.formData();
    const entry = form.get("file");
    if (!entry || typeof entry === "string" || !("name" in entry) || typeof entry.arrayBuffer !== "function") {
      return apiFail(400, "未提供替换文件");
    }

    const file = entry as File;
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    if (!isFileType(extension)) {
      return apiFail(415, `不支持的文件类型：${extension || "未知"}`);
    }
    if (file.size === 0) return apiFail(400, "文件内容为空");
    if (file.size > MAX_FILE_BYTES) return apiFail(413, "文件大小超过 50MB 限制");

    const bytes = Buffer.from(await file.arrayBuffer());
    const updatedByRaw = form.get("updated_by");
    const updatedBy = updatedByRaw != null ? Number(updatedByRaw) : undefined;

    const updated = await updateKnowledgeFileContent(id, {
      bytes,
      originalName: file.name,
      updatedBy: Number.isFinite(updatedBy) ? updatedBy : existing.updated_by,
    });

    return apiOk("文件内容已替换更新", updated);
  } catch (error) {
    return fromError(error);
  }
}
