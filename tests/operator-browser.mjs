import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const suffix = Date.now().toString().slice(-6);
const newName = `测试员${suffix}`;
const renamed = `改名员${suffix}`;
let fileId = null;
// The operator directory has no delete API by design, so snapshot the file and
// restore it afterwards. Only possible when the server shares this filesystem.
const operatorsFile = process.env.KB_OPERATORS_FILE || 'storage/operators.json';
const operatorsBefore = await readFile(operatorsFile, 'utf8').catch(() => null);
let operatorId = null;

try {
  const upload = await context.request.post('/api/v1/file/uploadFile', { multipart: {
    file: { name: '操作员验证.txt', mimeType: 'text/plain', buffer: Buffer.from('操作员修改验证') },
    collection_name: '回归验证', description: '操作员验证夹具',
  } });
  assert.equal(upload.status(), 201, await upload.text());
  const record = (await upload.json()).data;
  fileId = record.id;

  const response = await context.request.get('/api/operators');
  assert.equal(response.status(), 200);
  const before = (await response.json()).data;
  assert.ok(before.some((operator) => operator.id === 1) && before.some((operator) => operator.id === 2));

  await page.goto('/');
  const search = page.getByRole('textbox', { name: '搜索知识文件' });
  await search.fill('操作员验证.txt');
  await search.press('Enter');
  await page.getByRole('button', { name: '文件信息 操作员验证.txt', exact: true }).click();
  const dialog = page.locator('.file-info-dialog');
  await expect(dialog).toBeVisible();

  const select = dialog.getByLabel('本次操作人');
  await expect(select).toHaveValue('1');
  await dialog.getByRole('button', { name: '＋ 新增', exact: true }).click();
  await dialog.getByLabel('新操作人姓名').fill(newName);
  await dialog.getByRole('button', { name: '添加并选用', exact: true }).click();
  await expect(page.getByText('操作人已变更，请点击“保存修改”生效')).toBeVisible();
  operatorId = Number(await select.inputValue());
  assert.ok(operatorId > 2, `expected a fresh operator id, got ${operatorId}`);
  await expect(dialog.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();

  const saved = page.waitForResponse((res) => res.url().endsWith(`/api/v1/file/${fileId}`) && res.request().method() === 'PATCH');
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  const patch = await saved;
  assert.equal(patch.status(), 200, await patch.text());
  const updated = (await patch.json()).data;
  assert.equal(updated.updated_by, operatorId);
  assert.equal(updated.version_no, 2);
  console.log('PASS: new operator can be added in the dialog and saved as updated_by');

  // Rename the same person: the id stays, the displayed name changes everywhere.
  await dialog.getByRole('button', { name: '改名', exact: true }).click();
  await dialog.getByLabel('修改操作人姓名').fill(renamed);
  await dialog.getByRole('button', { name: '保存姓名', exact: true }).click();
  await expect(dialog.locator('.info-facts')).toContainText(renamed);
  await expect(dialog.locator('.info-facts')).toContainText('v2');
  await page.getByRole('button', { name: '关闭文件信息', exact: true }).click();
  console.log('PASS: operator rename keeps id and updates displayed name');

  // Survives a full page reload because the directory is stored server-side.
  await page.reload();
  await page.getByRole('textbox', { name: '搜索知识文件' }).fill('操作员验证.txt');
  await page.getByRole('textbox', { name: '搜索知识文件' }).press('Enter');
  await page.getByRole('button', { name: '文件信息 操作员验证.txt', exact: true }).click();
  await expect(page.locator('.file-info-dialog .info-facts')).toContainText(renamed);
  const persisted = (await (await context.request.get(`/api/v1/file/${fileId}`)).json()).data;
  assert.equal(persisted.updated_by, operatorId);
  console.log('PASS: operator directory and record survive reload');
} finally {
  if (fileId) {
    const response = await context.request.delete(`/api/v1/file/${fileId}`);
    assert.equal(response.status(), 200, `failed to clean ${fileId}`);
  }
  // Restore the operator directory to its pre-test state.
  if (operatorsBefore === null) await rm(operatorsFile, { force: true }).catch(() => undefined);
  else await writeFile(operatorsFile, operatorsBefore, 'utf8').catch(() => undefined);
  await browser.close();
}
