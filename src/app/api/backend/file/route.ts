import { readBackendFile } from "@/lib/backend-source";
import { apiFail, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const target = new URL(request.url).searchParams.get("path") ?? "";
    const found = await readBackendFile(target);
    if (!found) return apiFail(404, "源码文件不存在");
    const filename = target.split("/").pop() || "source.txt";
    return new Response(found.code, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return fromError(error);
  }
}
