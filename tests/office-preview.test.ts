import assert from "node:assert/strict";
import { deflateSync, crc32 } from "node:zlib";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from "docx";
import * as XLSX from "xlsx";
import { convertDocx, previewDocx, previewSpreadsheet } from "../src/lib/office-preview";
import { normalizeUpdate } from "../src/lib/records";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A valid, incompressible RGB PNG (~3 bytes per pixel) so it stays large like a real screenshot. */
function noisePng(size: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), randomBytes(size * 3)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

function workbookBytes(build: (wb: XLSX.WorkBook) => void) {
  const wb = XLSX.utils.book_new();
  build(wb);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }));
}

test("DOCX converts to safe HTML preview with headings and text", async () => {
  const document = new Document({ sections: [{ children: [
    new Paragraph({ text: "项目周报", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun("本周完成 MinIO 与 MySQL 集成。")] }),
    new Paragraph({ text: "安全阅读", heading: HeadingLevel.HEADING_2 }),
  ] }] });
  const preview = await previewDocx(Buffer.from(await Packer.toBuffer(document)), DOCX_TYPE);
  assert.equal(preview.kind, "document");
  assert.match(preview.document_html || "", /<h1>项目周报<\/h1>/);
  assert.match(preview.document_html || "", /MinIO 与 MySQL/);
  assert.doesNotMatch(preview.document_html || "", /<script/i);
});

test("DOCX with large images is never truncated: images are served by URL, not inlined", async () => {
  const images = [noisePng(700), noisePng(700), noisePng(700), noisePng(700)];
  const total = images.reduce((sum, image) => sum + image.length, 0);
  assert.ok(total > 4_000_000, "fixture must exceed the old 1.5 MB inline-HTML cap");
  const document = new Document({ sections: [{ children: [
    new Paragraph({ text: "开头标题", heading: HeadingLevel.HEADING_1 }),
    ...images.flatMap((data, index) => [
      new Paragraph({ children: [new ImageRun({ type: "png", data, transformation: { width: 120, height: 120 }, altText: { name: `图${index}`, description: `图${index}`, title: `图${index}` } })] }),
      new Paragraph(`第 ${index + 1} 张图之后的正文`),
    ]),
    new Paragraph({ text: "文档最后一节", heading: HeadingLevel.HEADING_2 }),
    new Paragraph("这是整份文档的最后一句话。"),
  ] }] });
  const bytes = Buffer.from(await Packer.toBuffer(document));
  const result = await convertDocx(bytes, (index) => `/asset/${index}`);
  assert.equal(result.truncated, false);
  assert.ok(result.html.length < 20_000, `HTML should stay small, got ${result.html.length}`);
  assert.equal((result.html.match(/src="data:/g) || []).length, 0);
  assert.deepEqual([0, 1, 2, 3].map((index) => result.html.includes(`src="/asset/${index}"`)), [true, true, true, true]);
  assert.equal(result.assets.length, 4);
  result.assets.forEach((asset, index) => {
    assert.equal(asset.contentType, "image/png");
    assert.ok(asset.bytes.equals(images[index]), `image ${index} bytes must match the original`);
  });
  assert.match(result.html, /开头标题/);
  assert.match(result.html, /第 4 张图之后的正文/);
  assert.match(result.html, /这是整份文档的最后一句话。<\/p>$/);
});

test("DOCX preformatted paragraphs become one <pre> block, not <br> soup", async () => {
  const document = new Document({
    styles: { paragraphStyles: [{ id: "HTMLPreformatted", name: "HTML Preformatted", basedOn: "Normal", run: { font: "Courier New" } }] },
    sections: [{ children: [
      new Paragraph("示例代码："),
      new Paragraph({ text: "def hello():", style: "HTMLPreformatted" }),
      new Paragraph({ text: "    return 'a < b'", style: "HTMLPreformatted" }),
      new Paragraph("代码结束。"),
    ] }],
  });
  const result = await convertDocx(Buffer.from(await Packer.toBuffer(document)), () => "");
  assert.match(result.html, /<pre>def hello\(\):\n\s+return 'a &lt; b'<\/pre>/);
  assert.match(result.html, /<p>代码结束。<\/p>/);
});

test("XLSX previews the requested sheet and formats cells", () => {
  const bytes = workbookBytes((wb) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["名称", "数量"], ["文档 A", 12], ["文档 B", 24]]), "总览");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["月份", "收入"], ["一月", 1200], ["二月", 2800]]), "明细");
  });
  const initial = previewSpreadsheet(bytes, XLSX_TYPE);
  assert.equal(initial.kind, "spreadsheet");
  assert.deepEqual(initial.sheet_names, ["总览", "明细"]);
  assert.equal(initial.active_sheet, "总览");
  assert.deepEqual(initial.table?.rows[0], ["名称", "数量"]);
  assert.deepEqual(initial.table?.columns, ["A", "B"]);
  assert.deepEqual(initial.table?.row_numbers, [1, 2, 3]);
  const detail = previewSpreadsheet(bytes, XLSX_TYPE, "明细");
  assert.equal(detail.active_sheet, "明细");
  assert.deepEqual(detail.table?.rows[1], ["一月", "1200"]);
});

