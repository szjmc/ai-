import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import * as XLSX from "xlsx";
import { ApiError } from "./errors";
import type { PreviewPayload, SheetMerge, SpreadsheetTable } from "./types";

const MAX_HTML_CHARS = 3_000_000;
const MAX_ROWS = 1000;
const MAX_COLUMNS = 80;
const MAX_CELL_CHARS = 3000;
const MAX_SHEETS = 50;

export type DocxAsset = { contentType: string; bytes: Buffer };
export type DocxConversion = { html: string; truncated: boolean; assets: DocxAsset[]; warnings: string[] };

const SUPPORTED_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const UNSUPPORTED_IMAGE_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='360' height='56'><rect width='100%' height='100%' rx='8' fill='#f4efe7'/><text x='16' y='34' font-size='14' fill='#62452e' font-family='sans-serif'>此图片格式不支持在线预览，请下载原文件查看</text></svg>",
)}`;

/**
 * Word styles written by common exporters (Typora/Pandoc/WPS). Without these, code
 * blocks collapse into ordinary paragraphs full of <br> and lose their monospace look.
 */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p.subtitle:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='HTML Preformatted'] => pre:separator('\\n')",
  "p[style-name='Preformatted Text'] => pre:separator('\\n')",
  "p[style-name='Source Code'] => pre:separator('\\n')",
  "p[style-name='Code'] => pre:separator('\\n')",
  "p[style-name='Code Block'] => pre:separator('\\n')",
  "p[style-name='代码'] => pre:separator('\\n')",
  "r[style-name='HTML Code'] => code",
  "r[style-name='Source Code Char'] => code",
  "r[style-name='Verbatim Char'] => code",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
  "p[style-name='Normal (Web)'] => p:fresh",
  "p[style-name='Plain Text'] => p:fresh",
];

/** Cut at a block boundary so a truncated preview never ends inside a tag or attribute. */
function truncateAtBlock(html: string, limit: number) {
  if (html.length <= limit) return { html, truncated: false };
  const head = html.slice(0, limit);
  const block = head.match(/^[\s\S]*<\/(?:p|li|pre|h[1-6]|tr|blockquote)>/);
  const safe = block ? block[0] : head.slice(0, head.lastIndexOf(">") + 1);
  return { html: safe, truncated: true };
}

/**
 * Convert a DOCX to sanitized HTML. Images are NOT inlined as base64: a Word file with
 * 37 screenshots produced ~9 MB of HTML, which used to be cut off after the first few
 * images. They are returned separately and referenced by URL instead.
 */
export async function convertDocx(bytes: Buffer, imageUrl: (index: number) => string): Promise<DocxConversion> {
  const assets: DocxAsset[] = [];
  let counter = 0;
  let unsupportedImages = 0;
  let converted: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
  try {
    converted = await mammoth.convertToHtml({ buffer: bytes }, {
      styleMap: STYLE_MAP,
      convertImage: mammoth.images.imgElement(async (image) => {
        const contentType = (image.contentType || "").toLowerCase();
        if (!SUPPORTED_IMAGE.test(contentType)) {
          unsupportedImages += 1;
          return { src: UNSUPPORTED_IMAGE_SRC, alt: "不支持预览的图片" };
        }
        const index = counter++;
        assets[index] = { contentType: contentType === "image/jpg" ? "image/jpeg" : contentType, bytes: await image.read() };
        // `altText` exists at runtime but is missing from mammoth's type declarations.
        return { src: imageUrl(index), alt: (image as { altText?: string }).altText || "" };
      }),
    });
  } catch {
    throw new ApiError(422, "DOCX 文件无法解析，请确认文件未损坏后重新上传");
  }
  const clean = sanitizeHtml(converted.value, {
    allowedTags: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "u", "s", "sub", "sup", "br", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "img", "hr"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"], img: ["src", "alt", "title"],
      td: ["colspan", "rowspan"], th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    disallowedTagsMode: "discard",
    transformTags: {
      a: (_tag, attributes) => ({ tagName: "a", attribs: { ...attributes, rel: "noreferrer noopener", target: "_blank" } }),
    },
  });
  const { html, truncated } = truncateAtBlock(clean, MAX_HTML_CHARS);
  const warnings: string[] = [];
  if (unsupportedImages) warnings.push(`${unsupportedImages} 张图片格式（如 EMF/WMF）无法在浏览器显示，请下载原文件查看`);
  if (truncated) warnings.push("文档过长，仅显示前半部分，完整内容请下载原文件");
  return { html, truncated, assets, warnings };
}

export async function previewDocx(bytes: Buffer, contentType: string, imageUrl: (index: number) => string = (index) => `asset-${index}`): Promise<PreviewPayload> {
  const converted = await convertDocx(bytes, imageUrl);
  return { kind: "document", text: "", truncated: converted.truncated, content_type: contentType, document_html: converted.html, warnings: converted.warnings };
}

function clip(text: string) {
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

/** Display text as Excel shows it. Number formats like `0.0_ ` pad with spaces that Excel never renders. */
function formatCell(cell: XLSX.CellObject | undefined) {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  let text: string;
  if (cell.w !== undefined) text = cell.w;
  else if (cell.v instanceof Date) text = cell.v.toISOString().slice(0, 19).replace("T", " ");
  else text = String(cell.v);
  if (cell.t === "n" || cell.t === "d") text = text.replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
  return clip(text);
}

const EMPTY_TABLE: SpreadsheetTable = { rows: [], row_numbers: [], columns: [], merges: [], total_rows: 0, total_columns: 0, truncated: false };

function tableForSheet(sheet: XLSX.WorkSheet): SpreadsheetTable {
  const ref = sheet["!ref"];
  if (!ref) return EMPTY_TABLE;
  const range = XLSX.utils.decode_range(ref);
  const hiddenRows = new Set<number>();
  (sheet["!rows"] || []).forEach((row, index) => { if (row?.hidden) hiddenRows.add(index); });
  const hiddenCols = new Set<number>();
  (sheet["!cols"] || []).forEach((col, index) => { if (col?.hidden) hiddenCols.add(index); });

  const rowIndexes: number[] = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) if (!hiddenRows.has(r)) rowIndexes.push(r);
  const colIndexes: number[] = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) if (!hiddenCols.has(c)) colIndexes.push(c);

  const shownRows = rowIndexes.slice(0, MAX_ROWS);
  const shownCols = colIndexes.slice(0, MAX_COLUMNS);
  const rows = shownRows.map((r) => shownCols.map((c) => formatCell(sheet[XLSX.utils.encode_cell({ r, c })])));

  const rowPosition = new Map(shownRows.map((r, index) => [r, index]));
  const colPosition = new Map(shownCols.map((c, index) => [c, index]));
  const merges: SheetMerge[] = [];
  for (const merge of sheet["!merges"] || []) {
    const row = rowPosition.get(merge.s.r);
    const col = colPosition.get(merge.s.c);
    if (row === undefined || col === undefined) continue;
    const rowSpan = shownRows.filter((r) => r >= merge.s.r && r <= merge.e.r).length;
    const colSpan = shownCols.filter((c) => c >= merge.s.c && c <= merge.e.c).length;
    if (rowSpan > 1 || colSpan > 1) merges.push({ row, col, row_span: rowSpan, col_span: colSpan });
  }
  return {
    rows, row_numbers: shownRows.map((r) => r + 1), columns: shownCols.map((c) => XLSX.utils.encode_col(c)), merges,
    total_rows: rowIndexes.length, total_columns: colIndexes.length,
    truncated: rowIndexes.length > MAX_ROWS || colIndexes.length > MAX_COLUMNS,
  };
}

export function previewSpreadsheet(bytes: Buffer, contentType: string, requestedSheet?: string | null): PreviewPayload {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "buffer", cellFormula: false, cellHTML: false, cellText: true, cellDates: true, cellStyles: true });
  } catch {
    throw new ApiError(422, "Excel 文件无法解析，请确认文件未损坏或未设置密码");
  }
  // Excel does not show hidden / very-hidden worksheets, so neither do we.
  const visible = workbook.SheetNames.filter((_, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden);
  const available = visible.length ? visible : workbook.SheetNames;
  const sheetNames = available.slice(0, MAX_SHEETS);
  if (!sheetNames.length) throw new ApiError(422, "Excel 文件中没有可预览的工作表");
  const active = requestedSheet && sheetNames.includes(requestedSheet) ? requestedSheet : sheetNames[0];
  const sheet = workbook.Sheets[active];
  if (!sheet) throw new ApiError(422, "请求的工作表不存在");
  const table = tableForSheet(sheet);
  const warnings: string[] = [];
  if (available.length > MAX_SHEETS) warnings.push(`仅显示前 ${MAX_SHEETS} 个工作表`);
  if (table.truncated) warnings.push(`为保证浏览流畅，当前仅显示前 ${MAX_ROWS} 行和前 ${MAX_COLUMNS} 列，完整数据请下载原文件`);
  return { kind: "spreadsheet", text: "", truncated: table.truncated, content_type: contentType, sheet_names: sheetNames, active_sheet: active, table, warnings };
}
