import assert from "node:assert/strict";
import test from "node:test";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { matchesSearch, originalFileName, searchTokens } from "../src/lib/file-search";
import { mysqlFileWhere } from "../src/lib/mysql-search";
import { deriveContentType, matchRow, normalizeQuery, normalizeUpload, type Row } from "../src/lib/records";
import { parseObjectKey } from "../src/lib/object-storage";
import { imageContentType, parseByteRange, validateImage } from "../src/lib/file-content";

const fixture: Row = {
  id: "test", fileName: "季度报告_9a1b2c3d.pdf", collectionName: "项目资料", fileType: "pdf",
  minioPath: "knowledge-base/季度报告_9a1b2c3d.pdf", chunkStrategy: "adaptive",
  description: "Q3 财务说明", status: "uploaded", versionNo: 1,
  createdTime: "2026-01-01T00:00:00Z", updatedTime: null, createdBy: 1, updatedBy: null,
};

test("search restores backend random suffix for full filenames", () => {
  assert.equal(originalFileName("季度报告_9a1b2c3d.pdf"), "季度报告.pdf");
  assert.equal(originalFileName("v1.2.release_ABCDEF12.PDF"), "v1.2.release.PDF");
  assert.ok(matchRow(fixture, normalizeQuery({ q: "季度报告.pdf" })));
  assert.ok(matchRow(fixture, normalizeQuery({ q: "季度报告_9a1b2c3d.pdf" })));
  assert.ok(matchRow(fixture, normalizeQuery({ q: "季度 Q3" })));
  assert.ok(matchRow(fixture, normalizeQuery({ q: "财务", collectionName: "项目资料" })));
  assert.ok(!matchRow(fixture, normalizeQuery({ q: "不存在的文件" })));
  assert.ok(!matchRow(fixture, normalizeQuery({ q: "季度", status: "active" })));
});

test("search is literal and case-insensitive and normalizes input", () => {
  assert.deepEqual(searchTokens("  ＰＤＦ  财务  "), ["pdf", "财务"]);
  assert.ok(matchesSearch("q3", ["Q3 财务说明"]));
  assert.ok(matchesSearch("50%_", ["进度 50%_已核对"]));
  assert.ok(!matchesSearch("%", ["any content"]));
  assert.ok(!matchesSearch("_", ["any content"]));
});

test("MySQL search binds input and searches both stored and displayed names", () => {
  const statement = mysqlFileWhere({ q: "季度报告.pdf", collectionName: "项目资料" });
  const query = new MySqlDialect().sqlToQuery(statement);
  assert.match(query.sql, /LOCATE/);
  assert.match(query.sql, /CASE/);
  assert.match(query.sql, /CHAR_LENGTH/);
  assert.ok(query.params.includes("季度报告.pdf"));
  assert.ok(query.params.includes("项目资料"));
  assert.ok(!query.sql.includes("季度报告.pdf"));
  const malicious = new MySqlDialect().sqlToQuery(mysqlFileWhere({ q: "x';DROP TABLE knowledge_files;--" }));
  assert.ok(!malicious.sql.includes("DROP"));
  const literal = new MySqlDialect().sqlToQuery(mysqlFileWhere({ q: "50%_" }));
  assert.ok(literal.params.includes("50%_"));
});

test("object URL bucket and nested Unicode key take priority over fallback name", () => {
  assert.deepEqual(parseObjectKey("http://127.0.0.1:9100/another-bucket/folder/%E6%9E%B6%E6%9E%84%E5%9B%BE.png?X-Amz-Expires=1", "wrong.png"), {
    bucket: "another-bucket", objectName: "folder/架构图.png",
  });
  assert.deepEqual(parseObjectKey("knowledge-base/folder/方案+图 1.png", "old.png"), { bucket: "knowledge-base", objectName: "folder/方案+图 1.png" });
  assert.deepEqual(parseObjectKey("https://minio.example/knowledge-base/50%2525.png", null), { bucket: "knowledge-base", objectName: "50%25.png" });
  assert.throws(() => parseObjectKey("knowledge-base/../.env", null));
  assert.throws(() => parseObjectKey("", "../../.env"));
});

test("image types have correct MIME types and invalid content is rejected", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(deriveContentType(".PNG", "diagram.PNG"), "image/png");
  assert.equal(deriveContentType("", "diagram.jpeg"), "image/jpeg");
  assert.equal(imageContentType(png), "image/png");
  assert.doesNotThrow(() => validateImage(png, "png"));
  assert.throws(() => validateImage(Buffer.from("<html>bad</html>"), "png"));
  assert.throws(() => validateImage(png, "jpg"));
  assert.throws(() => normalizeUpload({ originalName: "bad.svg", bytes: Buffer.from("<svg/>"), storedName: "bad.svg", collectionName: "知识" }, 50000));
});

test("PDF byte ranges include suffix, open-ended and invalid ranges", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-50", 1000), { start: 950, end: 999 });
  assert.deepEqual(parseByteRange("bytes=900-3000", 1000), { start: 900, end: 999 });
  assert.equal(parseByteRange("bytes=3000-", 1000), "invalid");
  assert.equal(parseByteRange("bytes=500-20", 1000), "invalid");
  assert.equal(parseByteRange("bytes=0-1,2-3", 1000), "invalid");
  assert.equal(parseByteRange("bytes=-0", 1000), "invalid");
  assert.equal(parseByteRange(null, 1000), null);
});
