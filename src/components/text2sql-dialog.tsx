"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addTrainingData,
  deleteTrainingItem,
  fetchTableColumns,
  fetchText2SqlStatus,
  queryText2Sql,
  triggerFullTrain,
} from "@/lib/client-api";
import type {
  AddTrainingPayload,
  AddTrainingResult,
  SqlTrainingItem,
  TableColumnInfo,
  Text2SqlQueryResult,
  Text2SqlStatus,
  TrainingCategory,
  TrainingCorpusData,
} from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  onToast: (kind: "ok" | "err", text: string) => void;
};

type Tab = "query" | "add" | "corpus" | "tables";
type AddMode = "form" | "json";
type SqlRowDraft = { id: string; question: string; sql: string };

const PRESET_QUESTIONS = [
  "查询风险等级为高风险的患者姓名、年龄、总分，按总分降序取前10条",
  "统计各个风险等级的人数，并按人数从高到低排序",
  "查询用户 USER001 的历次测评时间与总分记录",
  "统计男性患者的平均总分和平均年龄",
  "按日期统计最近 7 天每天的测评记录数量",
];

const SAMPLE_DDL_TEMPLATE = `CREATE TABLE IF NOT EXISTS user_nutrition_intervention (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '干预记录ID',
    user_id VARCHAR(64) NOT NULL COMMENT '关联用户唯一标识',
    assessment_id BIGINT NOT NULL COMMENT '关联测评记录ID',
    intervention_type ENUM('饮食指导', '口服营养补充', '肠内营养', '肠外营养') NOT NULL COMMENT '干预方式',
    daily_target_kcal INT COMMENT '每日目标热量(kcal)',
    follow_up_date DATE COMMENT '复评日期',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户营养干预方案表';`;

const SAMPLE_DOC_TEMPLATE = `营养风险复评与高龄筛查业务补充说明：
1. age >= 70 的老年患者默认获得年龄评分 age_score = 1 分。
2. bmi < 18.5 属于低体重人群，常伴随营养受损评分升高。
3. 当 total_score >= 3 分时判定为存在营养风险（中风险或高风险），需结合营养干预表跟踪复评。`;

const SAMPLE_SQL_TEMPLATE =
  "SELECT user_name, age, bmi, total_score, risk_level FROM user_health_risk_assessment WHERE age >= 70 AND total_score >= 3 ORDER BY total_score DESC LIMIT 20";

const SAMPLE_JSON_TEMPLATE = JSON.stringify(
  {
    ddl: [SAMPLE_DDL_TEMPLATE],
    document: [SAMPLE_DOC_TEMPLATE],
    sql: [
      {
        question: "查询70岁及以上且总分大于等于3分的高龄营养风险患者",
        sql: SAMPLE_SQL_TEMPLATE,
      },
    ],
  },
  null,
  2,
);

function makeRowId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sqlItemText(item: SqlTrainingItem): { question?: string; sql: string } {
  if (typeof item === "string") return { sql: item };
  return { question: item.question, sql: item.sql };
}

function parseJsonDraft(raw: string): {
  valid: boolean;
  error?: string;
  payload?: AddTrainingPayload;
  summary?: { ddl: number; document: number; sql: number };
} {
  if (!raw.trim()) {
    return { valid: false, error: "请输入或导入 JSON 训练内容" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, error: "JSON 顶层必须是对象，如 { \"ddl\": [...], \"document\": [...], \"sql\": [...] }" };
    }
    const obj = parsed as Record<string, unknown>;
    const ddlRaw = obj.ddl;
    const docRaw = "document" in obj ? obj.document : obj.documentation;
    const sqlRaw = obj.sql;

    const countOf = (v: unknown) => {
      if (typeof v === "string") return v.trim() ? 1 : 0;
      if (Array.isArray(v)) return v.filter((x) => (typeof x === "string" ? x.trim() : x && typeof x === "object")).length;
      if (v && typeof v === "object") return 1;
      return 0;
    };

    const summary = {
      ddl: countOf(ddlRaw),
      document: countOf(docRaw),
      sql: countOf(sqlRaw),
    };
    if (!summary.ddl && !summary.document && !summary.sql) {
      return { valid: false, error: "JSON 中未检测到非空的 ddl、document 或 sql 字段" };
    }
    return {
      valid: true,
      payload: {
        ddl: ddlRaw as string | string[] | undefined,
        document: docRaw as string | string[] | undefined,
        sql: sqlRaw as SqlTrainingItem | SqlTrainingItem[] | undefined,
      },
      summary,
    };
  } catch (err) {
    return {
      valid: false,
      error: `JSON 语法有误：${err instanceof Error ? err.message : "无法解析"}`,
    };
  }
}

function downloadBlob(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );
  const escapeCsv = (val: unknown) => {
    const str = val == null ? "" : String(val);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [
    headers.map(escapeCsv).join(","),
    ...rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(",")),
  ].join("\n");
}

