import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, expect as baseExpect } from '@playwright/test';

/**
 * Verifies the chunking UI against a stand-in FastAPI service.
 * The stub mirrors the real contract of app/routers/chunk_router.py, including its
 * behaviour of answering 500 when parse_file swallows an exception.
 */
const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

let mode = 'ok';
const received = [];
const stub = createServer((req, res) => {
  if (req.url === '/' ) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"message":"Hello World"}'); return; }
  if (req.url === '/api/v1/chunks/parseFile' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      if (mode === 'fail') {                      // chunk_router 吞掉异常 → FastAPI 回 500
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      const payload = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 200, message: 'text splitter successfully',
        data: {
          file_id: payload.file_id, file_name: payload.file_name, minio_path: payload.minio_path,
          chunks_processed: 7, chunk_ids: [101, 102, 103, 104, 105, 106, 107],
          process_time: '2026-10-27T05:30:00.123456',
        },
        page: null,
      }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
const startStub = () => new Promise((resolve) => stub.listen(8018, '127.0.0.1', resolve));

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const createdIds = [];

try {
  const upload = await context.request.post('/api/v1/file/uploadFile', {
    multipart: {
      file: { name: '分片验证.md', mimeType: 'text/markdown', buffer: Buffer.from('# 分片验证\n\n用于验证分片链路的文档正文。') },
      collection_name: '分片验证集合', description: '分片链路夹具',
    },
  });
  assert.equal(upload.status(), 201, await upload.text());
  const record = (await upload.json()).data;
  createdIds.push(record.id);

  // 夹具上传完成后再启动模拟解析服务：否则它会抢答上传接口的转发探活。
  await startStub();

  // ---- 1. 代理只转发，不加工 ----
  const direct = await context.request.post('/api/v1/chunks/parseFile', {
    data: { file_id: record.id, minio_path: record.minio_path, file_name: record.file_name },
  });
  assert.equal(direct.status(), 200, await direct.text());
  const directBody = await direct.json();
  assert.equal(directBody.data.chunks_processed, 7);
  assert.deepEqual(received.at(-1), {
    file_id: record.id, minio_path: record.minio_path, file_name: record.file_name,
  }, 'Next.js 必须原样转发请求体');
  console.log('PASS: proxy forwards the payload to FastAPI unchanged');

  // ---- 2. 缺少必填字段由代理挡下 ----
  const bad = await context.request.post('/api/v1/chunks/parseFile', { data: { minio_path: 'x' } });
  assert.equal(bad.status(), 400);
  assert.match((await bad.json()).message, /file_id/);
  console.log('PASS: missing file_id is rejected with a clear message');

  // ---- 3. 界面完整链路 ----
  await page.goto('/');
  const search = page.getByRole('textbox', { name: '搜索知识文件' });
  await search.fill('分片验证.md');
  await search.press('Enter');
  const row = page.locator('.row', { hasText: '分片验证.md' });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: '分片解析 分片验证.md', exact: true }).click();
  const dialog = page.locator('.chunk-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.chunk-service-row.is-online')).toBeVisible();
  await expect(dialog.getByText('解析服务在线')).toBeVisible();

  // 请求预览应与真实发送内容一致
  await dialog.getByText('查看将要发送的请求').click();
  const shown = JSON.parse(await dialog.locator('.chunk-payload pre').first().innerText());
  assert.deepEqual(shown, { file_id: record.id, minio_path: record.minio_path, file_name: record.file_name });

  await dialog.getByRole('button', { name: '开始分片解析', exact: true }).click();
  await expect(dialog.locator('.chunk-result')).toBeVisible();
  await expect(dialog.locator('.chunk-count')).toHaveText('7');
  await expect(dialog.locator('.chunk-result')).toContainText(record.id);
  await expect(dialog.locator('.chunk-result')).toContainText('_chunk_0001');
  await expect(page.getByText('分片完成：生成 7 个分片')).toBeVisible();
  console.log('PASS: dialog runs the pipeline and renders the backend result');

  // ---- 4. 后端 500（chunk_router 吞异常）要给出可执行提示 ----
  mode = 'fail';
  await dialog.getByRole('button', { name: '重新解析', exact: true }).click();
  const alert = dialog.locator('.inline-error');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Ollama、Milvus 或 MinIO');
  await expect(alert).toContainText('日志');
  console.log('PASS: an upstream 500 is surfaced as a backend-side problem');

  await page.getByRole('button', { name: '关闭分片窗口' }).click();
  await expect(dialog).toBeHidden();

  // ---- 5. 服务离线时禁止提交 ----
  mode = 'ok';
  await new Promise((resolve) => stub.close(resolve));
  await row.getByRole('button', { name: '分片解析 分片验证.md', exact: true }).click();
  await expect(page.locator('.chunk-dialog .chunk-service-row.is-offline')).toBeVisible();
  await expect(page.getByText('解析服务未连接')).toBeVisible();
  await expect(page.getByText(/python main\.py/)).toBeVisible();
  await expect(page.getByRole('button', { name: '开始分片解析', exact: true })).toBeDisabled();
  console.log('PASS: offline service blocks submission and explains how to start it');

  assert.deepEqual(pageErrors, [], '页面不应有未捕获错误');
} finally {
  for (const id of createdIds) await context.request.delete(`/api/v1/file/${id}`).catch(() => undefined);
  await browser.close();
  await new Promise((resolve) => stub.close(resolve)).catch(() => undefined);
}
