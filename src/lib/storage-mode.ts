import { ensureMinioBucket, ensureMysqlSchema, getBackendConfig } from "./mysql-minio";

export type StorageMode = "mysql" | "local";

export type ProbeResult = {
  ok: boolean;
  mode: StorageMode;
  minioReachable: boolean;
  reason?: string;
  hint?: string;
};

type Cached = { at: number; result: ProbeResult };

const TTL = 8000;
let cached: Cached | null = null;
let inflight: Promise<ProbeResult> | null = null;

const DB_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
  /ER_ACCESS_DENIED_ERROR|Access denied for user/i,
  /ER_BAD_DB_ERROR|Unknown database/i,
  /ER_NO_SUCH_TABLE/i,
  /ETIMEDOUT|timeout/i,
  /PROTOCOL_CONNECTION_LOST/i,
];

function collectText(error: unknown) {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof Error) {
      if (current.message) parts.push(current.message);
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "string") parts.push(code);
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") parts.push(code);
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string") parts.push(message);
    }
    break;
  }
  return parts.join(" | ");
}

export function isDbError(error: unknown) {
  const message = collectText(error);
  return DB_PATTERNS.some((pattern) => pattern.test(message));
}

export function describeDbError(error: unknown) {
  const cfg = getBackendConfig();
  const message = collectText(error) || String(error);
  if (/ECONNREFUSED/i.test(message)) {
    return {
      reason: `未检测到本机 MySQL（${cfg.mysqlHost}:${cfg.mysqlPort}）`,
      hint: `启动 MySQL（${cfg.mysqlHost}:${cfg.mysqlPort}，库 ${cfg.mysqlDb}）与 MinIO（${cfg.minioEndpoint}）后将自动切换为直连模式`,
    };
  }
  if (/ER_ACCESS_DENIED_ERROR|Access denied for user/i.test(message)) {
    return {
      reason: `MySQL 账号或密码认证失败（${cfg.mysqlUser}@${cfg.mysqlHost}:${cfg.mysqlPort}）`,
      hint: "请检查 .env 中的 MYSQL_USER 与 MYSQL_PASSWORD",
    };
  }
  if (/ER_BAD_DB_ERROR|Unknown database/i.test(message)) {
    return {
      reason: `MySQL 数据库 ${cfg.mysqlDb} 不存在`,
      hint: `请先执行 CREATE DATABASE ${cfg.mysqlDb} CHARACTER SET utf8mb4;`,
    };
  }
  if (/ER_NO_SUCH_TABLE/i.test(message)) {
    return {
      reason: "knowledge_files 表不存在",
      hint: "请执行 backend/sql/knowledge_files.sql 建表脚本",
    };
  }
  if (/timeout|ETIMEDOUT/i.test(message)) {
    return {
      reason: `连接 MySQL（${cfg.mysqlHost}:${cfg.mysqlPort}）超时`,
      hint: "请检查 MySQL 服务状态与端口配置",
    };
  }
  return { reason: "MySQL 连接或查询失败", hint: "请检查 MySQL 与 MinIO 服务状态；详细原因仅记录在服务端日志中" };
}

async function probeMinio(): Promise<boolean> {
  try {
    await ensureMinioBucket();
    return true;
  } catch {
    return false;
  }
}

async function probe(): Promise<ProbeResult> {
  const minioPromise = probeMinio();
  try {
    await ensureMysqlSchema();
    const minioReachable = await minioPromise;
    return { ok: true, mode: "mysql", minioReachable };
  } catch (error) {
    const minioReachable = await minioPromise;
    const { reason, hint } = describeDbError(error);
    return { ok: false, mode: "local", minioReachable, reason, hint };
  }
}

export async function resolveStorage(force = false): Promise<ProbeResult> {
  if (!force && cached && Date.now() - cached.at < TTL) return cached.result;
  if (!inflight) {
    inflight = probe().finally(() => {
      inflight = null;
    });
  }
  const result = await inflight;
  cached = { at: Date.now(), result };
  return result;
}

export function clearStorageCache() {
  cached = null;
}
