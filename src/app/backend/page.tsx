import { BackendBrowser } from "@/components/backend-browser";
import { loadBackendFiles } from "@/lib/backend-source";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "知栈 · 后端源码",
  description: "FastAPI 知识与 MinIO 上传后端源码索引。",
};

export default async function BackendPage() {
  const files = await loadBackendFiles();
  return <BackendBrowser files={files} />;
}
