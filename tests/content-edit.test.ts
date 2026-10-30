import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * These tests write real objects and ledger rows. KB_STORAGE_ROOT points them at a
 * throwaway directory so they never touch the user's own file list.
 * Storage paths are resolved lazily, so setting this before the first call is enough.
 */
const sandbox = mkdtempSync(path.join(tmpdir(), "kb-content-"));
process.env.KB_STORAGE_ROOT = sandbox;

import { saveUploadedFile, readKnowledgeObject, updateKnowledgeFileContent } from "../src/lib/knowledge";

after(async () => {
  delete process.env.KB_STORAGE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

test("text file content can be edited and saved as a new version", async () => {
  const initial = await saveUploadedFile({
    originalName: "修改测试.md",
    bytes: Buffer.from("# 初始正文\n\n这是第一版内容。"),
    collectionName: "测试集合",
    storedName: "修改测试_init01.md",
    createdBy: 1,
  });

  assert.equal(initial.version_no, 1);
  assert.equal(initial.file_type, "md");

  const updated = await updateKnowledgeFileContent(initial.id, {
    bytes: Buffer.from("# 修改后的正文\n\n这是第二版内容，已在线修改！"),
    updatedBy: 2,
  });

  assert.equal(updated.id, initial.id);
  assert.equal(updated.version_no, 2);
  assert.equal(updated.updated_by, 2);

  // Read the object back: the bytes on disk must be the new text, not just the API echo.
  const { bytes } = await readKnowledgeObject(initial.id);
  const text = bytes.toString("utf8");
  assert.match(text, /修改后的正文/);
  assert.match(text, /已在线修改/);
  assert.doesNotMatch(text, /第一版内容/);
});

test("file content can be replaced with an entirely new file", async () => {
  const initial = await saveUploadedFile({
    originalName: "原文件.txt",
    bytes: Buffer.from("原内容"),
    collectionName: "测试集合",
    storedName: "原文件_old01.txt",
    createdBy: 1,
  });

  const replacementBytes = Buffer.from("这是替换后的完整文件内容，大小增加了。");
  const updated = await updateKnowledgeFileContent(initial.id, {
    bytes: replacementBytes,
    originalName: "更新版文件.txt",
    updatedBy: 1,
  });

  assert.equal(updated.id, initial.id);
  assert.equal(updated.version_no, 2);
  assert.equal(updated.original_name, "更新版文件.txt");
  assert.equal(updated.file_size, replacementBytes.length);

  const { bytes } = await readKnowledgeObject(initial.id);
  assert.equal(bytes.toString("utf8"), "这是替换后的完整文件内容，大小增加了。");
});