export function Text2SqlDialog({ open, onClose, onToast }: Props) {
  const [tab, setTab] = useState<Tab>("query");
  const [status, setStatus] = useState<Text2SqlStatus | null>(null);
  const [corpus, setCorpus] = useState<TrainingCorpusData | null>(null);
  const [checking, setChecking] = useState(false);

  // Tab 1: Natural Language Query
  const [question, setQuestion] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("");
  const [limit, setLimit] = useState("10");
  const [autoExecute, setAutoExecute] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [queryElapsed, setQueryElapsed] = useState(0);
  const [queryResult, setQueryResult] = useState<Text2SqlQueryResult | null>(null);
  const [queryError, setQueryError] = useState("");

  // Tab 2: Incremental Add Training (JSON + Vanna)
  const [addMode, setAddMode] = useState<AddMode>("form");
  const [ddlInput, setDdlInput] = useState("");
  const [docInput, setDocInput] = useState("");
  const [sqlRows, setSqlRows] = useState<SqlRowDraft[]>([
    { id: "initial-row", question: "", sql: "" },
  ]);
  const [jsonInput, setJsonInput] = useState("");
  const [addingTrain, setAddingTrain] = useState(false);
  const [addError, setAddError] = useState("");
  const [lastAddResult, setLastAddResult] = useState<AddTrainingResult | null>(null);
  const jsonFileRef = useRef<HTMLInputElement>(null);

  // Full Train state
  const [fullTraining, setFullTraining] = useState(false);

  // Tab 3: Corpus Viewer
  const [corpusCategory, setCorpusCategory] = useState<"all" | TrainingCategory>("all");
  const [corpusSearch, setCorpusSearch] = useState("");
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);

  // Tab 4: Table Schema
  const [tableName, setTableName] = useState("user_health_risk_assessment");
  const [columns, setColumns] = useState<TableColumnInfo[] | null>(null);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [columnsError, setColumnsError] = useState("");

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    setChecking(true);
    try {
      const next = await fetchText2SqlStatus(signal);
      if (!signal?.aborted) {
        setStatus(next);
        setCorpus(next.corpus);
      }
    } catch {
      if (!signal?.aborted) setStatus(null);
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchText2SqlStatus(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setStatus(next);
          setCorpus(next.corpus);
          setQueryError("");
          setAddError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus(null);
      });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!querying) return;
    const started = Date.now();
    const timer = setInterval(() => setQueryElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [querying]);

  const loadTableSchema = useCallback(async (targetTable: string, signal?: AbortSignal) => {
    setLoadingColumns(true);
    setColumnsError("");
    try {
      const cols = await fetchTableColumns(targetTable, signal);
      if (!signal?.aborted) setColumns(cols);
    } catch (caught) {
      if (!signal?.aborted) {
        setColumns(null);
        setColumnsError(caught instanceof Error ? caught.message : "获取表结构失败");
      }
    } finally {
      if (!signal?.aborted) setLoadingColumns(false);
    }
  }, []);

  const jsonValidation = useMemo(() => parseJsonDraft(jsonInput), [jsonInput]);

  const formHasContent = useMemo(() => {
    if (ddlInput.trim() || docInput.trim()) return true;
    return sqlRows.some((row) => row.sql.trim().length > 0);
  }, [ddlInput, docInput, sqlRows]);

  const filteredCorpusItems = useMemo(() => {
    if (!corpus) return [];
    const keyword = corpusSearch.trim().toLowerCase();
    const list: { category: TrainingCategory; index: number; question?: string; text: string }[] = [];

    if (corpusCategory === "all" || corpusCategory === "ddl") {
      corpus.ddl.forEach((item, index) => {
        if (!keyword || item.toLowerCase().includes(keyword)) {
          list.push({ category: "ddl", index, text: item });
        }
      });
    }
    if (corpusCategory === "all" || corpusCategory === "document") {
      corpus.document.forEach((item, index) => {
        if (!keyword || item.toLowerCase().includes(keyword)) {
          list.push({ category: "document", index, text: item });
        }
      });
    }
    if (corpusCategory === "all" || corpusCategory === "sql") {
      corpus.sql.forEach((item, index) => {
        const parsed = sqlItemText(item);
        const combined = `${parsed.question || ""}\n${parsed.sql}`.toLowerCase();
        if (!keyword || combined.includes(keyword)) {
          list.push({
            category: "sql",
            index,
            question: parsed.question,
            text: parsed.sql,
          });
        }
      });
    }
    return list;
  }, [corpus, corpusCategory, corpusSearch]);

  const resultColumns = useMemo(() => {
    const rows = queryResult?.result;
    if (!rows?.length) return [];
    return Array.from(
      rows.reduce((set, row) => {
        Object.keys(row).forEach((key) => set.add(key));
        return set;
      }, new Set<string>()),
    );
  }, [queryResult]);

  const busy = querying || addingTrain || fullTraining;

  async function handleQuerySubmit() {
    if (!question.trim()) {
      setQueryError("请输入自然语言问题，或点击上方示例问题");
      return;
    }
    const parsedLimit = Math.max(1, Math.min(500, Number(limit) || 10));
    setQuerying(true);
    setQueryError("");
    setQueryResult(null);
    setQueryElapsed(0);
    try {
      const data = await queryText2Sql({
        question: question.trim(),
        user_id: userIdFilter.trim() || undefined,
        limit: parsedLimit,
        auto_execute: autoExecute,
      });
      setQueryResult(data);
      const rowCount = Array.isArray(data.result) ? data.result.length : null;
      onToast(
        "ok",
        rowCount != null ? `查询完成：返回 ${rowCount} 条记录` : "SQL 生成完成",
      );
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "查询失败";
      setQueryError(msg);
      onToast("err", msg);
    } finally {
      setQuerying(false);
    }
  }

  async function handleFullTrain() {
    setFullTraining(true);
    try {
      const res = await triggerFullTrain();
      onToast("ok", res.message || "已完成 JSON 训练语料全量训练");
      await refreshStatus();
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "全量训练失败";
      onToast("err", msg);
    } finally {
      setFullTraining(false);
    }
  }

  function buildAddPayload(autoTrain: boolean): AddTrainingPayload | null {
    if (addMode === "json") {
      if (!jsonValidation.valid || !jsonValidation.payload) {
        setAddError(jsonValidation.error || "请检查 JSON 格式");
        return null;
      }
      return { ...jsonValidation.payload, auto_train: autoTrain };
    }

    const ddl = ddlInput.trim() ? [ddlInput.trim()] : undefined;
    const document = docInput.trim() ? [docInput.trim()] : undefined;
    const sql: SqlTrainingItem[] = [];
    for (const row of sqlRows) {
      const s = row.sql.trim();
      const q = row.question.trim();
      if (!s) continue;
      sql.push(q ? { question: q, sql: s } : s);
    }

    if (!ddl && !document && !sql.length) {
      setAddError("请至少填写 DDL、Document 或 SQL 中的一项训练内容");
      return null;
    }
    return {
      ddl,
      document,
      sql: sql.length ? sql : undefined,
      auto_train: autoTrain,
    };
  }

  async function handleAddTraining(autoTrain: boolean) {
    setAddError("");
    const payload = buildAddPayload(autoTrain);
    if (!payload) return;

    setAddingTrain(true);
    try {
      const { message, data } = await addTrainingData(payload);
      setLastAddResult(data);
      setCorpus(data);
      setStatus((prev) => (prev ? { ...prev, corpus: data } : prev));
      onToast("ok", message);

      // Clear submitted inputs so user doesn't accidentally submit twice
      if (addMode === "form") {
        setDdlInput("");
        setDocInput("");
        setSqlRows([{ id: makeRowId(), question: "", sql: "" }]);
      } else {
        setJsonInput("");
      }
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "增加训练失败";
      setAddError(msg);
      onToast("err", msg);
      // Refresh corpus in case JSON was saved before Vanna raised an error
      refreshStatus();
    } finally {
      setAddingTrain(false);
    }
  }

  function handleJsonFileUpload(file: File | undefined) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setAddError("JSON 训练文件大小请勿超过 5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setJsonInput(text);
      setAddError("");
      onToast("ok", `已载入 ${file.name}，请核对后点击保存训练`);
    };
    reader.onerror = () => setAddError("读取本地 JSON 文件失败");
    reader.readAsText(file, "utf-8");
  }

  async function handleRemoveCorpusItem(category: TrainingCategory, index: number) {
    const key = `${category}-${index}`;
    setDeletingKey(key);
    try {
      const { message, data } = await deleteTrainingItem(category, index);
      setCorpus(data);
      setStatus((prev) => (prev ? { ...prev, corpus: data } : prev));
      onToast("ok", message);
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "删除失败";
      onToast("err", msg);
    } finally {
      setDeletingKey(null);
    }
  }

  function promoteGeneratedSqlToTraining() {
    if (!queryResult?.generated_sql) return;
    setAddMode("form");
    setSqlRows([
      {
        id: makeRowId(),
        question: queryResult.question || question.trim(),
        sql: queryResult.generated_sql,
      },
    ]);
    setLastAddResult(null);
    setAddError("");
    setTab("add");
    onToast("ok", "已带入「增加训练」表单，确认后即可写入 JSON 并训练");
  }

  function copyText(text: string, label = "内容") {
    if (!navigator.clipboard) {
      onToast("err", "当前浏览器环境不支持剪贴板复制");
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => onToast("ok", `${label}已复制到剪贴板`),
      () => onToast("err", "复制失败，请手动选中复制"),
    );
  }

  function exportCorpusJson() {
    if (!corpus) return;
    const cleanJson = JSON.stringify(
      {
        ddl: corpus.ddl,
        document: corpus.document,
        sql: corpus.sql,
      },
      null,
      2,
    );
    downloadBlob(corpus.file_name || "vanna_training_data.json", cleanJson, "application/json;charset=utf-8");
    onToast("ok", "已导出训练语料 JSON 文件");
  }

  function close() {
    if (busy && !window.confirm("请求仍在后端执行中，关闭窗口不会中断后端任务。确定关闭吗？")) {
      return;
    }
    onClose();
  }

  if (!open) return null;

  const serviceOnline = Boolean(status?.service.reachable);
  const dbOnline = Boolean(status?.health?.database_connected);
  const modelReady = Boolean(status?.health?.model_loaded);
  const counts = corpus?.counts || { ddl: 0, document: 0, sql: 0, total: 0 };

  return (
    <section className="t2s-dialog workspace-tool" aria-labelledby="t2s-dialog-title">
      <header className="t2s-header">
        <div>
          <p className="kicker">Vanna · Text2SQL &amp; JSON Training</p>
          <h2 id="t2s-dialog-title">健康测评智能问数与增量训练</h2>
        </div>
        <div className="t2s-header-right">
          <span className={`assistant-pill${serviceOnline ? " on" : " off"}`} role="status">
            <i />
            {checking ? "检测中…" : serviceOnline ? "Text2SQL 服务在线" : "后端服务未连接"}
          </span>
          {serviceOnline && (
            <span className={`assistant-pill${dbOnline ? " on" : " off"}`} role="status">
              <i />
              {dbOnline ? "MySQL 已连接" : "MySQL 未连接"}
            </span>
          )}
          <button className="icon-btn" type="button" aria-label="返回知识文件" onClick={close}>
            ←
          </button>
        </div>
      </header>

      <div className="t2s-body">
        <aside className="t2s-side">
          <div className="t2s-corpus-summary" aria-label="JSON 训练语料统计">
            <div className="t2s-summary-head">
              <strong>训练语料 JSON</strong>
              <span>{corpus?.file_name || "vanna_training_data.json"}</span>
            </div>
            <div className="t2s-count-grid">
              <button
                type="button"
                onClick={() => {
                  setCorpusCategory("ddl");
                  setTab("corpus");
                }}
              >
                <span>DDL</span>
                <strong>{counts.ddl}</strong>
              </button>
              <button
                type="button"
                onClick={() => {
                  setCorpusCategory("document");
                  setTab("corpus");
                }}
              >
                <span>Document</span>
                <strong>{counts.document}</strong>
              </button>
              <button
                type="button"
                onClick={() => {
                  setCorpusCategory("sql");
                  setTab("corpus");
                }}
              >
                <span>SQL</span>
                <strong>{counts.sql}</strong>
              </button>
            </div>
            <p className="muted t2s-source-meta">
              共 {counts.total} 条语料 · 来源：
              {corpus?.source === "fastapi_backend" ? "FastAPI 后端接口" : "本地 JSON 文件"}
              {corpus?.updated_at ? ` · 更新于 ${corpus.updated_at}` : ""}
            </p>
            <button
              className="btn btn-line t2s-full-train-btn"
              type="button"
              disabled={busy || checking || !serviceOnline}
              onClick={handleFullTrain}
              title={serviceOnline ? "读取 JSON 文件全部内容重新训练 Vanna" : "请先启动 FastAPI 后端服务"}
            >
              {fullTraining ? "正在全量训练…" : "↻ 全量训练 JSON 语料"}
            </button>
          </div>

          {!serviceOnline && status?.service && (
            <div className="assistant-warn" role="status">
              <strong>{status.service.reason || "FastAPI 未连接"}</strong>
              {status.service.hint ? <div>{status.service.hint}</div> : null}
              <div style={{ marginTop: 4 }}>
                当前仍可浏览、导出或向 <code>vanna_training_data.json</code> 写入训练语料。
              </div>
            </div>
          )}

          {serviceOnline && !modelReady && (
            <div className="assistant-warn" role="status">
              Vanna / ChromaDB 模型尚未就绪
              {status?.health?.init_error ? `：${status.health.init_error}` : "，请确认已安装 vanna、chromadb 且 Ollama 在线"}
            </div>
          )}

          {serviceOnline && status?.health && (
            <dl className="t2s-env-facts">
              <div>
                <dt>生成模型</dt>
                <dd>{status.health.llm_model || "—"}</dd>
              </div>
              <div>
                <dt>目标数据库</dt>
                <dd>{status.health.mysql_db || "test_db"}</dd>
              </div>
            </dl>
          )}

          <button
            className="btn btn-line operator-mini"
            type="button"
            disabled={checking || busy}
            onClick={() => refreshStatus()}
          >
            重新检测服务与语料
          </button>

          <div className="assistant-note">
            <strong>JSON 语料 + 增量训练</strong>
            <p>
              <code>ddl</code>、<code>document</code>、<code>sql</code> 统一存放在{" "}
              <code>app/data/vanna_training_data.json</code>。新增接口{" "}
              <code>POST /api/v1/text2sql/train/add</code> 支持追加写入并即时增量训练 Vanna。
            </p>
          </div>
        </aside>

        <section className="t2s-main">
          <div className="assistant-tabs t2s-tabs" role="tablist" aria-label="Text2SQL 功能模块">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "query"}
              className={tab === "query" ? "active" : ""}
              onClick={() => setTab("query")}
            >
              ① 自然语言问数
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "add"}
              className={tab === "add" ? "active" : ""}
              onClick={() => setTab("add")}
            >
              ② 增加训练
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "corpus"}
              className={tab === "corpus" ? "active" : ""}
              onClick={() => setTab("corpus")}
            >
              ③ 训练语料 ({counts.total})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "tables"}
              className={tab === "tables" ? "active" : ""}
              onClick={() => {
                setTab("tables");
                if (columns === null && !loadingColumns) {
                  loadTableSchema(tableName);
                }
              }}
            >
              ④ 数据表结构
            </button>
          </div>

          {/* ==================== TAB 1: 自然语言问数 ==================== */}
          {tab === "query" && (
            <div className="t2s-pane">
              <div className="t2s-presets">
                <span>常用示例问题：</span>
                <div className="t2s-preset-list">
                  {PRESET_QUESTIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="t2s-chip"
                      disabled={querying}
                      onClick={() => setQuestion(item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <label className="field">
                <span>自然语言查询问题</span>
                <textarea
                  aria-label="自然语言查询问题"
                  rows={3}
                  maxLength={1000}
                  disabled={querying}
                  value={question}
                  placeholder="例如：查询高风险患者姓名、年龄、BMI 和总分，按总分降序排列前 10 名"
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>

              <div className="t2s-query-options">
                <label className="field">
                  <span>返回条数上限 (limit)</span>
                  <input
                    aria-label="返回条数上限"
                    type="number"
                    min={1}
                    max={500}
                    disabled={querying}
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>限定用户 ID（可选）</span>
                  <input
                    aria-label="限定用户 ID"
                    disabled={querying}
                    value={userIdFilter}
                    placeholder="如 USER001（留空查全部）"
                    onChange={(e) => setUserIdFilter(e.target.value)}
                  />
                </label>
                <label className="t2s-checkbox">
                  <input
                    type="checkbox"
                    checked={autoExecute}
                    disabled={querying}
                    onChange={(e) => setAutoExecute(e.target.checked)}
                  />
                  <div>
                    <strong>自动在 MySQL 执行 SQL</strong>
                    <span className="muted">取消勾选则仅调用大模型生成 SQL 语句预览</span>
                  </div>
                </label>
              </div>

              <div className="t2s-action-row">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={querying || !question.trim()}
                  onClick={handleQuerySubmit}
                >
                  {querying
                    ? `正在生成并查询（${queryElapsed}s）…`
                    : autoExecute
                      ? "生成 SQL 并执行查询"
                      : "仅生成 SQL"}
                </button>
                {question && (
                  <button
                    className="btn btn-quiet"
                    type="button"
                    disabled={querying}
                    onClick={() => {
                      setQuestion("");
                      setQueryResult(null);
                      setQueryError("");
                    }}
                  >
                    清空问题
                  </button>
                )}
              </div>

              {querying && (
                <div className="assistant-progress" role="status">
                  <span className="loading-ring" />
                  <div>
                    <strong>正在调用 Vanna 生成 SQL…已用时 {queryElapsed} 秒</strong>
                    <span className="muted">
                      检索 ChromaDB 中的 DDL / Document / SQL 语料并请求大模型生成查询语句
                    </span>
                  </div>
                </div>
              )}

              {queryError && !querying && (
                <div className="inline-error" role="alert">
                  <p>{queryError}</p>
                </div>
              )}

              {queryResult && !querying && (
                <div className="t2s-result-card">
                  <div className="t2s-result-head">
                    <div>
                      <strong>{autoExecute ? "SQL 生成与查询完成" : "SQL 生成完成"}</strong>
                      <span className="muted">
                        耗时 {queryResult.execution_time.toFixed(2)} 秒
                        {Array.isArray(queryResult.result)
                          ? ` · 返回 ${queryResult.result.length} 条记录`
                          : ""}
                      </span>
                    </div>
                    <div className="t2s-result-actions">
                      {queryResult.generated_sql && (
                        <>
                          <button
                            className="btn btn-line operator-mini"
                            type="button"
                            onClick={() => copyText(queryResult.generated_sql || "", "SQL 语句")}
                          >
                            复制 SQL
                          </button>
                          <button
                            className="btn btn-line operator-mini"
                            type="button"
                            onClick={promoteGeneratedSqlToTraining}
                          >
                            ＋ 沉淀至训练库
                          </button>
                        </>
                      )}
                      {queryResult.result && queryResult.result.length > 0 && (
                        <button
                          className="btn btn-line operator-mini"
                          type="button"
                          onClick={() =>
                            downloadBlob(
                              `health-risk-query-${Date.now()}.csv`,
                              `\uFEFF${rowsToCsv(queryResult.result!)}`,
                              "text/csv;charset=utf-8",
                            )
                          }
                        >
                          导出 CSV
                        </button>
                      )}
                    </div>
                  </div>

                  {queryResult.generated_sql && (
                    <div className="t2s-sql-box">
                      <span>Generated SQL</span>
                      <pre>{queryResult.generated_sql}</pre>
                    </div>
                  )}

                  {Array.isArray(queryResult.result) && (
                    queryResult.result.length > 0 ? (
                      <div className="t2s-table-wrap">
                        <table className="sheet-grid t2s-table">
                          <thead>
                            <tr>
                              <th className="sheet-corner">#</th>
                              {resultColumns.map((col) => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {queryResult.result.map((row, rowIndex) => (
                              <tr key={rowIndex}>
                                <th>{rowIndex + 1}</th>
                                {resultColumns.map((col) => (
                                  <td key={col}>
                                    {row[col] == null ? "—" : String(row[col])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="muted t2s-empty-rows">
                        SQL 已成功执行，当前筛选条件下未命中记录（0 行）。
                      </p>
                    )
                  )}
                </div>
              )}
            </div>
          )}

          {/* ==================== TAB 2: 增加训练 ==================== */}
          {tab === "add" && (
            <div className="t2s-pane">
              <div className="t2s-mode-bar">
                <div className="t2s-submodes" role="group" aria-label="录入方式">
                  <button
                    type="button"
                    className={addMode === "form" ? "active" : ""}
                    onClick={() => {
                      setAddMode("form");
                      setAddError("");
                    }}
                  >
                    分项录入（DDL / Document / SQL）
                  </button>
                  <button
                    type="button"
                    className={addMode === "json" ? "active" : ""}
                    onClick={() => {
                      setAddMode("json");
                      setAddError("");
                    }}
                  >
                    JSON 批量录入 / 文件导入
                  </button>
                </div>
                <span className="muted">支持单填其中一类，或同时提交三类训练语料</span>
              </div>

              {addMode === "form" ? (
                <div className="t2s-add-sections">
                  <section className="t2s-form-card">
                    <div className="t2s-card-head">
                      <div>
                        <span className="t2s-badge badge-ddl">DDL</span>
                        <strong>数据表结构定义（ddl）</strong>
                      </div>
                      <button
                        type="button"
                        className="btn btn-quiet operator-mini"
                        disabled={addingTrain}
                        onClick={() => setDdlInput(SAMPLE_DDL_TEMPLATE)}
                      >
                        填入示例 DDL
                      </button>
                    </div>
                    <textarea
                      aria-label="新增 DDL 建表语句"
                      className="t2s-code-input"
                      rows={4}
                      disabled={addingTrain}
                      value={ddlInput}
                      placeholder="CREATE TABLE IF NOT EXISTS ... （将写入 JSON 的 ddl 数组并训练至 Vanna）"
                      onChange={(e) => setDdlInput(e.target.value)}
                    />
                  </section>

                  <section className="t2s-form-card">
                    <div className="t2s-card-head">
                      <div>
                        <span className="t2s-badge badge-doc">DOC</span>
                        <strong>业务文档与字段口径说明（document）</strong>
                      </div>
                      <button
                        type="button"
                        className="btn btn-quiet operator-mini"
                        disabled={addingTrain}
                        onClick={() => setDocInput(SAMPLE_DOC_TEMPLATE)}
                      >
                        填入示例文档
                      </button>
                    </div>
                    <textarea
                      aria-label="新增业务文档说明"
                      rows={4}
                      disabled={addingTrain}
                      value={docInput}
                      placeholder="补充表字段业务含义、评分阈值规则、枚举值说明或常用统计口径…"
                      onChange={(e) => setDocInput(e.target.value)}
                    />
                  </section>

                  <section className="t2s-form-card">
                    <div className="t2s-card-head">
                      <div>
                        <span className="t2s-badge badge-sql">SQL</span>
                        <strong>示例 SQL 查询语句（sql）</strong>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-quiet operator-mini"
                          disabled={addingTrain}
                          onClick={() =>
                            setSqlRows([
                              {
                                id: makeRowId(),
                                question: "查询70岁及以上且总分大于等于3分的高龄营养风险患者",
                                sql: SAMPLE_SQL_TEMPLATE,
                              },
                            ])
                          }
                        >
                          填入示例 SQL
                        </button>
                        <button
                          type="button"
                          className="btn btn-line operator-mini"
                          disabled={addingTrain}
                          onClick={() =>
                            setSqlRows((rows) => [...rows, { id: makeRowId(), question: "", sql: "" }])
                          }
                        >
                          ＋ 再加一条 SQL
                        </button>
                      </div>
                    </div>

                    <div className="t2s-sql-rows">
                      {sqlRows.map((row, idx) => (
                        <div key={row.id} className="t2s-sql-row">
                          <div className="t2s-sql-row-top">
                            <span>示例 SQL #{idx + 1}</span>
                            {sqlRows.length > 1 && (
                              <button
                                type="button"
                                className="btn btn-quiet operator-mini"
                                disabled={addingTrain}
                                onClick={() =>
                                  setSqlRows((rows) => rows.filter((item) => item.id !== row.id))
                                }
                              >
                                移除
                              </button>
                            )}
                          </div>
                          <input
                            aria-label={`示例 SQL ${idx + 1} 对应问题`}
                            disabled={addingTrain}
                            value={row.question}
                            placeholder="可选：对应的自然语言问题（如：查询高龄营养风险患者名单）"
                            onChange={(e) =>
                              setSqlRows((rows) =>
                                rows.map((item) =>
                                  item.id === row.id ? { ...item, question: e.target.value } : item,
                                ),
                              )
                            }
                          />
                          <textarea
                            aria-label={`示例 SQL ${idx + 1} 语句`}
                            className="t2s-code-input"
                            rows={2}
                            disabled={addingTrain}
                            value={row.sql}
                            placeholder="SELECT user_name, age, total_score FROM user_health_risk_assessment WHERE ..."
                            onChange={(e) =>
                              setSqlRows((rows) =>
                                rows.map((item) =>
                                  item.id === row.id ? { ...item, sql: e.target.value } : item,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="t2s-form-card">
                  <div className="t2s-card-head">
                    <div>
                      <strong>批量 JSON 语料（含 ddl / document / sql）</strong>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <input
                        ref={jsonFileRef}
                        type="file"
                        accept=".json,application/json"
                        className="sr-only"
                        aria-label="上传训练 JSON 文件"
                        onChange={(e) => {
                          handleJsonFileUpload(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-line operator-mini"
                        disabled={addingTrain}
                        onClick={() => jsonFileRef.current?.click()}
                      >
                        导入本地 .json 文件
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet operator-mini"
                        disabled={addingTrain}
                        onClick={() => setJsonInput(SAMPLE_JSON_TEMPLATE)}
                      >
                        填入 JSON 模板
                      </button>
                    </div>
                  </div>
                  <textarea
                    aria-label="批量 JSON 训练语料内容"
                    className="t2s-code-input"
                    rows={11}
                    disabled={addingTrain}
                    value={jsonInput}
                    placeholder={'{\n  "ddl": ["CREATE TABLE ..."],\n  "document": ["字段业务说明..."],\n  "sql": ["SELECT ..."]\n}'}
                    onChange={(e) => setJsonInput(e.target.value)}
                  />
                  {jsonInput.trim() && (
                    <div
                      className={`t2s-json-check ${jsonValidation.valid ? "ok" : "err"}`}
                      role="status"
                    >
                      {jsonValidation.valid && jsonValidation.summary
                        ? `✓ JSON 校验通过：待追加 DDL ${jsonValidation.summary.ddl} 条 · Document ${jsonValidation.summary.document} 条 · SQL ${jsonValidation.summary.sql} 条`
                        : jsonValidation.error}
                    </div>
                  )}
                </div>
              )}

              {addError && (
                <div className="inline-error" role="alert">
                  <p>{addError}</p>
                </div>
              )}

              <div className="t2s-submit-bar">
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={
                    addingTrain ||
                    (addMode === "form" ? !formHasContent : !jsonValidation.valid)
                  }
                  onClick={() => handleAddTraining(true)}
                >
                  {addingTrain ? "正在写入 JSON 并训练…" : "保存至 JSON 并增加训练"}
                </button>
                <button
                  className="btn btn-line"
                  type="button"
                  disabled={
                    addingTrain ||
                    (addMode === "form" ? !formHasContent : !jsonValidation.valid)
                  }
                  onClick={() => handleAddTraining(false)}
                >
                  仅写入 JSON 文件
                </button>
                <span className="muted">
                  调用 <code>POST /api/v1/text2sql/train/add</code>（自动去重，避免重复写入）
                </span>
              </div>

              {lastAddResult && (
                <div className="t2s-receipt" role="status">
                  <div className="t2s-receipt-head">
                    <span className="success-check" aria-hidden="true">
                      ✓
                    </span>
                    <div>
                      <strong>
                        {lastAddResult.trained
                          ? "增量训练已完成，语料已同步至 JSON 与 Vanna"
                          : "训练语料已写入 JSON 文件"}
                      </strong>
                      <span className="muted">
                        新增写入：DDL +{lastAddResult.added.ddl} · Document +{lastAddResult.added.document} · SQL +
                        {lastAddResult.added.sql}
                        {lastAddResult.skipped_duplicates.ddl +
                          lastAddResult.skipped_duplicates.document +
                          lastAddResult.skipped_duplicates.sql >
                        0
                          ? `（自动跳过已存在的重复项 ${
                              lastAddResult.skipped_duplicates.ddl +
                              lastAddResult.skipped_duplicates.document +
                              lastAddResult.skipped_duplicates.sql
                            } 条）`
                          : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-line operator-mini"
                      onClick={() => setTab("corpus")}
                    >
                      查看语料库 ({lastAddResult.counts.total}) →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== TAB 3: 训练语料库 ==================== */}
          {tab === "corpus" && (
            <div className="t2s-pane">
              <div className="t2s-corpus-toolbar">
                <div className="t2s-filter-pills" role="group" aria-label="语料类别筛选">
                  <button
                    type="button"
                    className={corpusCategory === "all" ? "active" : ""}
                    onClick={() => setCorpusCategory("all")}
                  >
                    全部 ({counts.total})
                  </button>
                  <button
                    type="button"
                    className={corpusCategory === "ddl" ? "active" : ""}
                    onClick={() => setCorpusCategory("ddl")}
                  >
                    DDL ({counts.ddl})
                  </button>
                  <button
                    type="button"
                    className={corpusCategory === "document" ? "active" : ""}
                    onClick={() => setCorpusCategory("document")}
                  >
                    Document ({counts.document})
                  </button>
                  <button
                    type="button"
                    className={corpusCategory === "sql" ? "active" : ""}
                    onClick={() => setCorpusCategory("sql")}
                  >
                    SQL ({counts.sql})
                  </button>
                </div>

                <div className="t2s-corpus-actions">
                  <input
                    aria-label="搜索训练语料"
                    value={corpusSearch}
                    placeholder="过滤关键字…"
                    onChange={(e) => setCorpusSearch(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-line operator-mini"
                    disabled={!corpus}
                    onClick={exportCorpusJson}
                  >
                    导出 JSON
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary operator-mini"
                    onClick={() => setTab("add")}
                  >
                    ＋ 新增训练
                  </button>
                </div>
              </div>

              {corpus && (
                <details
                  className="chunk-payload"
                  open={showRawJson}
                  onToggle={(e) => setShowRawJson((e.target as HTMLDetailsElement).open)}
                >
                  <summary>预览 {corpus.file_name} 完整 JSON 结构</summary>
                  <pre>
                    {JSON.stringify(
                      { ddl: corpus.ddl, document: corpus.document, sql: corpus.sql },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}

              {!filteredCorpusItems.length ? (
                <div className="t2s-empty-box">
                  <p>没有匹配的训练语料条目。</p>
                  <button type="button" className="btn btn-line" onClick={() => setTab("add")}>
                    前往增加训练语料
                  </button>
                </div>
              ) : (
                <ul className="t2s-corpus-list">
                  {filteredCorpusItems.map((item) => {
                    const itemKey = `${item.category}-${item.index}`;
                    const label =
                      item.category === "ddl"
                        ? "DDL"
                        : item.category === "document"
                          ? "DOC"
                          : "SQL";
                    return (
                      <li key={itemKey} className="t2s-corpus-item">
                        <div className="t2s-corpus-item-head">
                          <div>
                            <span
                              className={`t2s-badge badge-${
                                item.category === "document" ? "doc" : item.category
                              }`}
                            >
                              {label}
                            </span>
                            <strong>
                              {item.category} #{item.index + 1}
                            </strong>
                            {item.question && (
                              <span className="t2s-item-question">问题：{item.question}</span>
                            )}
                          </div>
                          <div className="t2s-corpus-item-btns">
                            {item.category === "sql" && item.question && (
                              <button
                                type="button"
                                className="btn btn-quiet operator-mini"
                                onClick={() => {
                                  setQuestion(item.question!);
                                  setTab("query");
                                }}
                              >
                                去试查
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-quiet operator-mini"
                              onClick={() => copyText(item.text, `${label} 语料`)}
                            >
                              复制
                            </button>
                            <button
                              type="button"
                              className="btn btn-quiet operator-mini t2s-del-btn"
                              disabled={deletingKey === itemKey}
                              aria-label={`删除 ${item.category} 第 ${item.index + 1} 条`}
                              onClick={() => handleRemoveCorpusItem(item.category, item.index)}
                            >
                              {deletingKey === itemKey ? "移除中…" : "移除"}
                            </button>
                          </div>
                        </div>
                        <pre className={item.category === "document" ? "is-doc" : ""}>
                          {item.text}
                        </pre>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* ==================== TAB 4: 数据表结构 ==================== */}
          {tab === "tables" && (
            <div className="t2s-pane">
              <div className="t2s-schema-bar">
                <label className="field" style={{ flex: 1 }}>
                  <span>查询目标表名（MySQL information_schema.COLUMNS）</span>
                  <input
                    aria-label="查询目标表名"
                    value={tableName}
                    placeholder="user_health_risk_assessment"
                    onChange={(e) => setTableName(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-line"
                  disabled={loadingColumns || !tableName.trim()}
                  onClick={() => loadTableSchema(tableName)}
                >
                  {loadingColumns ? "读取中…" : "读取表字段"}
                </button>
              </div>

              {columnsError && (
                <div className="assistant-warn" role="status">
                  {columnsError}
                  <div style={{ marginTop: 4 }}>
                    首次建表可执行：
                    <code>mysql -uroot -p test_db &lt; backend/sql/user_health_risk_assessment.sql</code>
                  </div>
                </div>
              )}

              {columns && columns.length > 0 && (
                <div className="t2s-table-wrap">
                  <table className="sheet-grid t2s-table">
                    <thead>
                      <tr>
                        <th className="sheet-corner">#</th>
                        <th>字段名 (COLUMN_NAME)</th>
                        <th>数据类型 (DATA_TYPE)</th>
                        <th>字段注释 (COLUMN_COMMENT)</th>
                        <th>所属表 (TABLE_NAME)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((col, idx) => (
                        <tr key={`${col.COLUMN_NAME}-${idx}`}>
                          <th>{idx + 1}</th>
                          <td>
                            <code>{col.COLUMN_NAME}</code>
                          </td>
                          <td>{col.DATA_TYPE}</td>
                          <td>{col.COLUMN_COMMENT || "—"}</td>
                          <td>{col.TABLE_NAME}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {columns && columns.length === 0 && !columnsError && (
                <div className="assistant-warn" role="status">
                  当前 MySQL 库中未找到表 <code>{tableName}</code>，请先执行{" "}
                  <code>backend/sql/user_health_risk_assessment.sql</code> 建表。
                </div>
              )}

              {corpus && corpus.ddl.length > 0 && (
                <div className="t2s-ddl-reference">
                  <h3>JSON 训练文件中已登记的建表 DDL（{corpus.ddl.length} 份）</h3>
                  {corpus.ddl.map((ddlText, idx) => (
                    <div key={idx} className="t2s-sql-box">
                      <span>DDL #{idx + 1}</span>
                      <pre>{ddlText}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
