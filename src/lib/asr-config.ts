import { readFile } from "node:fs/promises";
import path from "node:path";
import { getBackendConfig } from "./backend-config";

/**
 * 核心配置解析模块：
 * 按照用户要求：必须由前端直接调用后端的配置！
 * 1. 优先调用已连接的 FastAPI 后端接口 GET /api/v1/config/systemConfig 获取后端真实环境变量
 * 2. 如果后端未启动或尚未添加配置路由，回退读取后端的 backend/.env 文件
 * 3. 再次回退使用当前进程环境变量
 */

export type AsrEndpoint = {
  endpoint: string;
  model: string;
  apiKey: string;
  source: "fastapi_backend" | "backend/.env" | "env" | "none";
  configured: boolean;
};

export type BackendSystemConfig = {
  asr: {
    configured: boolean;
    model: string;
    base_url: string;
    endpoint: string;
    has_api_key: boolean;
    source: "fastapi_backend" | "backend/.env" | "env" | "none";
  };
  milvus: {
    host: string;
    port: string;
    default_collection: string;
  };
  ollama: {
    base_url: string;
    llm_model: string;
    embedding_model: string;
  };
  strategy: {
    llm_strategy: string;
    embedding_strategy: string;
  };
};

type EnvMap = Record<string, string>;

function stripQuotes(value: string | undefined): string {
  if (!value) return "";
  return value.trim().replace(/^["']|["']$/g, "");
}

function parseEnvFile(raw: string, known: EnvMap): EnvMap {
  const out: EnvMap = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripQuotes(trimmed.slice(eq + 1));
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = out[name] ?? known[name];
      return resolved !== undefined ? resolved : match;
    });
    out[key] = value;
  }
  return out;
}

const BACKEND_ENV = path.join(/* turbopackIgnore: true */ process.cwd(), "backend", ".env");

let fileCache: { at: number; values: EnvMap } | null = null;
const TTL = 10_000;

async function readBackendEnv(): Promise<EnvMap> {
  if (fileCache && Date.now() - fileCache.at < TTL) return fileCache.values;
  try {
    const raw = await readFile(/* turbopackIgnore: true */ BACKEND_ENV, "utf8");
    const values = parseEnvFile(raw, process.env as EnvMap);
    fileCache = { at: Date.now(), values };
    return values;
  } catch {
    fileCache = { at: Date.now(), values: {} };
    return {};
  }
}

export function normalizeAsrEndpoint(base: string): string {
  const trimmed = (base || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/audio\/(transcriptions|transcribe)$/i.test(trimmed)) return trimmed;
  return `${trimmed}/audio/transcriptions`;
}

/**
 * 重点：直接向运行中的 FastAPI 后端请求其系统配置
 */
export async function fetchFastApiConfig(): Promise<BackendSystemConfig | null> {
  const cfg = getBackendConfig();
  const url = `${cfg.fastapiUrl}/api/v1/config/systemConfig`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as {
      status?: number;
      data?: Record<string, unknown>;
    } | null;

    if (json?.status === 200 && json?.data) {
      const d = json.data as Record<string, Record<string, unknown>>;
      const asr = d.asr || {};
      const milvus = d.milvus || {};
      const ollama = d.ollama || {};
      const strategy = d.strategy || {};

      return {
        asr: {
          configured: Boolean(asr.configured),
          model: String(asr.model || ""),
          base_url: String(asr.base_url || ""),
          endpoint: normalizeAsrEndpoint(String(asr.endpoint || asr.base_url || "")),
          has_api_key: Boolean(asr.has_api_key),
          source: "fastapi_backend",
        },
        milvus: {
          host: String(milvus.host || "127.0.0.1"),
          port: String(milvus.port || "19530"),
          default_collection: String(milvus.default_collection || "rag_knowledge"),
        },
        ollama: {
          base_url: String(ollama.base_url || "http://127.0.0.1:11434"),
          llm_model: String(ollama.llm_model || "qwen3:8b"),
          embedding_model: String(ollama.embedding_model || "bge-m3:latest"),
        },
        strategy: {
          llm_strategy: String(strategy.llm_strategy || "ollama"),
          embedding_strategy: String(strategy.embedding_strategy || "ollama"),
        },
      };
    }
  } catch {
    // 后端未运行或网络不可达
  }
  return null;
}

/**
 * 解析 ASR 端点：
 * 1. 优先调用后端 FastAPI 接口获取后端的配置
 * 2. 如果后端未启动，回退使用后端的 backend/.env 文件
 * 3. 再次回退使用前端环境变量
 */
export async function resolveAsr(): Promise<AsrEndpoint> {
  // 1. 尝试直接调用后端接口
  const backendConfig = await fetchFastApiConfig();
  if (backendConfig?.asr?.configured) {
    return {
      endpoint: backendConfig.asr.endpoint,
      model: backendConfig.asr.model,
      apiKey: stripQuotes(process.env.ASR_API_KEY || (await readBackendEnv()).ASR_API_KEY),
      source: "fastapi_backend",
      configured: true,
    };
  }

  // 2. 回退使用后端的 backend/.env 文件
  const backendEnv = await readBackendEnv();
  const backendBase = stripQuotes(backendEnv.ASR_BASE_URL);
  const backendModel = stripQuotes(backendEnv.ASR_MODEL);
  const backendKey = stripQuotes(backendEnv.ASR_API_KEY);

  if (backendBase && backendModel) {
    return {
      endpoint: normalizeAsrEndpoint(backendBase),
      model: backendModel,
      apiKey: backendKey,
      source: "backend/.env",
      configured: true,
    };
  }

  // 3. 回退使用当前进程环境变量
  const envBase = stripQuotes(process.env.ASR_BASE_URL);
  const envModel = stripQuotes(process.env.ASR_MODEL);
  const envKey = stripQuotes(process.env.ASR_API_KEY);

  if (envBase && envModel) {
    return {
      endpoint: normalizeAsrEndpoint(envBase),
      model: envModel,
      apiKey: envKey,
      source: "env",
      configured: true,
    };
  }

  return {
    endpoint: "",
    model: "",
    apiKey: "",
    source: "none",
    configured: false,
  };
}

/**
 * 供浏览器安全展示的状态信息（不泄露密钥明文）
 */
export async function asrStatus() {
  const resolved = await resolveAsr();
  return {
    configured: resolved.configured,
    model: resolved.model || "（未配置 ASR_MODEL）",
    endpoint: resolved.endpoint || "（未配置 ASR_BASE_URL）",
    has_api_key: Boolean(resolved.apiKey),
    source: resolved.source,
  };
}

/**
 * 获取后端的默认 Milvus 集合名
 */
export async function getBackendDefaultCollection(): Promise<string> {
  const backendConfig = await fetchFastApiConfig();
  if (backendConfig?.milvus?.default_collection) {
    return backendConfig.milvus.default_collection;
  }
  const backendEnv = await readBackendEnv();
  if (backendEnv.MILVUS_DEFAULT_COLLECTION) {
    return stripQuotes(backendEnv.MILVUS_DEFAULT_COLLECTION);
  }
  return stripQuotes(process.env.MILVUS_DEFAULT_COLLECTION) || "rag_knowledge";
}

export function clearAsrCache() {
  fileCache = null;
}
