import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBackendConfig } from "./backend-config";
import { ApiError } from "./errors";
import type {
  AddTrainingPayload,
  AddTrainingResult,
  FullTrainResult,
  SqlTrainingItem,
  TableColumnInfo,
  Text2SqlQueryPayload,
  Text2SqlQueryResult,
  Text2SqlStatus,
  TrainingCategory,
  TrainingCorpusData,
} from "./types";

/**
 * Transport & JSON corpus bridge for FastAPI Text2SQL service (app/routers/text2sql_router.py).
 *
 * Vanna vector training, SQL generation, and MySQL query execution run exclusively in
 * the Python FastAPI service. When FastAPI is offline, this layer still reads (and when
 * auto_train=false, updates) the shared JSON training file backend/app/data/vanna_training_data.json
 * so users can inspect and curate ddl/document/sql entries before starting the backend.
 */

const PROBE_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;
const TRAIN_TIMEOUT_MS = 5 * 60 * 1000;

type UpstreamEnvelope = {
  status?: number;
  message?: string;
  data?: unknown;
  detail?: unknown;
};

export function trainingJsonPath() {
  if (process.env.VANNA_TRAINING_FILE) {
    return process.env.VANNA_TRAINING_FILE;
  }
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "backend", "app", "data", "vanna_training_data.json");
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

export function normalizeTextArray(raw: unknown): string[] {
  if (raw == null) return [];
  const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of items) {
    const cleaned = normalizeText(item);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

export function normalizeSqlArray(raw: unknown, defaultQuestion?: string): SqlTrainingItem[] {
  if (raw == null) return [];
  const qFallback = normalizeText(defaultQuestion);
  if (typeof raw === "string") {
    const cleaned = normalizeText(raw);
    if (!cleaned) return [];
    return qFallback ? [{ question: qFallback, sql: cleaned }] : [cleaned];
  }
  const items = Array.isArray(raw) ? raw : typeof raw === "object" ? [raw] : [];
  const out: SqlTrainingItem[] = [];
  for (const entry of items) {
    if (typeof entry === "string") {
      const cleaned = normalizeText(entry);
      if (cleaned) {
        out.push(qFallback && items.length === 1 ? { question: qFallback, sql: cleaned } : cleaned);
      }
    } else if (entry && typeof entry === "object" && "sql" in entry) {
      const sqlText = normalizeText((entry as { sql?: unknown }).sql);
      const qText = normalizeText((entry as { question?: unknown }).question);
      if (sqlText) {
        out.push(qText ? { question: qText, sql: sqlText } : sqlText);
      }
    }
  }
  return out;
}

function textFingerprint(text: string): string {
  return normalizeText(text).replace(/\s+/g, " ").toLowerCase();
}

function sqlFingerprint(entry: SqlTrainingItem): string {
  if (typeof entry === "string") {
    return `||${normalizeText(entry).replace(/\s+/g, " ").replace(/;+$/, "").toLowerCase()}`;
  }
  const q = normalizeText(entry.question).toLowerCase();
  const s = normalizeText(entry.sql).replace(/\s+/g, " ").replace(/;+$/, "").toLowerCase();
  return `${q}||${s}`;
}

function formatMtime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

let writeQueue: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

async function readLocalTrainingCorpus(): Promise<TrainingCorpusData> {
  const file = trainingJsonPath();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ file, "utf8");
    const parsed = (raw.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
    const ddl = normalizeTextArray(parsed.ddl);
    const document = normalizeTextArray("document" in parsed ? parsed.document : parsed.documentation);
    const sql = normalizeSqlArray(parsed.sql);
    const fileStat = await stat(/* turbopackIgnore: true */ file);
    return {
      ddl,
      document,
      sql,
      counts: {
        ddl: ddl.length,
        document: document.length,
        sql: sql.length,
        total: ddl.length + document.length + sql.length,
      },
      file_name: path.basename(file),
      updated_at: formatMtime(fileStat.mtime),
      source: "local_json",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ddl: [],
        document: [],
        sql: [],
        counts: { ddl: 0, document: 0, sql: 0, total: 0 },
        file_name: path.basename(file),
        updated_at: "",
        source: "local_json",
      };
    }
    throw new ApiError(503, `读取训练 JSON 文件失败（${path.basename(file)}），请检查 JSON 格式是否合法`);
  }
}

