export type GraphChartType = "柱状图" | "折线图" | "饼图";

export type GraphTableCell = string | number;

export type GraphTable = {
  columns: string[];
  rows: GraphTableCell[][];
  value_column?: number;
  share_column?: number;
  value_label?: string;
  label_label?: string;
  row_count?: number;
  total?: number | null;
};

export type GraphReport = {
  metrics: { label: string; value: string; hint: string }[];
  summary: string;
  insight?: string | null;
  insight_tone?: "warn" | "info" | string | null;
};

export type GraphStep = {
  id: string;
  text: string;
  agent?: string;
};

export type GraphInterruptInfo = {
  reason: string;
  prompt: string;
  chartType: string;
  rowCount: number;
  humanNote: string;
  checkpointId?: string;
};

export type GraphCheckpointItem = {
  checkpoint_id: string;
  step: number | null;
  next_nodes: string[];
  completed_agents: string[];
  chart_type?: string;
};

export type GraphStreamState = {
  status: "idle" | "streaming" | "interrupted" | "cancelled" | "done" | "error";
  question: string;
  chartType: string;
  title: string;
  subtitle: string;
  threadId: string;
  checkpointId: string;
  completedAgents: string[];
  supervisorTrace: string[];
  checkpoints: GraphCheckpointItem[];
  humanNote: string;
  interruptInfo: GraphInterruptInfo | null;
  steps: GraphStep[];
  analysisMarkdown: string;
  summary: string;
  table: GraphTable | null;
  report: GraphReport | null;
  echartsOption: Record<string, unknown> | null;
  error: string | null;
  executionTime: number | null;
};

const CHART_ALIASES: Record<string, GraphChartType> = {
  柱状图: "柱状图",
  bar: "柱状图",
  折线图: "折线图",
  line: "折线图",
  饼图: "饼图",
  pie: "饼图",
};

let stepSeq = 0;
function nextStepId() {
  stepSeq += 1;
  return `hg-step-${Date.now()}-${stepSeq}`;
}

export function createInitialGraphState(question = ""): GraphStreamState {
  return {
    status: "idle",
    question,
    chartType: "",
    title: "",
    subtitle: "",
    threadId: "",
    checkpointId: "",
    completedAgents: [],
    supervisorTrace: [],
    checkpoints: [],
    humanNote: "",
    interruptInfo: null,
    steps: [],
    analysisMarkdown: "",
    summary: "",
    table: null,
    report: null,
    echartsOption: null,
    error: null,
    executionTime: null,
  };
}

export function parseQuestionChartHint(rawQuestion: string): {
  cleanQuestion: string;
  chartType: GraphChartType | null;
} {
  const trimmed = rawQuestion.trim();
  const match = trimmed.match(/[（(]\s*([^()（）]+?)\s*[）)]\s*$/);
  if (!match) return { cleanQuestion: trimmed, chartType: null };
  const candidate = match[1].trim();
  const matchedType = CHART_ALIASES[candidate] || CHART_ALIASES[candidate.toLowerCase()] || null;
  if (!matchedType) return { cleanQuestion: trimmed, chartType: null };
  const clean = trimmed.slice(0, match.index).trim();
  return {
    cleanQuestion: clean || trimmed,
    chartType: matchedType,
  };
}

function isEchartsOption(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.series) || (typeof record.series === "object" && record.series !== null);
}

function parseLenientJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
}

export function extractChartFromText(markdown: string): {
  cleanedMarkdown: string;
  echartsOption: Record<string, unknown> | null;
} {
  if (!markdown) return { cleanedMarkdown: "", echartsOption: null };
  let extracted: Record<string, unknown> | null = null;
  const cleaned = markdown
    .replace(/```(echarts|json)?\s*([\s\S]*?)```/gi, (full, _lang, inner: string) => {
      const parsed = parseLenientJson(inner);
      if (isEchartsOption(parsed)) {
        if (!extracted) extracted = parsed;
        return "";
      }
      return full;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedMarkdown: cleaned, echartsOption: extracted };
}

function normalizeTable(raw: unknown): GraphTable | null {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) {
    return tableFromObjects(raw as Record<string, unknown>[]);
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.columns) || !Array.isArray(obj.rows)) return null;
  const columns = obj.columns.map((c) => String(c));
  const rows = obj.rows
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) =>
      r.map((cell) => {
        if (typeof cell === "number" || typeof cell === "string") return cell;
        if (cell == null) return "";
        return String(cell);
      }),
    );
  if (!columns.length || !rows.length) return null;
  return {
    columns,
    rows,
    value_column: typeof obj.value_column === "number" ? obj.value_column : undefined,
    share_column: typeof obj.share_column === "number" ? obj.share_column : undefined,
    value_label: typeof obj.value_label === "string" ? obj.value_label : undefined,
    label_label: typeof obj.label_label === "string" ? obj.label_label : undefined,
    row_count: typeof obj.row_count === "number" ? obj.row_count : rows.length,
    total: typeof obj.total === "number" || obj.total === null ? obj.total : undefined,
  };
}

