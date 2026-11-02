import { getBackendConfig } from "@/lib/mysql-minio";
import { resolveStorage } from "@/lib/storage-mode";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = getBackendConfig();
  const probe = await resolveStorage(true);
  return Response.json({
    ok: true,
    database: probe.ok,
    minio: probe.minioReachable,
    mode: probe.mode,
    mysql_db: cfg.mysqlDb,
    minio_endpoint: cfg.minioEndpoint,
    bucket: cfg.kbBucketName,
  });
}
