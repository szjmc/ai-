import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import sharp from 'sharp';

const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const createdIds = [];
await mkdir('artifacts', { recursive: true });

function pdfBuffer() {
  const content = '0.75 0.28 0.21 RG 4 w 60 60 1480 780 re S\nBT /F1 42 Tf 100 760 Td (Wide document preview regression test) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1600 900] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) result += `${String(offset).padStart(10, '0')} 00000 n \n`;
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}

try {
  const health = await context.request.get('/api/health');
  assert.equal(health.status(), 200);
  // The suite owns its data: no sample records exist, so upload a fixture and remove it at the end.
  const fixture = await context.request.post('/api/v1/file/uploadFile', { multipart: {
    file: { name: '术语表.json', mimeType: 'application/json', buffer: Buffer.from('{"测试":"夹具"}') },
    collection_name: '回归验证', description: '浏览器回归夹具',
  } });
  assert.equal(fixture.status(), 201, await fixture.text());
  createdIds.push((await fixture.json()).data.id);
  await page.goto('/');
  await expect(page.locator('.row').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.getByText('后端源码', { exact: true }).count(), 0);
  assert.equal(await page.locator('img[src*="/images/"]').count(), 0);
  assert.equal(await page.locator('.brand-mark').count(), 1);
  for (const path of ['/backend', '/api/backend/file?path=main.py', '/api/backend/file?path=.env']) {
    const response = await context.request.get(path);
    assert.equal(response.status(), 404, path);
    assert.ok(!(await response.text()).includes('MINIO_SECRET_KEY'));
  }
  console.log('PASS: source browser and source download are disabled; branding is embedded');

  const search = page.getByRole('textbox', { name: '搜索知识文件' });
  await search.fill('术语表.json');
  await search.press('Enter');
  await expect(page.locator('.row')).toHaveCount(1);
  await expect(page.locator('.file-name-button')).toHaveText('术语表.json');
  await expect(page.getByText('「术语表.json」· 找到 1 份文件')).toBeVisible();
  await search.fill('___不存在的关键词___');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('没有找到匹配的文件')).toBeVisible();
  await page.getByRole('button', { name: '清空全部筛选', exact: true }).first().click();
  await expect(page.locator('.row').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/console-desktop.png', fullPage: true });
  console.log('PASS: search submit, full filename, empty result and reset');

  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1100"><rect width="1800" height="1100" fill="#fff9ef"/><g fill="none" stroke="#c44536" stroke-width="6"><rect x="100" y="80" width="1600" height="900" rx="24"/><path d="M300 500h1200M600 300v400M1200 300v400"/><rect x="220" y="440" width="160" height="120" fill="#eed6b2"/><rect x="520" y="240" width="160" height="120" fill="#eed6b2"/><rect x="1120" y="640" width="160" height="120" fill="#eed6b2"/></g><text x="150" y="180" fill="#57351c" font-size="44">Knowledge architecture - image preview test</text></svg>')).png().toBuffer();
  const imageName = '架构图--回归验证.png';
  await page.getByRole('button', { name: /上传文件/ }).first().click();
  await page.getByLabel('选择上传文件').setInputFiles({ name: imageName, mimeType: 'image/png', buffer: png });
  await page.getByLabel(/所属集合/).fill('界面回归验证');
  await page.getByLabel('文件描述', { exact: true }).fill('图像搜索 回归验证');
  const uploadResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/file/uploadFile') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '上传并保存', exact: true }).click();
  const uploadedResponse = await uploadResponse;
  assert.equal(uploadedResponse.status(), 201, await uploadedResponse.text());
  const image = (await uploadedResponse.json()).data;
  createdIds.push(image.id);
  await expect(page.getByRole('heading', { name: '上传完成', exact: true })).toBeVisible();
  await expect(page.getByText('接口回执', { exact: true })).toHaveCount(0);
  const metadata = await context.request.get(`/api/v1/file/${image.id}/preview`);
  assert.equal((await metadata.json()).data.kind, 'image');
  const imageDownload = await context.request.get(`/api/v1/file/${image.id}/download?disposition=inline`);
  assert.equal(imageDownload.status(), 200);
  assert.match(imageDownload.headers()['content-type'], /image\/png/);
  assert.ok((await imageDownload.body()).equals(png));
  await page.getByRole('button', { name: '预览文件', exact: true }).click();
  const previewImage = page.locator('.preview-image');
  await expect(previewImage).toBeVisible();
  assert.equal(await previewImage.evaluate((img) => img.naturalWidth), 1800);
  let rect = await page.locator('.file-preview-dialog').boundingBox();
  assert.ok(rect.width >= 1350 && rect.height >= 920, JSON.stringify(rect));
  await page.getByRole('button', { name: '原始大小', exact: true }).click();
  await expect(page.getByLabel('图片缩放比例')).toHaveText('100%');
  await page.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(page.getByLabel('图片缩放比例')).toHaveText('125%');
  await page.getByRole('button', { name: '旋转 90°', exact: true }).click();
  assert.match(await previewImage.getAttribute('style'), /rotate\(90deg\)/);
  await page.getByRole('button', { name: '全屏预览', exact: true }).click();
  rect = await page.locator('.file-preview-dialog').boundingBox();
  assert.ok(rect.width >= 1439 && rect.height >= 999);
  await page.getByRole('button', { name: '还原预览窗口', exact: true }).click();
  await page.getByRole('button', { name: '旋转 90°', exact: true }).click();
  await page.screenshot({ path: 'artifacts/image-preview.png' });
  console.log('PASS: image upload, exact byte download, large preview, zoom, rotate and maximize');

  await page.getByRole('button', { name: '文件信息', exact: true }).click();
  await expect(page.locator('.file-info-dialog')).toBeVisible();
  assert.equal(await page.locator('.file-info-dialog iframe, .file-info-dialog .preview-image').count(), 0);
  await page.getByLabel('文件描述', { exact: true }).fill('更新后的可搜索描述');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByText('已保存，当前版本 v2')).toBeVisible();
  await page.getByRole('button', { name: '关闭文件信息', exact: true }).click();
  await search.fill('更新后的可搜索描述');
  await search.press('Enter');
  await expect(page.locator('.row')).toHaveCount(1);
  await expect(page.locator('.file-name-button')).toHaveText(imageName);
  console.log('PASS: metadata-only panel, edit persistence, searchable updated description');

  // A missing object must not prevent the metadata panel from opening.
  const previewPath = `**/api/v1/file/${image.id}/preview`;
  await page.route(previewPath, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ status: 404, message: '测试：对象暂时不存在', data: null }) }));
  await page.getByRole('button', { name: `文件信息 ${imageName}`, exact: true }).click();
  await expect(page.locator('.info-file-heading')).toContainText(imageName);
  await page.getByRole('button', { name: '打开预览 ↗', exact: true }).click();
  await expect(page.getByText('暂时无法预览', { exact: true })).toBeVisible();
  await page.unroute(previewPath);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.locator('.preview-image')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.file-preview-dialog')).toHaveCount(0);
  console.log('PASS: preview failure is isolated, retry works, Escape closes');

  const pdfName = '宽幅文件--回归验证.pdf';
  const pdf = pdfBuffer();
  const pdfResponse = await context.request.post('/api/v1/file/uploadFile', { multipart: {
    file: { name: pdfName, mimeType: 'application/pdf', buffer: pdf }, collection_name: '界面回归验证', description: 'PDF 预览测试',
  } });
  assert.equal(pdfResponse.status(), 201, await pdfResponse.text());
  const pdfRecord = (await pdfResponse.json()).data;
  createdIds.push(pdfRecord.id);
  const range = await context.request.get(`/api/v1/file/${pdfRecord.id}/download?disposition=inline`, { headers: { Range: 'bytes=0-63' } });
  assert.equal(range.status(), 206);
  assert.equal((await range.body()).length, 64);
  assert.match(range.headers()['content-range'], /^bytes 0-63\//);
  await search.fill(pdfName);
  await search.press('Enter');
  await expect(page.locator('.file-name-button')).toHaveText(pdfName);
  await page.getByRole('button', { name: `预览 ${pdfName}`, exact: true }).click();
  await expect(page.locator('.pdf-viewer')).toBeVisible();
  rect = await page.locator('.pdf-viewer').boundingBox();
  assert.ok(rect.width > 1300 && rect.height > 750, JSON.stringify(rect));
  await page.screenshot({ path: 'artifacts/pdf-preview.png' });
  await page.keyboard.press('Escape');
  console.log('PASS: wide PDF preview dimensions and byte-range response');

  const badImage = await context.request.post('/api/v1/file/uploadFile', { multipart: {
    file: { name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('<html>not a picture</html>') }, collection_name: '界面回归验证',
  } });
  assert.equal(badImage.status(), 415);
  console.log('PASS: spoofed image rejected before storing');

  const independent = await context.newPage();
  await independent.route('**/api/v1/file/stats', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 503, message: 'stats unavailable', data: null }) }));
  await independent.goto('/');
  await independent.getByRole('textbox', { name: '搜索知识文件' }).fill(imageName);
  await independent.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(independent.locator('.row')).toHaveCount(1);
  await expect(independent.locator('.file-name-button')).toHaveText(imageName);
  await independent.close();
  console.log('PASS: searching works even if statistics fail');

  await page.getByRole('button', { name: '清空全部筛选', exact: true }).first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.row').first()).toBeVisible();
  const overflows = await page.evaluate(() => ({ full: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  assert.ok(overflows.full <= overflows.viewport + 1, JSON.stringify(overflows));
  await page.screenshot({ path: 'artifacts/console-mobile.png', fullPage: true });
  await search.fill(imageName);
  await search.press('Enter');
  await page.getByRole('button', { name: `预览 ${imageName}`, exact: true }).click();
  await expect(page.locator('.preview-image')).toBeVisible();
  await page.screenshot({ path: 'artifacts/preview-mobile.png' });
  await page.keyboard.press('Escape');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: mobile layout, mobile image preview, no uncaught page errors');
} catch (error) {
  await page.screenshot({ path: 'artifacts/browser-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  for (const id of createdIds) {
    const response = await context.request.delete(`/api/v1/file/${id}`);
    assert.equal(response.status(), 200, `Cleanup failed for ${id}`);
  }
  await browser.close();
}
