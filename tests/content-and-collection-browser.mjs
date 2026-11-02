import assert from 'node:assert/strict';
import { chromium, expect as baseExpect } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 20000 });
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const createdIds = [];

async function uploadFile(name, content, collection = 'GoogleSearch测试') {
  const response = await context.request.post('/api/v1/file/uploadFile', {
    multipart: {
      file: { name, mimeType: 'text/markdown', buffer: Buffer.from(content) },
      collection_name: collection,
      description: '内容编辑自动化测试',
    },
  });
  assert.equal(response.status(), 201, await response.text());
  const record = (await response.json()).data;
  createdIds.push(record.id);
  return record;
}

try {
  const initialDoc = await uploadFile('待编辑文档.md', '# 初始标题\n\n这是原始的第一版文件正文内容。');

  await page.goto('/');

  // ---------------- 1. Test Google Search Style Collection Combobox in Upload Dialog ----------------
  await page.getByRole('button', { name: '上传文件', exact: true }).click();
  const uploadDialog = page.locator('.upload-modal');
  await expect(uploadDialog).toBeVisible();

  // Look at the collection input inside UploadDialog
  const collectionInput = uploadDialog.locator('.google-combobox input');
  await expect(collectionInput).toBeVisible();

  // Focus on input: Google suggestions dropdown opens
  await collectionInput.click();
  const suggestionsPanel = uploadDialog.locator('.google-suggestions-panel');
  await expect(suggestionsPanel).toBeVisible();

  // Type query to filter collections (e.g. "GoogleSearch")
  await collectionInput.fill('GoogleSearch');
  await expect(suggestionsPanel.locator('.google-suggestion-item').first()).toBeVisible();
  await expect(suggestionsPanel.locator('.google-match').first()).toHaveText('GoogleSearch');

  // Clear query with Google clear button (×)
  const clearBtn = uploadDialog.locator('.google-clear-btn');
  await expect(clearBtn).toBeVisible();
  await clearBtn.click();
  await expect(collectionInput).toHaveValue('');

  // Type a brand new collection name
  await collectionInput.fill('全新自建集合');
  const createOption = suggestionsPanel.locator('.google-create-option');
  await expect(createOption).toBeVisible();
  await expect(createOption).toContainText('全新自建集合');

  // Click create option
  await createOption.click();
  await expect(collectionInput).toHaveValue('全新自建集合');
  await expect(suggestionsPanel).toBeHidden();

  // Close upload dialog
  await uploadDialog.getByRole('button', { name: '关闭上传' }).click();
  console.log('PASS: Google search style collection combobox works in upload dialog');

  // ---------------- 2. Test File Content Modification (Online Editing) ----------------
  const searchInput = page.getByRole('textbox', { name: '搜索知识文件' });
  await searchInput.fill('待编辑文档.md');
  await searchInput.press('Enter');

  const fileRow = page.locator('.row', { hasText: '待编辑文档.md' });
  await expect(fileRow).toBeVisible();

  // Click "预览" button to open large preview
  await fileRow.getByRole('button', { name: '预览 待编辑文档.md', exact: true }).click();
  const previewDialog = page.locator('.file-preview-dialog');
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.locator('.document-markdown')).toContainText('这是原始的第一版文件正文内容');

  // Click "编辑正文 ✎"
  const editBtn = previewDialog.getByRole('button', { name: '编辑正文 ✎', exact: true });
  await expect(editBtn).toBeVisible();
  await editBtn.click();

  // Editor container appears
  const editorContainer = previewDialog.locator('.content-editor-container');
  await expect(editorContainer).toBeVisible();
  const textarea = editorContainer.locator('textarea.editor-textarea');
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveValue('# 初始标题\n\n这是原始的第一版文件正文内容。');

  // Edit the content
  const newText = '# 第二版新标题\n\n这是经过在线编辑修改后的新文件正文！\n\n- 特性 1\n- 特性 2';
  await textarea.fill(newText);

  // Status badge changes to "● 有未保存的修改"
  await expect(editorContainer.locator('.editor-badge.modified')).toBeVisible();

  // Test Markdown split view
  await editorContainer.getByRole('button', { name: '分屏对比', exact: true }).click();
  await expect(editorContainer.locator('.editor-preview-pane')).toContainText('第二版新标题');

  // Click "保存修改"
  const saveBtn = editorContainer.getByRole('button', { name: '保存修改', exact: true });
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  // Toast notification appears & preview updates
  await expect(page.getByText(/文件正文已保存|文件内容已更新/)).toBeVisible();

  // Exit edit mode, verify preview shows the newly edited content
  await expect(previewDialog.locator('.document-markdown')).toContainText('第二版新标题');
  await expect(previewDialog.locator('.document-markdown')).toContainText('这是经过在线编辑修改后的新文件正文！');
  await expect(previewDialog.locator('.document-markdown')).toContainText('特性 1');
  console.log('PASS: online text content editing and saving works directly in preview');

  // ---------------- 3. Test Replace File Content (Upload Replacement File) ----------------
  const replaceBtn = previewDialog.getByRole('button', { name: '替换文件 ⟳', exact: true });
  await expect(replaceBtn).toBeVisible();
  await replaceBtn.click();

  const replaceModal = page.locator('.replace-modal-overlay');
  await expect(replaceModal).toBeVisible();

  // Provide a replacement file
  const fileInput = replaceModal.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: '待编辑文档_已覆盖.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 覆盖替换后的全新正文\n\n通过替换文件功能成功上传了新版本文件。'),
  });

  await expect(replaceModal.locator('.replace-chosen-file')).toContainText('待编辑文档_已覆盖.md');
  const confirmReplaceBtn = replaceModal.getByRole('button', { name: '确认替换文件内容', exact: true });
  await expect(confirmReplaceBtn).toBeEnabled();
  await confirmReplaceBtn.click();

  // Wait for replace to finish
  await expect(replaceModal).toBeHidden();
  await expect(previewDialog.locator('.document-markdown')).toContainText('覆盖替换后的全新正文');
  console.log('PASS: replacing file content with uploaded file works');

  await page.keyboard.press('Escape');

  // ---------------- 4. Test Google Search Style Combobox in FileDrawer ----------------
  await searchInput.fill('待编辑文档_已覆盖.md');
  await searchInput.press('Enter');

  const updatedRow = page.locator('.row', { hasText: '待编辑文档_已覆盖.md' });
  await expect(updatedRow).toBeVisible();
  await updatedRow.getByRole('button', { name: '文件信息 待编辑文档_已覆盖.md', exact: true }).click();
  const infoDialog = page.locator('.file-info-dialog');
  await expect(infoDialog).toBeVisible();

  // Find the Google combobox inside file drawer
  const drawerCollectionInput = infoDialog.locator('.google-combobox input');
  await expect(drawerCollectionInput).toBeVisible();
  await drawerCollectionInput.click();

  const drawerSuggestions = infoDialog.locator('.google-suggestions-panel');
  await expect(drawerSuggestions).toBeVisible();

  // Select an existing collection or type a new one
  await drawerCollectionInput.fill('GoogleSearch测试');
  await expect(drawerSuggestions.locator('.google-suggestion-item')).toBeVisible();

  await infoDialog.getByRole('button', { name: '关闭文件信息' }).click();
  console.log('PASS: Google search style combobox works in file drawer');

} finally {
  for (const id of createdIds) {
    await context.request.delete(`/api/v1/file/${id}`).catch(() => undefined);
  }
  await browser.close();
}