async function atomicWriteCorpus(file: string, payload: { ddl: string[]; document: string[]; sql: SqlTrainingItem[] }) {
  const dir = path.dirname(file);
  await mkdir(/* turbopackIgnore: true */ dir, { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(/* turbopackIgnore: true */ temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(/* turbopackIgnore: true */ temp, /* turbopackIgnore: true */ file);
}

async function appendLocalTrainingCorpus(payload: AddTrainingPayload): Promise<AddTrainingResult> {
  const submittedDdl = normalizeTextArray(payload.ddl);
  const submittedDoc = normalizeTextArray(payload.document);
  const submittedSql = normalizeSqlArray(payload.sql, payload.question);

  if (!submittedDdl.length && !submittedDoc.length && !submittedSql.length) {
    throw new ApiError(400, "请至少提供 ddl、document 或 sql 中的一项非空训练内容");
  }

  return serializeWrite(async () => {
    const file = trainingJsonPath();
    const current = await readLocalTrainingCorpus();
    const ddl = [...current.ddl];
    const document = [...current.document];
    const sql = [...current.sql];

    const added = { ddl: 0, document: 0, sql: 0 };
    const skipped = { ddl: 0, document: 0, sql: 0 };

    const seenDdl = new Set(ddl.map(textFingerprint));
    for (const item of submittedDdl) {
      const fp = textFingerprint(item);
      if (seenDdl.has(fp)) skipped.ddl++;
      else {
        ddl.push(item);
        seenDdl.add(fp);
        added.ddl++;
      }
    }

    const seenDoc = new Set(document.map(textFingerprint));
    for (const item of submittedDoc) {
      const fp = textFingerprint(item);
      if (seenDoc.has(fp)) skipped.document++;
      else {
        document.push(item);
        seenDoc.add(fp);
        added.document++;
      }
    }

    const seenSql = new Set(sql.map(sqlFingerprint));
    for (const item of submittedSql) {
      const fp = sqlFingerprint(item);
      if (seenSql.has(fp)) skipped.sql++;
      else {
        sql.push(item);
        seenSql.add(fp);
        added.sql++;
      }
    }

    if (added.ddl || added.document || added.sql) {
      await atomicWriteCorpus(file, { ddl, document, sql });
    }
    const fileStat = await stat(/* turbopackIgnore: true */ file).catch(() => null);

    return {
      ddl,
      document,
      sql,
      counts: {
        ddl: ddl.length,
        document: document.length,
        sql: sql.length,
        total: ddl.length + document.length + sql.length,
      },
      added,
      skipped_duplicates: skipped,
      trained: false,
      trained_counts: { ddl: 0, document: 0, sql: 0 },
      file_name: path.basename(file),
      updated_at: fileStat ? formatMtime(fileStat.mtime) : current.updated_at,
      source: "local_json",
    };
  });
}

async function deleteLocalTrainingItem(category: TrainingCategory, index: number): Promise<TrainingCorpusData> {
  return serializeWrite(async () => {
    const file = trainingJsonPath();
    const current = await readLocalTrainingCorpus();
    const ddl = [...current.ddl];
    const document = [...current.document];
    const sql = [...current.sql];
    const target = category === "ddl" ? ddl : category === "document" ? document : sql;
    if (!Number.isInteger(index) || index < 0 || index >= target.length) {
      throw new ApiError(400, `${category} 下标 ${index} 超出范围`);
    }
    target.splice(index, 1);
    await atomicWriteCorpus(file, { ddl, document, sql });
    const fileStat = await stat(/* turbopackIgnore: true */ file);
    return {
      ddl,
      document,
      sql,
      counts: {
        ddl: ddl.length,
        document: document.length,
        sql: sql.length,
        total: ddl.length + document.length + sql.length,
      },
      file_name: path.basename(file),
      updated_at: formatMtime(fileStat.mtime),
      source: "local_json",
    };
  });
}

function isNetworkUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TypeError" ||
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)
  );
}