export function tableFromObjects(items: Record<string, unknown>[]): GraphTable | null {
  const validRows = items.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (!validRows.length) return null;
  const columns = Object.keys(validRows[0]).slice(0, 10);
  if (!columns.length) return null;
  const rows: GraphTableCell[][] = validRows.map((item) =>
    columns.map((col) => {
      const val = item[col];
      if (typeof val === "number" || typeof val === "string") return val;
      if (val == null) return "";
      return String(val);
    }),
  );
  return {
    columns,
    rows,
    row_count: rows.length,
  };
}

function appendStep(steps: GraphStep[], rawText: string, agent?: string): GraphStep[] {
  const text = rawText.trim();
  if (!text) return steps;
  if (steps.length > 0 && steps[steps.length - 1].text === text) {
    return steps;
  }
  return [...steps, { id: nextStepId(), text, agent }];
}

function resolveOptionCandidate(obj: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [
    obj.echarts_option,
    obj.echartsOption,
    obj.option,
    obj.chart_option,
    obj.chartOption,
    obj.echarts_config,
    obj.echartsConfig,
    obj.echarts,
    obj.chart,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isEchartsOption(candidate)) return candidate;
    if (typeof candidate === "string") {
      const fromText = extractChartFromText(candidate).echartsOption;
      if (fromText) return fromText;
      const direct = parseLenientJson(candidate);
      if (isEchartsOption(direct)) return direct;
    }
  }
  return null;
}

export function splitSseFrames(buffer: string): {
  frames: Array<{ event: string; data: string }>;
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: Array<{ event: string; data: string }> = [];

  for (const block of parts) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      } else if (!line.includes(":")) {
        dataLines.push(line);
      }
    }
    if (dataLines.length > 0) {
      frames.push({ event: eventName, data: dataLines.join("\n") });
    }
  }
  return { frames, rest };
}

