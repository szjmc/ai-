import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { addOperator, listOperators, renameOperator } from "../src/lib/operators";

function tempFile() {
  process.env.KB_OPERATORS_FILE = path.join(mkdtempSync(path.join(tmpdir(), "kb-operators-")), "operators.json");
}

test("operator directory starts with the two default people", async () => {
  tempFile();
  const list = await listOperators();
  assert.deepEqual(list.map((operator) => [operator.id, operator.name]), [[1, "林知衡"], [2, "周简"]]);
});

test("adding an operator auto-assigns the next free id and persists", async () => {
  tempFile();
  const created = await addOperator({ name: "王小明" });
  assert.equal(created.id, 3);
  const list = await listOperators();
  assert.deepEqual(list.map((operator) => operator.name), ["林知衡", "周简", "王小明"]);
});

test("explicit ids are honoured, duplicates and bad input are rejected", async () => {
  tempFile();
  const created = await addOperator({ name: "李雷", id: 9 });
  assert.equal(created.id, 9);
  await assert.rejects(() => addOperator({ name: "韩梅梅", id: 9 }), /已被占用/);
  await assert.rejects(() => addOperator({ name: "李雷" }), /已存在/);
  await assert.rejects(() => addOperator({ name: "  " }), /1–20/);
  await assert.rejects(() => addOperator({ name: "超长姓名".repeat(6) }), /1–20/);
  await assert.rejects(() => addOperator({ name: "赵六", id: 0 }), /正整数/);
});

test("renaming keeps the id so existing records follow the new name", async () => {
  tempFile();
  await addOperator({ name: "王小明" });
  const renamed = await renameOperator(3, "王小红");
  assert.equal(renamed.id, 3);
  assert.equal(renamed.name, "王小红");
  const list = await listOperators();
  assert.equal(list.find((operator) => operator.id === 3)?.name, "王小红");
  await assert.rejects(() => renameOperator(3, "周简"), /已存在/);
  await assert.rejects(() => renameOperator(99, "不存在"), /不存在/);
});
