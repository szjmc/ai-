import { addOperator, listOperators, renameOperator } from "@/lib/operators";
import { apiFail, apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return apiOk("success", await listOperators());
  } catch (error) { return fromError(error); }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { name?: unknown; id?: unknown } | null;
    if (!body) return apiFail(400, "请求体不能为空");
    return apiOk("操作人已添加", await addOperator({ name: body.name, id: body.id }), null, 201);
  } catch (error) { return fromError(error); }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
    if (!body) return apiFail(400, "请求体不能为空");
    return apiOk("操作人已更新", await renameOperator(Number(body.id), body.name));
  } catch (error) { return fromError(error); }
}