export function applyGraphPayload(
  prev: GraphStreamState,
  eventName: string,
  rawData: string,
): GraphStreamState {
  const trimmed = rawData.trim();
  if (!trimmed) return prev;
  if (trimmed === "[DONE]") {
    if (prev.status === "error" || prev.status === "interrupted" || prev.status === "cancelled") {
      return prev;
    }
    return {
      ...prev,
      status: "done",
    };
  }

  let next: GraphStreamState = { ...prev };
  const parsed = parseLenientJson(trimmed);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const evt = eventName.toLowerCase();
    if (evt === "analysis" || evt === "token" || evt === "delta" || evt === "analysis_chunk") {
      const combined = next.analysisMarkdown ? `${next.analysisMarkdown}${trimmed}` : trimmed;
      const { cleanedMarkdown, echartsOption } = extractChartFromText(combined);
      next.analysisMarkdown = cleanedMarkdown;
      if (echartsOption && !next.echartsOption) next.echartsOption = echartsOption;
    } else if (evt === "error") {
      next.status = "error";
      next.error = trimmed;
    } else {
      next.steps = appendStep(next.steps, trimmed);
    }
    return next;
  }

  const root = parsed as Record<string, unknown>;
  const obj =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? { ...root, ...(root.data as Record<string, unknown>) }
      : root;

  const eventType = String(obj.type || obj.event || eventName || "").toLowerCase();

  if (typeof obj.thread_id === "string" && obj.thread_id.trim()) {
    next.threadId = obj.thread_id.trim();
  }
  if (typeof obj.checkpoint_id === "string" && obj.checkpoint_id.trim()) {
    next.checkpointId = obj.checkpoint_id.trim();
  }
  if (Array.isArray(obj.completed_agents)) {
    next.completedAgents = obj.completed_agents.map((a) => String(a));
  }
  if (Array.isArray(obj.supervisor_trace)) {
    next.supervisorTrace = obj.supervisor_trace.map((t) => String(t));
  }
  if (Array.isArray(obj.checkpoints)) {
    next.checkpoints = obj.checkpoints
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
      .map((c) => ({
        checkpoint_id: String(c.checkpoint_id || ""),
        step: typeof c.step === "number" ? c.step : null,
        next_nodes: Array.isArray(c.next_nodes) ? c.next_nodes.map((n) => String(n)) : [],
        completed_agents: Array.isArray(c.completed_agents)
          ? c.completed_agents.map((a) => String(a))
          : [],
        chart_type: typeof c.chart_type === "string" ? c.chart_type : undefined,
      }));
  }
  if (typeof obj.human_note === "string") {
    next.humanNote = obj.human_note.trim();
  }

  // 人工干预 / 暂停中断事件
  if (eventType === "interrupt" || obj.interrupted === true) {
    next.status = "interrupted";
    next.interruptInfo = {
      reason: typeof obj.reason === "string" ? obj.reason : "human_review",
      prompt: typeof obj.prompt === "string" ? obj.prompt : "请在检查点确认参数后恢复继续",
      chartType: typeof obj.chart_type === "string" && obj.chart_type.trim() ? obj.chart_type.trim() : next.chartType || "柱状图",
      rowCount: typeof obj.row_count === "number" ? obj.row_count : next.table?.row_count || 0,
      humanNote: typeof obj.human_note === "string" ? obj.human_note : next.humanNote,
      checkpointId: typeof obj.checkpoint_id === "string" ? obj.checkpoint_id : next.checkpointId,
    };
    if (typeof obj.execution_time === "number") {
      next.executionTime = obj.execution_time;
    }
    return next;
  }

  // 人工终止事件
  if (eventType === "cancelled" || obj.cancelled === true) {
    next.status = "cancelled";
    next.interruptInfo = null;
    if (typeof obj.message === "string" && obj.message.trim()) {
      next.steps = appendStep(next.steps, obj.message, "supervisor");
    }
    if (typeof obj.execution_time === "number") {
      next.executionTime = obj.execution_time;
    }
    return next;
  }

  // 错误事件
  if (eventType === "error" || (obj.success === false && typeof obj.error === "string")) {
    next.status = "error";
    next.interruptInfo = null;
    next.error =
      (typeof obj.error === "string" && obj.error) ||
      (typeof obj.message === "string" && obj.message) ||
      "本次分析未能完成，请调整问题后重试。";
    return next;
  }

  // 步骤 / 思考过程事件
  if (
    eventType === "step" ||
    eventType === "process" ||
    eventType === "log" ||
    eventType === "progress" ||
    eventType === "status" ||
    (typeof obj.step === "number" && typeof obj.message === "string") ||
    typeof obj.log === "string" ||
    typeof obj.thinking === "string"
  ) {
    const stepMsg =
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.log === "string" && obj.log) ||
      (typeof obj.thinking === "string" && obj.thinking) ||
      (typeof obj.content === "string" && obj.content) ||
      (typeof obj.text === "string" && obj.text) ||
      "";
    const agent = typeof obj.agent === "string" ? obj.agent : undefined;
    if (stepMsg) {
      next.steps = appendStep(next.steps, stepMsg, agent);
      if (agent && !next.completedAgents.includes(agent) && /完成/.test(stepMsg)) {
        next.completedAgents = [...next.completedAgents, agent];
      }
    }
  }

  // 增量文本片段事件
  if (eventType === "token" || eventType === "delta" || eventType === "analysis_chunk") {
    const chunk =
      (typeof obj.delta === "string" && obj.delta) ||
      (typeof obj.content === "string" && obj.content) ||
      (typeof obj.text === "string" && obj.text) ||
      "";
    if (chunk) {
      const combined = `${next.analysisMarkdown}${chunk}`;
      const { cleanedMarkdown, echartsOption } = extractChartFromText(combined);
      next.analysisMarkdown = cleanedMarkdown;
      if (echartsOption && !next.echartsOption) next.echartsOption = echartsOption;
    }
  }

  // 完整分析 / 结论 / 总结文本
  const fullAnalysis =
    (typeof obj.analysis === "string" && obj.analysis) ||
    (typeof obj.analysis_markdown === "string" && obj.analysis_markdown) ||
    (typeof obj.conclusion === "string" && obj.conclusion) ||
    (typeof obj.final_result === "string" && obj.final_result) ||
    (typeof obj.answer === "string" && obj.answer) ||
    (eventType === "analysis" && typeof obj.content === "string" ? obj.content : "");

  if (fullAnalysis) {
    const { cleanedMarkdown, echartsOption } = extractChartFromText(fullAnalysis);
    next.analysisMarkdown = cleanedMarkdown;
    if (echartsOption && !next.echartsOption) {
      next.echartsOption = echartsOption;
    }
  }

  if (typeof obj.summary === "string" && obj.summary.trim()) {
    next.summary = obj.summary.trim();
  }

  // 表格数据
  const parsedTable =
    normalizeTable(obj.table) ||
    normalizeTable(obj.data_table) ||
    (Array.isArray(obj.rows) ? tableFromObjects(obj.rows as Record<string, unknown>[]) : null) ||
    (Array.isArray(root.data) ? tableFromObjects(root.data as Record<string, unknown>[]) : null);
  if (parsedTable) {
    next.table = parsedTable;
  }

  // 报告指标
  if (obj.report && typeof obj.report === "object" && !Array.isArray(obj.report)) {
    const r = obj.report as Record<string, unknown>;
    if (typeof r.summary === "string" || Array.isArray(r.metrics)) {
      next.report = {
        metrics: Array.isArray(r.metrics)
          ? (r.metrics as { label: string; value: string; hint: string }[])
          : [],
        summary: typeof r.summary === "string" ? r.summary : "",
        insight: typeof r.insight === "string" ? r.insight : null,
        insight_tone: typeof r.insight_tone === "string" ? r.insight_tone : null,
      };
      if (!next.summary && next.report.summary) {
        next.summary = next.report.summary;
      }
    }
  }

  // ECharts 图表配置
  const option = resolveOptionCandidate(obj);
  if (option) {
    next.echartsOption = option;
  }

  if (typeof obj.chart_type === "string" && obj.chart_type.trim()) {
    next.chartType = obj.chart_type.trim();
  }
  if (typeof obj.title === "string" && obj.title.trim()) {
    next.title = obj.title.trim();
  }
  if (typeof obj.subtitle === "string" && obj.subtitle.trim()) {
    next.subtitle = obj.subtitle.trim();
  }
  if (typeof obj.execution_time === "number") {
    next.executionTime = obj.execution_time;
  }

  if (Array.isArray(obj.steps)) {
    for (const s of obj.steps) {
      if (typeof s === "string") next.steps = appendStep(next.steps, s);
    }
  }

  if (eventType === "result" || eventType === "done" || eventType === "final") {
    next.status = next.error ? "error" : "done";
    next.interruptInfo = null;
  }

  return next;
}

