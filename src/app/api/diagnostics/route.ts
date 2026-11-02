import { access } from "node:fs/promises";
import path from "node:path";
import { getBackendConfig } from "@/lib/mysql-minio";
import { resolveStorage } from "@/lib/storage-mode";
import { apiOk, fromError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function writable(dir: string) {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const cfg = getBackendConfig();
    const probe = await resolveStorage(true);
    const storageDir = path.join(/*turbopackIgnore: true*/ process.cwd(), "storage");
    return apiOk("success", {
      mysql: {
        host: cfg.mysqlHost,
        port: cfg.mysqlPort,
        user: cfg.mysqlUser,
        database: cfg.mysqlDb,
        table: "knowledge_files",
        reachable: probe.ok,
        mode: probe.mode,
        reason: probe.reason ?? null,
        hint: probe.hint ?? null,
      },
      minio: {
        endpoint: cfg.minioEndpoint,
        secure: cfg.minioSecure,
        default_bucket: cfg.minioBucket,
        kb_bucket_name: cfg.kbBucketName,
        reachable: probe.minioReachable,
      },
      local_mirror: {
        bucket_root: path.join(storageDir, "buckets", cfg.kbBucketName),
        exists: await writable(path.join(storageDir, "buckets", cfg.kbBucketName)),
        ledger_file: path.join(storageDir, "ledger.json"),
      },
      fonts: {
        directory: path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "fonts"),
        present: await writable(path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "fonts")),
      },
      limits: { max_file_mb: 50 },
    });
  } catch (error) {
    return fromError(error);
  }
}
