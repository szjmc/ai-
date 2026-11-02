// Extracts a renderable ECharts option from whatever shape a Text2Echarts
// workflow returns. Dify-style workflows answer with Markdown such as:
//
//   ```echarts
//   { "series": [...], "xAxis": {...} }
//   ```
//
// so the parser must accept any code-fence language (json/echarts/javascript/
// none), prose around the JSON, and JSON that is stringified or nested inside
// answer/outputs/data fields. Deliberately never evaluates JavaScript and never
// parses formatter functions.

const CODE_FENCE = /```[^\n`]*\n?([\s\S]*?)```/g;
const KNOWN_KEYS = ["option", "options", "answer", "outputs", "data", "result", "text", "content", "message", "messages", "choices"];
// Looking at every "{" of a long transcript would be quadratic; the option is
// always near the start of a real answer.
const MAX_JSON_STARTS = 24;

type JsonObject = Record<string, unknown>;

function isOptionLike(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const series = (value as JsonObject).series;
  return typeof series === "object" && series !== null;
}

/** Candidate JSON substrings embedded in free-form text. */
function jsonSpans(text: string): string[] {
  const spans: string[] = [];
  const starts: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "[") starts.push(index);
  }
  for (const start of starts.slice(0, MAX_JSON_STARTS)) {
    const closing = text[start] === "{" ? "}" : "]";
    const end = text.lastIndexOf(closing);
    if (end > start) spans.push(text.slice(start, end + 1));
  }
  return spans;
}

function parseJson(candidate: string): unknown {
  const body = candidate.trim();
  if (!body) return undefined;
  try { return JSON.parse(body); } catch { /* fall through to lenient parse */ }
  try { return JSON.parse(body.replace(/,\s*([}\]])/g, "$1")); } catch { return undefined; }
}

/** All JSON values that can be recovered from a string (fences, spans, whole). */
function parseAll(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const candidates: string[] = [];
  for (const match of trimmed.matchAll(CODE_FENCE)) if (match[1].trim()) candidates.push(match[1]);
  candidates.push(trimmed);
  candidates.push(...jsonSpans(trimmed));
  const values: unknown[] = [];
  for (const candidate of candidates) {
    const parsed = parseJson(candidate);
    if (parsed !== undefined) values.push(parsed);
  }
  return values;
}

function search(value: unknown, depth: number): JsonObject | null {
  if (value == null || depth > 12) return null;
  if (typeof value === "string") {
    for (const parsed of parseAll(value)) {
      const found = search(parsed, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = search(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value !== "object") return null;
  const object = value as JsonObject;
  if (isOptionLike(object)) return object;
  // Some workflow outputs wrap the option in their own keys; check the known
  // wrappers first, then every remaining value as a fallback.
  const orderedKeys = [...KNOWN_KEYS.filter((key) => key in object), ...Object.keys(object).filter((key) => !KNOWN_KEYS.includes(key))];
  for (const key of orderedKeys) {
    const found = search(object[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Returns the ECharts option found anywhere inside a Text2Echarts workflow result. */
export function extractEchartsOption(value: unknown): JsonObject | null {
  return search(value, 0);
}
