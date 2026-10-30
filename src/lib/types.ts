export const FILE_TYPES = ["pdf", "doc", "docx", "xls", "xlsx", "txt", "sql", "json", "md", "png", "jpg", "jpeg", "webp", "gif"] as const;
export type FileType = (typeof FILE_TYPES)[number];
export const FILE_STATUSES = ["uploaded", "active", "inactive", "archived"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];
export const CHUNK_STRATEGIES = ["adaptive", "fixed", "semantic", "recursive", "paragraph"] as const;
export type ChunkStrategy = (typeof CHUNK_STRATEGIES)[number];

export type FileDict = {
  id: string; collection_name: string; file_name: string; file_type: string; minio_path: string;
  chunk_strategy: string; description: string; status: string; created_time: string; updated_time: string;
  created_by: number; updated_by: number; version_no: number; original_name: string; file_size: number;
  content_type: string; file_url: string;
};
export type PageInfo = { page: number; per_page: number; total: number; pages: number };
/** A person who can create/update records. knowledge_files stores only the integer id. */
export type Operator = { id: number; name: string; role?: string };
export type CollectionStat = { name: string; count: number };
export type NamedCount = { key: string; count: number };
export type Stats = {
  total: number; bytes: number; active: number; uploaded: number; inactive: number; archived: number;
  bucket: string; collections: CollectionStat[]; statuses: NamedCount[]; types: NamedCount[];
  storage_mode: "mysql" | "local"; storage_note: string; minio_endpoint?: string; mysql_db?: string;
  storage_reason?: string | null; storage_hint?: string | null;
};
/** A merged range, expressed in displayed (row, column) positions, not Excel addresses. */
export type SheetMerge = { row: number; col: number; row_span: number; col_span: number };
export type SpreadsheetTable = {
  /** Cell text for the displayed (non-hidden) rows and columns. */
  rows: string[][];
  /** Real Excel row numbers for each displayed row, so "row 12" here is row 12 in Excel. */
  row_numbers: number[];
  /** Real Excel column letters for each displayed column. */
  columns: string[];
  merges: SheetMerge[];
  total_rows: number; total_columns: number; truncated: boolean;
};
export type PreviewPayload = {
  kind: "text" | "pdf" | "image" | "document" | "spreadsheet" | "binary";
  text: string; truncated: boolean; content_type: string;
  document_html?: string; warnings?: string[];
  sheet_names?: string[]; active_sheet?: string; table?: SpreadsheetTable;
};
/** Result returned by the FastAPI chunking service (app/services/chunk_service.py). */
export type ChunkResult = {
  file_id: string;
  file_name: string;
  minio_path: string;
  chunks_processed: number;
  chunk_ids: (string | number)[];
  process_time: string;
};
export type ChunkServiceStatus = {
  reachable: boolean;
  base_url: string;
  endpoint: string;
  reason?: string;
  hint?: string;
};

/** FastAPI /api/v1/chat/systemRagQuery 返回的评分结构（backend: rag_query_service.py） */
export type RagScoreInfo = {
  score: number;
  nutritional_impairment: number;
  disease_severity: number;
  age: number;
  basis: string;
};
export type RagSourceBasis = {
  file_name?: string;
  file_id?: string;
  rule_fragment?: string;
  retrieval_type?: string;
  pk?: string;
};
export type RagQueryResult = {
  score_info: RagScoreInfo;
  source_basis: RagSourceBasis[];
  query_params?: {
    file_id?: string;
    collection_name?: string;
    top_k?: number;
    query_time?: string;
  };
};
export type ChatStatus = {
  chat: { reachable: boolean; base_url: string; endpoint: string; reason?: string; hint?: string };
  asr: {
    configured: boolean;
    model: string;
    endpoint: string;
    has_api_key: boolean;
    source: "fastapi_backend" | "env" | "backend/.env" | "none";
  };
  defaults: { collection_name: string };
  backend_config?: unknown;
};

/** Text2SQL 智能问数与增量训练（backend: text2sql_router.py & vanna_engine.py） */
export type TrainingCategory = "ddl" | "document" | "sql";
export type SqlTrainingItem = string | { question?: string; sql: string };

export type TrainingCounts = {
  ddl: number;
  document: number;
  sql: number;
  total: number;
};

export type TrainingCorpusData = {
  ddl: string[];
  document: string[];
  sql: SqlTrainingItem[];
  counts: TrainingCounts;
  file_name: string;
  updated_at: string;
  source?: "fastapi_backend" | "local_json";
};

export type AddTrainingPayload = {
  ddl?: string | string[];
  document?: string | string[];
  documentation?: string | string[];
  sql?: SqlTrainingItem | SqlTrainingItem[];
  question?: string;
  auto_train?: boolean;
};

export type AddTrainingResult = TrainingCorpusData & {
  added: { ddl: number; document: number; sql: number };
  skipped_duplicates: { ddl: number; document: number; sql: number };
  trained: boolean;
  trained_counts: { ddl: number; document: number; sql: number };
};

export type FullTrainResult = {
  trained_counts?: { ddl: number; document: number; sql: number };
  totals?: TrainingCounts;
  file_path?: string;
  updated_at?: string;
};

export type Text2SqlQueryPayload = {
  question: string;
  user_id?: string;
  limit?: number;
  auto_execute?: boolean;
};

export type Text2SqlQueryResult = {
  success: boolean;
  question: string;
  generated_sql?: string | null;
  result?: Record<string, unknown>[] | null;
  error?: string | null;
  execution_time: number;
};

export type TableColumnInfo = {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_COMMENT?: string | null;
};

export type Text2SqlStatus = {
  service: {
    reachable: boolean;
    base_url: string;
    endpoint: string;
    reason?: string;
    hint?: string;
  };
  health: {
    database_connected: boolean;
    model_loaded: boolean;
    init_error?: string | null;
    llm_model?: string;
    ollama_host?: string;
    mysql_db?: string;
  } | null;
  corpus: TrainingCorpusData;
};

export type ApiBody<T> = { status: number; message: string; data: T; page: PageInfo | null };
