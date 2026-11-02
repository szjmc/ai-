import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, expect as baseExpect } from '@playwright/test';

/**
 * Verifies the NRS2002 assistant UI against a stand-in FastAPI.
 * The stub mirrors chatbot_query_router.py's contract, including the branch where
 * parse errors surface as a bare 500.
 */
const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

let mode = 'ok';
const received = [];
const stub = createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"message":"Hello World"}'); return; }
  if (req.url === '/api/v1/config/systemConfig' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 200,
      message: '获取后端配置成功',
      data: {
        asr: {
          configured: true,
          model: 'Qwen/Qwen3-ASR-1.7B',
          base_url: 'https://api.siliconflow.cn/v1/audio/transcriptions',
          endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
          has_api_key: true,
          source: 'fastapi_backend',
        },
        milvus: {
          host: '127.0.0.1',
          port: '19530',
          default_collection: 'rag_knowledge',
        },
        ollama: {
          base_url: 'http://127.0.0.1:11434',
          llm_model: 'qwen3:0.6b',
          embedding_model: 'bge-m3:latest',
        },
        strategy: {
          llm_strategy: 'ollama',
          embedding_strategy: 'ollama',
        },
      },
    }));
    return;
  }
  if (req.url === '/api/v1/asr/transcribe' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 200,
      message: '语音转文字成功',
      data: {
        text: '患者女性六十五岁 BMI 十九点二',
        model: 'Qwen/Qwen3-ASR-1.7B',
      },
    }));
    return;
  }
  if (req.url === '/api/v1/chat/systemRagQuery' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push(JSON.parse(raw));
      if (mode === 'fail') { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal Server Error'); return; }
      const payload = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 200,
        message: 'NRS2002评分查询成功',
        data: {
          score_info: {
            score: 2, nutritional_impairment: 1, disease_severity: 1, age: 0,
            basis: '1.营养受损：BMI19.2（18.5-20.4）→1分；2.疾病严重度：糖尿病稳定期→1分；3.年龄65岁＜70→0分；总分1+1+0=2分',
          },
          source_basis: [
            { file_name: 'NRS2002规则_1a2b3c4d.md', file_id: payload.file_id, rule_fragment: 'BMI 18.5-20.4 → 营养状态受损 1 分', retrieval_type: 'vector' },
            { file_name: 'NRS2002规则_1a2b3c4d.md', file_id: payload.file_id, rule_fragment: '年龄 ≥70 岁计 1 分', retrieval_type: 'vector' },
          ],
          query_params: { file_id: payload.file_id, collection_name: payload.collection_name, top_k: 2, query_time: '2026-10-27 21:40:00' },
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
let fileId = null;

try {
  const upload = await context.request.post('/api/v1/file/uploadFile', {
    multipart: {
      file: { name: 'NRS2002规则.md', mimeType: 'text/markdown', buffer: Buffer.from('# NRS2002\n\nBMI<18.5 → 2 分') },
      collection_name: '问答验证集合',
    },
  });
  assert.equal(upload.status(), 201, await upload.text());
  fileId = (await upload.json()).data.id;

  await startStub();

  // ---- 1. 打开问答窗口 ----
  await page.goto('/');
  await page.getByRole('button', { name: 'AI 问答', exact: true }).click();
  const dialog = page.locator('.assistant-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.assistant-pill.on')).toBeVisible();
  await expect(dialog.getByText('查询服务在线')).toBeVisible();
  await expect(dialog.getByLabel('关联知识文件')).toHaveValue(fileId);
  console.log('PASS: assistant opens, service reported online, file preselected');

  // ---- 2. 自然语言调用 ----
  const question = '患者女性，65岁，BMI 19.2，2型糖尿病稳定期，近3个月体重下降4.6%，无进食困难';
  await dialog.getByLabel('患者信息（自然语言）').fill(question);
  await dialog.getByLabel(/Milvus 集合名/).fill('yycp');
  await dialog.getByRole('button', { name: '提交查询', exact: true }).click();

  await expect(dialog.locator('.assistant-result')).toBeVisible();
  await expect(dialog.locator('.assistant-score strong')).toHaveText('2');
  await expect(dialog.locator('.assistant-basis')).toContainText('总分1+1+0=2分');
  await expect(dialog.locator('.assistant-sources li')).toHaveCount(2);
  await expect(dialog.getByText('NRS2002 总分')).toBeVisible();

  assert.deepEqual(received.at(-1), { question, file_id: fileId, collection_name: 'yycp', top_k: 2 },
    '前端必须原样转发请求体');
  console.log('PASS: natural-language query forwards unchanged and renders the score');

  // ---- 3. 语音播报按钮可用（调用浏览器 TTS）----
  const speak = dialog.getByRole('button', { name: /语音播报|停止播报/ });
  await expect(speak).toBeVisible();
  await speak.click();                       // 无声卡环境下可能立即结束，不强制按钮状态
  await page.waitForTimeout(300);
  const stop = dialog.getByRole('button', { name: '■ 停止播报' });
  if (await stop.count()) await stop.click();
  console.log('PASS: result can be read aloud via speech synthesis');

  // ---- 4. 表单采集数据调用 ----
  await dialog.getByRole('tab', { name: '② 表单采集' }).click();
  await dialog.getByLabel('年龄', { exact: true }).fill('72');
  await dialog.getByLabel('BMI 数值', { exact: true }).fill('17.8');
  await dialog.getByLabel('近3月体重下降百分比', { exact: true }).fill('12');
  await dialog.getByLabel('近1周进食减少百分比', { exact: true }).fill('60');
  await dialog.getByLabel('疾病状态', { exact: true }).selectOption({ label: '大手术 / 中风 / ICU，需人工营养' });
  await dialog.getByLabel('补充说明', { exact: true }).fill('需鼻饲营养');

  const composed = await dialog.locator('.assistant-composed p').innerText();
  assert.match(composed, /72岁/);
  assert.match(composed, /BMI 17\.8/);
  assert.match(composed, /近3个月体重下降 12%/);
  assert.match(composed, /ICU/);
  await dialog.getByRole('button', { name: '用表单数据查询', exact: true }).click();
  await expect(dialog.locator('.assistant-result')).toBeVisible();
  assert.equal(received.at(-1).question, composed, '表单应被组装成一句自然语言再发送');
  assert.equal(received.at(-1).collection_name, 'yycp');
  console.log('PASS: form fields compose a question and query the backend');

  // ---- 5. 语音输入：tab 可用，按真实配置状态呈现 ----
  await page.route('**/api/v1/chat/status', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        status: 200, message: 'success', page: null,
        data: {
          chat: { reachable: true, base_url: 'http://127.0.0.1:8018', endpoint: 'http://127.0.0.1:8018/api/v1/chat/systemRagQuery' },
          asr: { configured: false, model: '（未配置 ASR_MODEL）', endpoint: '（未配置 ASR_BASE_URL）', has_api_key: false, source: 'none' },
          defaults: { collection_name: 'rag_knowledge' },
        },
      }),
    }));
  await page.reload();
  await page.getByRole('button', { name: 'AI 问答', exact: true }).click();
  await page.locator('.assistant-dialog').getByRole('tab', { name: '③ 语音输入' }).click();
  const voiceDialog = page.locator('.assistant-dialog');
  await expect(voiceDialog.getByText('语音识别未配置')).toBeVisible();
  await expect(voiceDialog.getByText(/ASR_BASE_URL/)).toBeVisible();
  await expect(voiceDialog.getByRole('button', { name: /开始录音/ })).toBeDisabled();
  console.log('PASS: voice tab explains ASR configuration and blocks recording when unset');

  // 已配置时：不再提示，录音按钮可用，并显示来源
  await page.unroute('**/api/v1/chat/status');
  await page.route('**/api/v1/chat/status', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        status: 200, message: 'success', page: null,
        data: {
          chat: { reachable: true, base_url: 'http://127.0.0.1:8018', endpoint: 'http://127.0.0.1:8018/api/v1/chat/systemRagQuery' },
          asr: { configured: true, model: 'Qwen/Qwen3-ASR-1.7B', endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions', has_api_key: true, source: 'backend/.env' },
          defaults: { collection_name: 'rag_knowledge' },
        },
      }),
    }));
  // 清掉上一次填过的集合名，验证默认值来自后端 MILVUS_DEFAULT_COLLECTION
  await page.evaluate(() => window.localStorage.removeItem('kb_milvus_collection'));
  await page.reload();
  await page.getByRole('button', { name: 'AI 问答', exact: true }).click();
  const dialog2 = page.locator('.assistant-dialog');
  await expect(dialog2.getByLabel(/Milvus 集合名/)).toHaveValue('rag_knowledge');
  await dialog2.getByRole('tab', { name: '③ 语音输入' }).click();
  await expect(dialog2.getByText('语音识别未配置')).toHaveCount(0);
  await expect(dialog2.getByRole('button', { name: /开始录音/ })).toBeEnabled();
  await expect(dialog2.locator('.assistant-asr-meta')).toContainText('Qwen/Qwen3-ASR-1.7B');
  await expect(dialog2.locator('.assistant-asr-meta')).toContainText(/后端/);
  console.log('PASS: configured ASR enables recording and shows model/source');
  await page.unroute('**/api/v1/chat/status');

  // ---- 6. 后端 500 给出可执行提示 ----
  mode = 'fail';
  await dialog2.getByRole('tab', { name: '① 自然语言' }).click();
  await dialog2.getByLabel('患者信息（自然语言）').fill('72岁男性，BMI 17.8，脑中风需鼻饲');
  await dialog2.getByRole('button', { name: '提交查询', exact: true }).click();
  const alert = dialog2.locator('.inline-error');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Milvus 无数据');
  await expect(alert).toContainText('日志');
  console.log('PASS: upstream 500 is surfaced as a backend-side problem');

  await dialog2.getByRole('button', { name: '关闭问答窗口' }).click();
  await expect(dialog2).toBeHidden();
  await page.unroute('**/api/v1/chat/status');

  // ---- 7. 服务离线时状态可见 ----
  mode = 'ok';
  await new Promise((resolve) => stub.close(resolve));
  await page.getByRole('button', { name: 'AI 问答', exact: true }).click();
  await expect(page.locator('.assistant-dialog .assistant-pill.off')).toBeVisible();
  await expect(page.getByText(/python main\.py/)).toBeVisible();
  console.log('PASS: offline query service is reported with a start hint');

  assert.deepEqual(pageErrors, [], '页面不应有未捕获错误');
} finally {
  if (fileId) await context.request.delete(`/api/v1/file/${fileId}`).catch(() => undefined);
  await browser.close();
  await new Promise((resolve) => stub.close(resolve)).catch(() => undefined);
}
