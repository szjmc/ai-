import { DEFAULT_BUCKET } from "./constants";

function env(name: string, fallback = "") {
  return (process.env[name] ?? fallback).trim().replace(/^["']|["']$/g, "");
}

/**
 * Server-only connection settings. Credentials are never returned to the UI.
 *
 * The fallbacks below mirror the local MinIO / MySQL setup this project targets, so a
 * missing or overwritten `.env` still points at the right services instead of silently
 * failing to authenticate. Real values in `.env` / `.env.local` always win.
 */
export function getBackendConfig() {
  const endpoint = env("MINIO_ENDPOINT", "127.0.0.1:9100");
  const minioSecure = env("MINIO_SECURE", "False").toLowerCase() === "true";
  const url = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `${minioSecure ? "https" : "http"}://${endpoint}`);
  return {
    minioEndpoint: url.host,
    minioHost: url.hostname,
    minioPort: Number(url.port || (minioSecure ? 443 : 80)),
    minioSecure,
    minioAccessKey: env("MINIO_ACCESS_KEY", "minioadmin"),
    minioSecretKey: env("MINIO_SECRET_KEY", "minioadmin"),
    minioBucket: env("MINIO_BUCKET", "vanna-training-data"),
    kbBucketName: env("KB_BUCKET_NAME", DEFAULT_BUCKET),
    mysqlHost: env("MYSQL_HOST", "127.0.0.1"),
    mysqlPort: Number(env("MYSQL_PORT", "3306")),
    mysqlUser: env("MYSQL_USER", "root"),
    mysqlPassword: env("MYSQL_PASSWORD", "123456"),
    mysqlDb: env("MYSQL_DB", "test_db"),
    fastapiUrl: env("FASTAPI_URL", "http://127.0.0.1:8018").replace(/\/$/, ""),
  };
}
