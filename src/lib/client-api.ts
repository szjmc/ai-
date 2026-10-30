import type { ApiBody, ChatStatus, ChunkResult, ChunkServiceStatus, FileDict, Operator, PageInfo, PreviewPayload, RagQueryResult, Stats } from "./types";

async function readBody<T>(response: Response): Promise<ApiBody<T>> {
  const body = await response.json().catch(() => null) as ApiBody<T> | null;
  if (!body || typeof body.message !== "string") throw new Error(`请求失败（${response.status}），请稍后重试`);
  if (!response.ok || body.status >= 400) {
    const hint = body.data && typeof body.data === "object" && "hint" in body.data ? String(body.data.hint || "") : "";
    throw new Error(hint ? `${body.message}：${hint}` : body.message);
  }
  return body;
}
export type ListParams = { q?: string; collectionName?: string; status?: string; fileType?: string; page?: number; perPage?: number; sort?: string };

export async function fetchFileList(params: ListParams, signal?: AbortSignal) {
  const search = new URLSearchParams();
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.collectionName) search.set("collection_name", params.collectionName);
  if (params.status) search.set("status", params.status);
  if (params.fileType) search.set("file_type", params.fileType);
  search.set("page", String(params.page || 1));
  search.set("per_page", String(params.perPage || 8));
  if (params.sort) search.set("sort", params.sort);
  const body = await readBody<FileDict[]>(await fetch(`/api/v1/file/list?${search}`, { cache: "no-store", signal }));
  const page: PageInfo = body.page || { page: 1, per_page: params.perPage || 8, total: 0, pages: 1 };
  return { items: body.data || [], page };
}
export async function fetchOperators(signal?: AbortSignal) {
  return (await readBody<Operator[]>(await fetch("/api/operators", { cache: "no-store", signal }))).data || [];
}
export async function createOperator(payload: { name: string; id?: number }) {
  return (await readBody<Operator>(await fetch("/api/operators", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }))).data;
}
export async function renameOperator(id: number, name: string) {
  return (await readBody<Operator>(await fetch("/api/operators", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name }),
  }))).data;
}
export async function fetchStats(signal?: AbortSignal) {
  return (await readBody<Stats>(await fetch("/api/v1/file/stats", { cache: "no-store", signal }))).data;
}
export async function fetchFile(id: string, signal?: AbortSignal) {
  return (await readBody<FileDict>(await fetch(`/api/v1/file/${encodeURIComponent(id)}`, { cache: "no-store", signal }))).data;
}
export async function fetchPreview(id: string, signal?: AbortSignal, sheet?: string) {
  const query = sheet ? `?sheet=${encodeURIComponent(sheet)}` : "";
  return (await readBody<PreviewPayload>(await fetch(`/api/v1/file/${encodeURIComponent(id)}/preview${query}`, { cache: "no-store", signal }))).data;
}
export async function fetchFileBlob(id: string, signal?: AbortSignal) {
  const response = await fetch(`/api/v1/file/${encodeURIComponent(id)}/download?disposition=inline`, { cache: "no-store", signal });
  if (!response.ok) await readBody(response);
  return response.blob();
}
export async function updateFile(id: string, payload: Record<string, unknown>) {
  return (await readBody<FileDict>(await fetch(`/api/v1/file/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }))).data;
}
export async function fetchChatStatus(signal?: AbortSignal) {
  return (await readBody<ChatStatus>(await fetch("/api/v1/chat/status", { cache: "no-store", signal }))).data;
}
/** Forwards to FastAPI /api/v1/chat/systemRagQuery. Retrieval happens entirely on the backend. */
export async function askRagQuery(payload: {
  question: string; file_id: string; collection_name: string; top_k?: number;
}, signal?: AbortSignal) {
  return (await readBody<RagQueryResult>(
    await fetch("/api/v1/chat/systemRagQuery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  )).data;
}
export async function transcribeAudio(
  audio: Blob,
  filename = "speech.webm",
  customConfig?: { apiKey?: string; baseUrl?: string; model?: string },
) {
  const form = new FormData();
  form.set("audio", audio, filename);
  if (customConfig?.apiKey) form.set("custom_api_key", customConfig.apiKey);
  if (customConfig?.baseUrl) form.set("custom_base_url", customConfig.baseUrl);
  if (customConfig?.model) form.set("custom_model", customConfig.model);

  return (await readBody<{ text: string }>(
    await fetch("/api/v1/chat/asr", { method: "POST", body: form })
  )).data.text;
}
export async function fetchFileContent(id: string, signal?: AbortSignal) {
  return (await readBody<{ content: string; file: FileDict }>(
    await fetch(`/api/v1/file/${encodeURIComponent(id)}/content`, { cache: "no-store", signal })
  )).data;
}
export async function updateFileTextContent(id: string, content: string, updatedBy?: number, description?: string) {
  return (await readBody<FileDict>(
    await fetch(`/api/v1/file/${encodeURIComponent(id)}/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, updated_by: updatedBy, description }),
    })
  )).data;
}
export async function replaceFileContent(id: string, file: File, updatedBy?: number) {
  const form = new FormData();
  form.set("file", file);
  if (updatedBy != null) form.set("updated_by", String(updatedBy));
  return (await readBody<FileDict>(
    await fetch(`/api/v1/file/${encodeURIComponent(id)}/content`, {
      method: "POST",
      body: form,
    })
  )).data;
}
export async function deleteFile(id: string) {
  await readBody(await fetch(`/api/v1/file/${encodeURIComponent(id)}`, { method: "DELETE" }));
}
export async function fetchChunkServiceStatus(signal?: AbortSignal) {
  return (await readBody<ChunkServiceStatus>(
    await fetch("/api/v1/chunks/status", { cache: "no-store", signal })
  )).data;
}
/** Forwards to FastAPI /api/v1/chunks/parseFile. The payload shape is the backend's. */
export async function parseFileChunks(payload: Record<string, unknown>, signal?: AbortSignal) {
  return (await readBody<ChunkResult>(
    await fetch("/api/v1/chunks/parseFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  )).data;
}
export function uploadFile(form: FormData, onProgress: (value: number) => void): Promise<ApiBody<FileDict>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/file/uploadFile");
    xhr.timeout = 150000;
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onerror = () => reject(new Error("网络连接中断，请刷新列表确认上传结果"));
    xhr.ontimeout = () => reject(new Error("上传超时，请刷新列表确认是否已入库，避免重复上传"));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as ApiBody<FileDict>;
        if (xhr.status >= 200 && xhr.status < 300 && body.status < 400 && body.data?.id) resolve(body);
        else reject(new Error(body.message || "文件上传失败"));
      } catch { reject(new Error("上传响应无法解析，请刷新列表确认结果")); }
    };
    xhr.send(form);
  });
}