test("XLSX keeps Excel's real row numbers and column letters when data starts at C3", () => {
  const bytes = workbookBytes((wb) => {
    const sheet: XLSX.WorkSheet = {
      C3: { t: "s", v: "项目" }, D3: { t: "s", v: "金额" },
      C4: { t: "s", v: "差旅" }, D4: { t: "n", v: 300 },
      "!ref": "C3:D4",
    };
    XLSX.utils.book_append_sheet(wb, sheet, "偏移");
  });
  const table = previewSpreadsheet(bytes, XLSX_TYPE).table!;
  assert.deepEqual(table.columns, ["C", "D"]);
  assert.deepEqual(table.row_numbers, [3, 4]);
  assert.deepEqual(table.rows, [["项目", "金额"], ["差旅", "300"]]);
});

test("XLSX reproduces merged cells, hides hidden rows/columns/sheets, and trims number-format padding", () => {
  const bytes = workbookBytes((wb) => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["季度汇总", "", ""],
      ["名称", "秘密列", "数值"],
      ["保留行", "x", 16.4609053497942],
      ["隐藏行", "y", 1],
      ["末行", "z", 2],
    ]);
    sheet["!merges"] = [XLSX.utils.decode_range("A1:C1")];
    sheet["!cols"] = [{}, { hidden: true }, {}];
    sheet["!rows"] = [];
    sheet["!rows"][3] = { hidden: true };
    (sheet.C3 as XLSX.CellObject).z = "0.0_ ";
    XLSX.utils.book_append_sheet(wb, sheet, "可见");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["不应显示"]]), "隐藏表");
    wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  });
  const preview = previewSpreadsheet(bytes, XLSX_TYPE);
  assert.deepEqual(preview.sheet_names, ["可见"], "hidden sheet must not be listed");
  const table = preview.table!;
  assert.deepEqual(table.columns, ["A", "C"], "hidden column B is skipped");
  assert.deepEqual(table.row_numbers, [1, 2, 3, 5], "hidden row 4 is skipped but numbering stays real");
  assert.deepEqual(table.rows[2], ["保留行", "16.5"], "padding from `0.0_ ` is trimmed");
  assert.deepEqual(table.merges, [{ row: 0, col: 0, row_span: 1, col_span: 2 }], "merge A1:C1 is clipped to the visible columns");
});

test("XLSX preview enforces display limits without failing", () => {
  const rows = Array.from({ length: 1004 }, (_, row) => Array.from({ length: 83 }, (_, column) => `${row}-${column}`));
  const bytes = workbookBytes((wb) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "大表"));
  const result = previewSpreadsheet(bytes, XLSX_TYPE);
  assert.equal(result.table?.rows.length, 1000);
  assert.equal(result.table?.rows[0].length, 80);
  assert.equal(result.table?.truncated, true);
  assert.equal(result.table?.total_rows, 1004);
  assert.ok(result.warnings?.some((warning) => warning.includes("1000 行")));
});

test("operator update is accepted as an independent metadata change", () => {
  const patch = normalizeUpdate({ updatedBy: 2 });
  assert.equal(patch.updatedBy, 2);
  assert.throws(() => normalizeUpdate({ updatedBy: 0 }));
  assert.throws(() => normalizeUpdate({ updatedBy: 2.4 }));
});
