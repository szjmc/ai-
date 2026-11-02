import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import * as XLSX from 'xlsx';

const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const ids = [];
async function upload(name, mimeType, buffer, description) {
  const response = await context.request.post('/api/v1/file/uploadFile', { multipart: {
    file: { name, mimeType, buffer }, collection_name: 'Office 回归验证', description,
  } });
  assert.equal(response.status(), 201, await response.text());
  const result = await response.json();
  ids.push(result.data.id);
  return result.data;
}

try {
  const docx = Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ text: 'Office 文档预览', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('DOCX 内容应转换为安全的阅读视图。'),
    new Paragraph({ text: '第二节', heading: HeadingLevel.HEADING_2 }),
    new Paragraph('这里是第二段内容。'),
  ] }] })));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['名称', '数量'], ['文档 A', 12], ['文档 B', 24]]), '总览');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['月份', '收入'], ['一月', 1200], ['二月', 2800]]), '明细');
  const xlsx = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const docxRecord = await upload('Office 文档预览.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx, 'DOCX 在线预览');
  const xlsxRecord = await upload('数据总览.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx, 'XLSX 在线预览');

  let response = await context.request.get(`/api/v1/file/${docxRecord.id}/preview`);
  assert.equal(response.status(), 200);
  let preview = (await response.json()).data;
  assert.equal(preview.kind, 'document');
  assert.match(preview.document_html, /Office 文档预览/);
  response = await context.request.get(`/api/v1/file/${xlsxRecord.id}/preview?sheet=${encodeURIComponent('明细')}`);
  assert.equal(response.status(), 200);
  preview = (await response.json()).data;
  assert.equal(preview.kind, 'spreadsheet');
  assert.equal(preview.active_sheet, '明细');
  assert.deepEqual(preview.table.rows[1], ['一月', '1200']);
  console.log('PASS: server returns DOCX HTML and selected XLSX worksheet');

  await page.goto('/');
  const search = page.getByRole('textbox', { name: '搜索知识文件' });
  await search.fill(docxRecord.original_name);
  await search.press('Enter');
  await expect(page.getByRole('button', { name: `预览 ${docxRecord.original_name}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `预览 ${docxRecord.original_name}`, exact: true }).click();
  const docFrame = page.locator('.docx-viewer');
  await expect(docFrame).toBeVisible();
  assert.match(await docFrame.getAttribute('srcdoc'), /Office 文档预览/);
  let rect = await docFrame.boundingBox();
  assert.ok(rect.width > 1300 && rect.height > 700, JSON.stringify(rect));
  await page.keyboard.press('Escape');
  console.log('PASS: DOCX renders in independent large preview');

  await search.fill(xlsxRecord.original_name);
  await search.press('Enter');
  await page.getByRole('button', { name: `预览 ${xlsxRecord.original_name}`, exact: true }).click();
  await expect(page.locator('.spreadsheet-viewer')).toBeVisible();
  await expect(page.getByRole('tab', { name: '总览', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.sheet-grid')).toContainText('文档 A');
  await page.getByRole('tab', { name: '明细', exact: true }).click();
  await expect(page.getByRole('tab', { name: '明细', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.sheet-grid')).toContainText('一月');
  await expect(page.locator('.sheet-grid')).toContainText('1200');
  await page.screenshot({ path: 'artifacts/xlsx-preview.png' });
  await page.keyboard.press('Escape');
  console.log('PASS: XLSX renders and switches worksheets');

  await search.fill(docxRecord.original_name);
  await search.press('Enter');
  await page.getByRole('button', { name: `文件信息 ${docxRecord.original_name}`, exact: true }).click();
  const operator = page.getByLabel('本次操作人');
  await expect(operator).toHaveValue('1');
  await operator.selectOption('2');
  await expect(page.getByText('操作人已变更，请点击“保存修改”生效')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeEnabled();
  const saved = page.waitForResponse((res) => res.url().endsWith(`/api/v1/file/${docxRecord.id}`) && res.request().method() === 'PATCH');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  const patch = await saved;
  assert.equal(patch.status(), 200, await patch.text());
  const updated = (await patch.json()).data;
  assert.equal(updated.updated_by, 2);
  assert.equal(updated.version_no, 2);
  await expect(page.getByText('已保存，当前版本 v2')).toBeVisible();
  response = await context.request.get(`/api/v1/file/${docxRecord.id}`);
  const persisted = (await response.json()).data;
  assert.equal(persisted.updated_by, 2);
  assert.equal(persisted.version_no, 2);
  console.log('PASS: operator-only edit enables save and persists updated_by/version');
} finally {
  for (const id of ids) {
    const response = await context.request.delete(`/api/v1/file/${id}`);
    assert.equal(response.status(), 200, `failed to clean ${id}`);
  }
  await browser.close();
}
