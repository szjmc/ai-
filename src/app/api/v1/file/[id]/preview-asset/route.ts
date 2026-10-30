import { readDocxAsset } from "@/lib/knowledge";
import { apiFail, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** Serves one image embedded in a DOCX, referenced by the document preview as ?i=<index>. */
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const raw = new URL(request.url).searchParams.get("i") || "";
    const index = Number(raw);
    if (!/^\d{1,5}$/.test(raw) || !Number.isSafeInteger(index)) return apiFail(400, "图片序号不合法");
    const asset = await readDocxAsset(id, index);
    return new Response(new Uint8Array(asset.bytes), {
      headers: {
        "Content-Type": asset.contentType,
        "Content-Length": String(asset.bytes.length),
        // The preview URL carries a version stamp, so a changed file gets new URLs.
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) { return fromError(error); }
}
