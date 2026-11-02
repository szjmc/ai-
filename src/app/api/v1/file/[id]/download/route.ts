import { readKnowledgeObject } from "@/lib/knowledge";
import { fromError } from "@/lib/http";
import { imageContentType, parseByteRange } from "@/lib/file-content";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const { row, bytes } = await readKnowledgeObject(id);
    const type = imageContentType(bytes) || row.content_type || "application/octet-stream";
    const safeInline = type === "application/pdf" || /^image\/(png|jpeg|webp|gif)$/.test(type) || type.startsWith("text/") || type === "application/json";
    const inline = new URL(request.url).searchParams.get("disposition") === "inline" && safeInline;
    const name = row.original_name || row.file_name || "download";
    const ascii = name.replace(/[^\x20-\x7E]|["\\]/g, "_");
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = new Headers({
      "Content-Type": type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    });
    const range = parseByteRange(request.headers.get("range"), bytes.length);
    if (range === "invalid") {
      headers.set("Content-Range", `bytes */${bytes.length}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.length}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
      return new Response(new Uint8Array(bytes.subarray(range.start, range.end + 1)), { status: 206, headers });
    }
    headers.set("Content-Length", String(bytes.length));
    return new Response(new Uint8Array(bytes), { headers });
  } catch (error) { return fromError(error); }
}
