import { ApiError } from "./errors";
import { describeDbError, isDbError } from "./storage-mode";

export function apiOk(message: string, data: unknown = null, page: unknown = null, http = 200) {
  return Response.json({ status: 200, message, data, page }, { status: http, headers: { "Cache-Control": "no-store" } });
}
export function apiFail(statusCode: number, message: string, data: unknown = null) {
  return Response.json({ status: statusCode, message, data, page: null }, { status: statusCode, headers: { "Cache-Control": "no-store" } });
}
export function fromError(error: unknown) {
  if (error instanceof ApiError) return apiFail(error.statusCode, error.message);
  console.error("Knowledge file operation failed:", error);
  if (isDbError(error)) {
    const { reason, hint } = describeDbError(error);
    return apiFail(503, reason, { hint });
  }
  // Never expose SQL, stack traces or service credentials in a browser response.
  return apiFail(500, "文件处理失败，请稍后重试或联系管理员检查服务日志");
}
