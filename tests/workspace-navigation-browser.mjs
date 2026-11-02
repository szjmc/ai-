import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto(process.env.TEST_BASE_URL || 'http://localhost:3000');
  for (const [name, selector] of [['AI 问答', '.assistant-dialog'], ['Text2SQL 问数', '.t2s-dialog'], ['数据分析助手', '.ana-shell']]) {
    const nav = page.getByRole('button', { name, exact: true });
    await nav.click();
    const panel = page.locator(`main ${selector}`);
    await expect(panel).toBeVisible();
    await expect(nav).toHaveAttribute('aria-current', 'page');
    if (await panel.evaluate((el) => el.tagName) !== 'SECTION') throw new Error(`${name} unexpectedly uses a dialog`);
    if (await page.evaluate(() => document.body.style.overflow) === 'hidden') throw new Error('Workspace unexpectedly locked page scrolling');
  }
  await page.getByRole('button', { name: '返回知识文件' }).click();
  await expect(page.getByRole('heading', { name: '知识文件', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '数据分析助手', exact: true }).click();
  await expect(page.locator('main .ana-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送提问' })).toBeVisible();
  await page.getByRole('button', { name: /知识文件/ }).first().click();
  await expect(page.getByRole('heading', { name: '知识文件', exact: true })).toBeVisible();
  console.log('PASS: tools switch within the workspace on desktop and mobile');
} finally { await browser.close(); }