export async function probeText2SqlService(): Promise<Pick<Text2SqlStatus, "service" | "health">> {
  const cfg = getBackendConfig();
  const baseService = {
    reachable: false,
    base_url: cfg.fastapiUrl,
    endpoint: `${cfg.fastapiUrl}/api/v1/text2sql`,
  };

  try {
    const response = await fetch(`${cfg.fastapiUrl}/api/v1/text2sql/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });

    if (response.status === 404) {
      return {
        service: {
          ...baseService,
          reason: "FastAPI 已运行但尚未加载 /api/v1/text2sql 路由",
          hint: "请重启 backend/ 下的 python main.py（或执行 python text2sql_main.py）",
        },
        health: null,
      };
    }

    if (!response.ok) {
      return {
        service: {
          ...baseService,
          reason: `后端返回 HTTP ${response.status}`,
          hint: "请检查 FastAPI 控制台日志",
        },
        health: null,
      };
    }

    const body = (await response.json().catch(() => null)) as UpstreamEnvelope | null;
    const data = (body?.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
    return {
      service: {
        ...baseService,
        reachable: true,
      },
      health: {
        database_connected: Boolean(data.database_connected),
        model_loaded: Boolean(data.model_loaded),
        init_error: typeof data.init_error === "string" ? data.init_error : null,
        llm_model: typeof data.llm_model === "string" ? data.llm_model : undefined,
        ollama_host: typeof data.ollama_host === "string" ? data.ollama_host : undefined,
        mysql_db: typeof data.mysql_db === "string" ? data.mysql_db : undefined,
      },
    };
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      service: {
        ...baseService,
        reason: aborted ? `连接 ${cfg.fastapiUrl} 超时` : `无法连接 ${cfg.fastapiUrl}`,
        hint: "请在 backend/ 目录执行 python main.py（或无 Milvus 时执行 python text2sql_main.py）启动服务",
      },
      health: null,
    };
  }
}

export async function fetchTrainingCorpus(): Promise<TrainingCorpusData> {
  const cfg = getBackendConfig();
  try {
    const response = await fetch(`${cfg.fastapiUrl}/api/v1/text2sql/train/data`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as UpstreamEnvelope | null;
      if (body && body.status === 200 && body.data && typeof body.data === "object") {
        const d = body.data as TrainingCorpusData;
        return { ...d, source: "fastapi_backend" };
      }
    }
  } catch {
    // FastAPI not running — gracefully fall back to reading shared vanna_training_data.json
  }
  return readLocalTrainingCorpus();
}

export async function getText2SqlStatus(): Promise<Text2SqlStatus> {
  const [probe, corpus] = await Promise.all([probeText2SqlService(), fetchTrainingCorpus()]);
  return {
    service: probe.service,
    health: probe.health,
    corpus,
  };
}

export async function forwardAddTraining(
  payload: AddTrainingPayload,
): Promise<{ message: string; data: AddTrainingResult }> {
  const submittedDdl = normalizeTextArray(payload.ddl);
  const submittedDoc = normalizeTextArray(payload.document);
  const submittedSql = normalizeSqlArray(payload.sql, payload.question);
  if (!submittedDdl.length && !submittedDoc.length && !submittedSql.length) {
    throw new ApiError(400, "请至少填写或导入 ddl、document、sql 中的一项训练内容");
  }

  const autoTrain = payload.auto_train !== false;
  const cfg = getBackendConfig();
  const url = `${cfg.fastapiUrl}/api/v1/text2sql/train/add`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ddl: submittedDdl.length ? submittedDdl : undefined,
        document: submittedDoc.length ? submittedDoc : undefined,
        sql: submittedSql.length ? submittedSql : undefined,
        auto_train: autoTrain,
      }),
      signal: AbortSignal.timeout(TRAIN_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    if (!autoTrain && isNetworkUnavailable(error)) {
      const localSaved = await appendLocalTrainingCorpus({ ...payload, auto_train: false });
      return {
        message: "训练语料已写入 vanna_training_data.json（当前 FastAPI 未启动，待启动后端后可一键同步训练）",
        data: localSaved,
      };
    }
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (aborted) {
      throw new ApiError(504, "增加训练请求超时。后端正在向量化并写入 ChromaDB，请查看 FastAPI 日志。");
    }
    throw new ApiError(
      503,
      `无法连接 FastAPI 训练服务 ${cfg.fastapiUrl}。请先启动后端以执行 Vanna 增量训练，或点击「仅写入 JSON 文件」先保存训练语料。`,
    );
  }

  const raw = await response.text();
  let body: UpstreamEnvelope | null = null;
  try {
    body = raw ? (JSON.parse(raw) as UpstreamEnvelope) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    if (response.status === 404 && !autoTrain) {
      const localSaved = await appendLocalTrainingCorpus({ ...payload, auto_train: false });
      return {
        message: "训练语料已写入本地 vanna_training_data.json（请重启 FastAPI 以加载最新路由）",
        data: localSaved,
      };
    }
    const detail = typeof body?.detail === "string" ? body.detail : body?.message;
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      detail || `训练服务返回 HTTP ${response.status}，请检查 FastAPI 与 Ollama 状态`,
    );
  }

  if (!body) {
    throw new ApiError(502, "训练服务返回的响应不是合法 JSON，请查看 FastAPI 日志");
  }
  if (typeof body.status === "number" && body.status >= 400) {
    throw new ApiError(body.status, body.message || "增加训练失败");
  }
  if (!body.data || typeof body.data !== "object") {
    throw new ApiError(502, "训练服务未返回训练结果数据");
  }

  return {
    message: body.message || "新增训练完成",
    data: { ...(body.data as AddTrainingResult), source: "fastapi_backend" },
  };
}

export async function forwardDeleteTrainingItem(
  category: TrainingCategory,
  index: number,
): Promise<{ message: string; data: TrainingCorpusData }> {
  const cfg = getBackendConfig();
  const params = new URLSearchParams({ category, index: String(index) });
  try {
    const response = await fetch(`${cfg.fastapiUrl}/api/v1/text2sql/train/data?${params}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as UpstreamEnvelope | null;
      if (body && typeof body.status === "number" && body.status >= 400) {
        throw new ApiError(body.status, body.message || "删除训练语料失败");
      }
      if (body?.data && typeof body.data === "object") {
        return {
          message: body.message || "已删除该条训练语料",
          data: { ...(body.data as TrainingCorpusData), source: "fastapi_backend" },
        };
      }
    }
    if (response.status !== 404) {
      const body = (await response.json().catch(() => null)) as UpstreamEnvelope | null;
      throw new ApiError(response.status, body?.message || `删除失败（HTTP ${response.status}）`);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (!isNetworkUnavailable(error)) throw error;
  }

  const updated = await deleteLocalTrainingItem(category, index);
  return {
    message: "已从本地 vanna_training_data.json 移除该条目",
    data: updated,
  };
}

export async function forwardFullTrain(): Promise<{ message: string; data: FullTrainResult }> {
  const cfg = getBackendConfig();
  let response: Response;
  try {
    response = await fetch(`${cfg.fastapiUrl}/api/v1/text2sql/train`, {
      method: "POST",
      signal: AbortSignal.timeout(TRAIN_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (aborted) {
      throw new ApiError(504, "全量模型训练超时，后端可能仍在处理，请查看 FastAPI 日志。");
    }
    throw new ApiError(
      503,
      `无法连接 FastAPI 训练服务 ${cfg.fastapiUrl}。请在 backend/ 目录执行 python main.py（或 python text2sql_main.py）启动服务。`,
    );
  }

  const raw = await response.text();
  let body: UpstreamEnvelope | null = null;
  try {
    body = raw ? (JSON.parse(raw) as UpstreamEnvelope) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : body?.message;
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      detail || `全量训练失败（HTTP ${response.status}），请确认 Ollama 与 ChromaDB 可用`,
    );
  }
  if (!body) {
    throw new ApiError(502, "训练服务返回内容无法解析为 JSON");
  }
  if (typeof body.status === "number" && body.status >= 400) {
    throw new ApiError(body.status, body.message || "全量训练失败");
  }
  return {
    message: body.message || "模型全量训练完成",
    data: ((body.data as FullTrainResult) || {}),
  };
}

export async function forwardText2SqlQuery(
  payload: Text2SqlQueryPayload,
): Promise<{ message: string; data: Text2SqlQueryResult }> {
  const question = normalizeText(payload.question);
  if (!question) {
    throw new ApiError(400, "请输入要查询的自然语言问题");
  }

  const cfg = getBackendConfig();
  let response: Response;
  try {
    response = await fetch(`${cfg.fastapiUrl}/api/v1/text2sql/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        user_id: payload.user_id?.trim() || undefined,
        limit: typeof payload.limit === "number" ? payload.limit : 10,
        auto_execute: payload.auto_execute !== false,
      }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (aborted) {
      throw new ApiError(504, "Text2SQL 查询超时。后端可能正在等待大模型生成 SQL，请查看 FastAPI 日志。");
    }
    throw new ApiError(
      503,
      `无法连接 Text2SQL 查询服务 ${cfg.fastapiUrl}。请在 backend/ 目录启动 FastAPI 服务。`,
    );
  }

  const raw = await response.text();
  let parsed: (Partial<Text2SqlQueryResult> & UpstreamEnvelope) | null = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = typeof parsed?.detail === "string" ? parsed.detail : parsed?.message;
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      detail || `Text2SQL 查询服务返回 HTTP ${response.status}`,
    );
  }
  if (!parsed || typeof parsed.success !== "boolean") {
    throw new ApiError(502, "Text2SQL 服务返回的数据格式不正确，请检查后端日志");
  }
  if (!parsed.success) {
    throw new ApiError(502, parsed.error || "SQL 生成或数据库执行失败，请检查模型训练状态与数据库连接");
  }

  const result: Text2SqlQueryResult = {
    success: true,
    question: parsed.question || question,
    generated_sql: parsed.generated_sql ?? null,
    result: Array.isArray(parsed.result) ? parsed.result : null,
    error: null,
    execution_time: typeof parsed.execution_time === "number" ? parsed.execution_time : 0,
  };
  return {
    message: "查询成功",
    data: result,
  };
}

export async function forwardText2SqlAsk(params: {
  question: string;
  limit?: number;
  user_id?: string;
}): Promise<{ message: string; data: Text2SqlQueryResult }> {
  const question = normalizeText(params.question);
  if (!question) {
    throw new ApiError(400, "缺少查询参数 question");
  }
  const cfg = getBackendConfig();
  const query = new URLSearchParams({ question });
  if (typeof params.limit === "number") query.set("limit", String(params.limit));
  if (params.user_id?.trim()) query.set("user_id", params.user_id.trim());

  let response: Response;
  try {
    response = await fetch(`${cfg.fastapiUrl}/api/v1/text2sql/ask?${query}`, {
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(503, `无法连接 Text2SQL 查询服务 ${cfg.fastapiUrl}`);
  }

  const parsed = (await response.json().catch(() => null)) as Partial<Text2SqlQueryResult> | null;
  if (!response.ok || !parsed || !parsed.success) {
    throw new ApiError(502, parsed?.error || `查询失败（HTTP ${response.status}）`);
  }
  return {
    message: "查询成功",
    data: {
      success: true,
      question: parsed.question || question,
      generated_sql: parsed.generated_sql ?? null,
      result: Array.isArray(parsed.result) ? parsed.result : null,
      error: null,
      execution_time: typeof parsed.execution_time === "number" ? parsed.execution_time : 0,
    },
  };
}

export async function forwardTableInfo(
  tableName = "user_health_risk_assessment",
): Promise<{ message: string; data: TableColumnInfo[] }> {
  const cfg = getBackendConfig();
  const params = new URLSearchParams({ table_name: tableName.trim() || "user_health_risk_assessment" });
  let response: Response;
  try {
    response = await fetch(`${cfg.fastapiUrl}/api/v1/text2sql/tables?${params}`, {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      503,
      `无法连接 FastAPI 服务 ${cfg.fastapiUrl}，暂无法实时查询 MySQL 表结构（下方仍可查看 JSON 训练语料中的建表 DDL）。`,
    );
  }

  const body = (await response.json().catch(() => null)) as UpstreamEnvelope | null;
  if (!response.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : body?.message;
    throw new ApiError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      detail || `读取表结构失败（HTTP ${response.status}）`,
    );
  }
  if (typeof body?.status === "number" && body.status >= 400) {
    throw new ApiError(body.status, body.message || "读取表结构失败");
  }
  const cols = Array.isArray(body?.data) ? (body.data as TableColumnInfo[]) : [];
  return {
    message: body?.message || "success",
    data: cols,
  };
}