export async function consumeGraphGenerateStream(
  response: Response,
  initialState: GraphStreamState,
  onUpdate: (state: GraphStreamState) => void,
): Promise<GraphStreamState> {
  let state: GraphStreamState = { ...initialState, status: "streaming" };
  onUpdate(state);

  const contentType = (response.headers.get("content-type") || "").toLowerCase();

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown; message?: unknown; detail?: unknown } | null;
    const msg =
      (typeof payload?.error === "string" && payload.error) ||
      (typeof payload?.message === "string" && payload.message) ||
      (typeof payload?.detail === "string" && payload.detail) ||
      "本次分析未能完成，请稍后重试。";
    state = { ...state, status: "error", error: msg };
    onUpdate(state);
    return state;
  }

  if (!contentType.includes("text/event-stream") || !response.body) {
    const rawText = await response.text();
    const json = parseLenientJson(rawText);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      state = applyGraphPayload(state, "result", rawText);
      if (state.steps.length === 0 && state.status !== "error") {
        state = {
          ...state,
          steps: [
            { id: nextStepId(), text: "开始处理请求" },
            { id: nextStepId(), text: "所有步骤完成" },
          ],
        };
      }
      state = { ...state, status: state.error ? "error" : "done" };
    } else {
      state = {
        ...state,
        status: "error",
        error: "分析服务返回了无法识别的响应格式。",
      };
    }
    onUpdate(state);
    return state;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        state = applyGraphPayload(state, frame.event, frame.data);
        onUpdate(state);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const { frames } = splitSseFrames(`${buffer}\n\n`);
      for (const frame of frames) {
        state = applyGraphPayload(state, frame.event, frame.data);
        onUpdate(state);
      }
    }
    if (state.status === "streaming") {
      state = { ...state, status: state.error ? "error" : "done" };
      onUpdate(state);
    }
    return state;
  } finally {
    reader.releaseLock();
  }
}
