"use client";

import { useEffect, useRef, useState } from "react";
import { fetchFileBlob, fetchFileContent, fetchPreview, replaceFileContent, updateFileTextContent } from "@/lib/client-api";
import { formatBytes } from "@/lib/format";
import { isFileType, MAX_FILE_BYTES, TEXT_PREVIEW_TYPES } from "@/lib/constants";
import type { FileDict, PreviewPayload, SheetMerge } from "@/lib/types";
import { useModalDialog } from "./use-modal-dialog";

function documentSrcDoc(html: string) {
  const body = html.replace(/<img /g, '<img loading="lazy" decoding="async" ');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color:#23180f;background:#fffdf9;font:15px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif}
    body{max-width:1040px;margin:0 auto;padding:42px 54px 80px;overflow-wrap:anywhere}
    h1,h2,h3,h4,h5,h6{font-family:"Songti SC","Noto Serif SC",Georgia,serif;line-height:1.45;color:#24170f;margin:1.6em 0 .6em}
    h1{font-size:29px;border-bottom:1px solid #decfbe;padding-bottom:14px;margin-top:0}h2{font-size:23px}h3{font-size:19px}h4{font-size:16.5px}h5,h6{font-size:15px}
    p{margin:10px 0}ul,ol{padding-left:1.6em;margin:10px 0}li{margin:4px 0}
    pre{margin:14px 0;padding:14px 18px;background:#f4efe7;border:1px solid #e3d6c4;border-radius:8px;overflow:auto;font:13px/1.7 "SFMono-Regular",Consolas,"Liberation Mono","Courier New","Microsoft YaHei",monospace;white-space:pre-wrap;word-break:break-word}
    code{font-family:"SFMono-Regular",Consolas,"Courier New",monospace;font-size:.92em;background:#f4efe7;padding:1px 5px;border-radius:4px}
    pre code{background:none;padding:0;font-size:inherit}
    table{border-collapse:collapse;width:100%;margin:18px 0;font-size:13px}th,td{border:1px solid #decfbe;padding:7px 10px;vertical-align:top}th{background:#f4eadc;text-align:left}
    img{display:block;max-width:100%;height:auto;margin:14px 0;border-radius:4px;box-shadow:0 0 0 1px #e3d6c4}
    a{color:#9d3126}blockquote{margin:16px 0;padding:8px 18px;border-left:3px solid #c6a36a;background:#faf3e8}
  </style></head><body>${body}</body></html>`;
}

function ImageCanvas({ url, name, onError }: { url: string; name: string; onError: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [bounds, setBounds] = useState({ w: 1, h: 1 });
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => setBounds({ w: element.clientWidth, h: element.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);

  const rotated = rotation % 180 !== 0;
  const width = rotated ? natural.h : natural.w;
  const height = rotated ? natural.w : natural.h;
  const fit = Math.max(0.01, Math.min((bounds.w - 48) / (width || 1), (bounds.h - 48) / (height || 1), 1));
  const scale = zoom === "fit" ? fit : zoom;

  return (
    <div className="image-viewer">
      <div className="image-controls" aria-label="图片工具栏">
        <button type="button" className="btn btn-line" aria-label="缩小图片" disabled={!natural.w} onClick={() => setZoom(Math.max(0.01, scale * 0.8))}>−</button>
        <output aria-label="图片缩放比例">{Math.round(scale * 100)}%</output>
        <button type="button" className="btn btn-line" aria-label="放大图片" disabled={!natural.w} onClick={() => setZoom(Math.min(4, scale * 1.25))}>+</button>
        <span className="control-divider" />
        <button type="button" className={`btn btn-line${zoom === "fit" ? " is-active" : ""}`} onClick={() => setZoom("fit")}>适应窗口</button>
        <button type="button" className="btn btn-line" onClick={() => setZoom(1)}>原始大小</button>
        <button type="button" className="btn btn-line" onClick={() => { setRotation((v) => (v + 90) % 360); setZoom("fit"); }}>旋转 90°</button>
        {natural.w > 0 && <span className="muted image-dimensions">{natural.w} × {natural.h} px</span>}
      </div>
      <div className="image-viewport" ref={viewport}>
        <div className="image-stage" style={{ width: Math.max(bounds.w, width * scale + 48), height: Math.max(bounds.h, height * scale + 48) }}>
          <img
            className="preview-image"
            src={url}
            alt={name}
            draggable={false}
            style={{ width: natural.w || undefined, height: natural.h || undefined, transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`, opacity: natural.w ? 1 : 0 }}
            onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
            onError={onError}
          />
          {!natural.w && <span className="media-loading" role="status">正在解码图片…</span>}
        </div>
      </div>
    </div>
  );
}

function SpreadsheetViewer({ payload, onSheet }: { payload: PreviewPayload; onSheet: (sheet: string) => void }) {
  const table = payload.table;
  if (!table) return null;

  const spans = new Map<string, SheetMerge>();
  const covered = new Set<string>();
  for (const merge of table.merges) {
    spans.set(`${merge.row},${merge.col}`, merge);
    for (let r = merge.row; r < merge.row + merge.row_span; r += 1) {
      for (let c = merge.col; c < merge.col + merge.col_span; c += 1) {
        if (r !== merge.row || c !== merge.col) covered.add(`${r},${c}`);
      }
    }
  }

  return (
    <div className="spreadsheet-viewer">
      <div className="sheet-tabs" role="tablist" aria-label="Excel 工作表">
        {(payload.sheet_names || []).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === payload.active_sheet}
            className={name === payload.active_sheet ? "active" : ""}
            onClick={() => onSheet(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {payload.warnings?.length ? <div className="office-warning" role="status">{payload.warnings.join("；")}</div> : null}
      {!table.rows.length ? (
        <div className="viewer-state">
          <h3>工作表为空</h3>
          <p>此工作表没有可显示的数据。</p>
        </div>
      ) : (
        <div className="sheet-grid-wrap">
          <table className="sheet-grid">
            <thead>
              <tr>
                <th className="sheet-corner">#</th>
                {table.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row">{table.row_numbers[r]}</th>
                  {row.map((value, c) => {
                    const key = `${r},${c}`;
                    if (covered.has(key)) return null;
                    const merge = spans.get(key);
                    return (
                      <td key={c} rowSpan={merge?.row_span} colSpan={merge?.col_span} title={value}>
                        {value}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sheet-summary">
        当前工作表共 {table.total_rows} 行、{table.total_columns} 列（行号、列号与 Excel 一致，已隐藏的行列不显示）。
      </div>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  return (
    <article className="document-markdown">
      {text.split(/\n\s*\n/).map((block, index) => {
        if (block.startsWith("### ")) return <h3 key={index}>{block.slice(4)}</h3>;
        if (block.startsWith("## ")) return <h2 key={index}>{block.slice(3)}</h2>;
        if (block.startsWith("# ")) return <h1 key={index}>{block.slice(2)}</h1>;
        if (block.split("\n").every((line) => /^[-*] /.test(line))) {
          return (
            <ul key={index}>
              {block.split("\n").map((line, item) => (
                <li key={item}>{line.slice(2)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{block}</p>;
      })}
    </article>
  );
}

type Props = {
  file: FileDict | null;
  initialEditMode?: boolean;
  onClose: () => void;
  onInfo: (file: FileDict) => void;
  onFileUpdated?: (file: FileDict) => void;
  onToast?: (kind: "ok" | "err", text: string) => void;
};

export function FilePreview({ file, initialEditMode = false, onClose, onInfo, onFileUpdated, onToast }: Props) {
  const dialog = useModalDialog(Boolean(file));
  const replaceFileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [blobUrl, setBlobUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [requestedSheet, setRequestedSheet] = useState("");

  // Content edit state
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [initialContent, setInitialContent] = useState("");
  const [isSavingContent, setIsSavingContent] = useState(false);
  const [editViewMode, setEditViewMode] = useState<"edit" | "split" | "preview">("edit");
  const [jsonValidation, setJsonValidation] = useState<{ valid: boolean; error?: string } | null>(null);

  // File replacement modal state
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [isReplacing, setIsReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState("");

  const id = file?.id;
  const isTextEditable =
    Boolean(file && (TEXT_PREVIEW_TYPES.has(file.file_type) || ["txt", "md", "json", "sql"].includes(file.file_type)));

  useEffect(() => {
    setMaximized(false);
    setRequestedSheet("");
    setIsEditing(Boolean(initialEditMode && isTextEditable));
    setEditContent("");
    setInitialContent("");
    setShowReplaceModal(false);
    setReplacementFile(null);
  }, [id, initialEditMode, isTextEditable]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let objectUrl = "";
    setLoading(true);
    setPayload(null);
    setBlobUrl("");
    setError("");

    async function load() {
      const next = await fetchPreview(id!, controller.signal, requestedSheet || undefined);
      if (controller.signal.aborted) return;

      if (next.kind === "image" || next.kind === "pdf") {
        const blob = await fetchFileBlob(id!, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        if (blob.type.startsWith("image/")) next.kind = "image";
      }

      setPayload(next);

      // If text file, initialize editor content
      if (next.kind === "text" && !editContent) {
        setEditContent(next.text || "");
        setInitialContent(next.text || "");
      }
    }

    load()
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "文件加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, retry, requestedSheet]);

  // When opening edit mode, fetch complete content if needed
  async function enterEditMode() {
    if (!file) return;
    setIsEditing(true);
    if (!editContent) {
      try {
        const { content } = await fetchFileContent(file.id);
        setEditContent(content);
        setInitialContent(content);
      } catch {
        if (payload?.text) {
          setEditContent(payload.text);
          setInitialContent(payload.text);
        }
      }
    }
  }

  function exitEditMode() {
    if (editContent !== initialContent && !window.confirm("正文有未保存的修改，确定放弃并返回预览吗？")) {
      return;
    }
    setEditContent(initialContent);
    setIsEditing(false);
  }

  // Validate JSON on the fly
  useEffect(() => {
    if (!isEditing || file?.file_type !== "json") {
      setJsonValidation(null);
      return;
    }
    if (!editContent.trim()) {
      setJsonValidation(null);
      return;
    }
    try {
      JSON.parse(editContent);
      setJsonValidation({ valid: true });
    } catch (err) {
      setJsonValidation({ valid: false, error: err instanceof Error ? err.message : "JSON 语法错误" });
    }
  }, [isEditing, editContent, file?.file_type]);

  function handleFormatJson() {
    try {
      const parsed = JSON.parse(editContent);
      setEditContent(JSON.stringify(parsed, null, 2));
      onToast?.("ok", "JSON 已格式化缩进");
    } catch (err) {
      onToast?.("err", `无法格式化：${err instanceof Error ? err.message : "JSON 语法有误"}`);
    }
  }

  // Save modified text content
  async function handleSaveContent() {
    if (!file) return;
    setIsSavingContent(true);
    try {
      const updated = await updateFileTextContent(file.id, editContent);
      setInitialContent(editContent);
      setIsEditing(false);
      onFileUpdated?.(updated);
      onToast?.("ok", `文件正文已保存（版本升至 v${updated.version_no}）`);
      // Reload preview
      setRetry((v) => v + 1);
    } catch (err) {
      onToast?.("err", err instanceof Error ? err.message : "保存正文内容失败");
    } finally {
      setIsSavingContent(false);
    }
  }

  // Replace file content with new uploaded document
  async function handleReplaceFileConfirm() {
    if (!file || !replacementFile) return;
    setIsReplacing(true);
    setReplaceError("");
    try {
      const updated = await replaceFileContent(file.id, replacementFile);
      setShowReplaceModal(false);
      setReplacementFile(null);
      onFileUpdated?.(updated);
      onToast?.("ok", `文件内容已替换成功（版本升至 v${updated.version_no}）`);
      setRetry((v) => v + 1);
    } catch (err) {
      setReplaceError(err instanceof Error ? err.message : "替换文件失败");
    } finally {
      setIsReplacing(false);
    }
  }

  // Tab key indents by 2 spaces inside textarea
  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      handleSaveContent();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const next = editContent.substring(0, start) + "  " + editContent.substring(end);
      setEditContent(next);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  }

  if (!file) return null;

  const inlineUrl = `/api/v1/file/${encodeURIComponent(file.id)}/download?disposition=inline`;
  let text = payload?.text || "";
  if (file.file_type === "json" && text && !isEditing) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* display as received */
    }
  }

  const isContentModified = editContent !== initialContent;
  const lineCount = (editContent || "").split("\n").length;
  const charCount = (editContent || "").length;

  const explanation =
    payload?.kind === "pdf"
      ? "可使用 PDF 工具栏缩放、翻页"
      : payload?.kind === "image"
      ? "按原始比例显示，放大后可滚动查看"
      : payload?.kind === "document"
      ? "DOCX 已转换为安全阅读视图"
      : payload?.kind === "spreadsheet"
      ? "Excel 工作表可直接切换查看"
      : "独立阅读与编辑视图";

  return (
    <dialog
      ref={dialog}
      className={`file-preview-dialog${maximized ? " is-maximized" : ""}`}
      aria-labelledby="file-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        if (isEditing && isContentModified) {
          if (!window.confirm("正文有未保存的修改，确定关闭吗？")) return;
        }
        onClose();
      }}
    >
      <header className="preview-header">
        <div className="preview-title-group">
          <span className="type-seal">{file.file_type}</span>
          <div>
            <p className="kicker">{isEditing ? "修改文件内容 · 编辑模式" : "文件预览"}</p>
            <h2 id="file-preview-title" title={file.original_name}>
              {file.original_name}
            </h2>
          </div>
        </div>

        <div className="preview-header-actions">
          {isTextEditable && !isEditing && (
            <button
              type="button"
              className="btn btn-line"
              style={{ borderColor: "var(--cinnabar)", color: "var(--cinnabar-deep)", background: "#fffaf7" }}
              onClick={enterEditMode}
            >
              编辑正文 ✎
            </button>
          )}

          <button
            type="button"
            className="btn btn-line"
            onClick={() => {
              setReplacementFile(null);
              setReplaceError("");
              setShowReplaceModal(true);
            }}
          >
            替换文件 ⟳
          </button>

          <button type="button" className="btn btn-line" onClick={() => onInfo(file)}>
            文件信息
          </button>

          <a className="btn btn-line" href={inlineUrl} target="_blank" rel="noreferrer">
            新窗口打开 ↗
          </a>

          <a className="btn btn-primary" href={file.file_url}>
            下载原文件
          </a>

          <button
            type="button"
            className="icon-btn"
            aria-label={maximized ? "还原预览窗口" : "全屏预览"}
            onClick={() => setMaximized((v) => !v)}
          >
            {maximized ? "⊡" : "⛶"}
          </button>

          <button
            type="button"
            className="icon-btn"
            aria-label="关闭预览"
            onClick={() => {
              if (isEditing && isContentModified) {
                if (!window.confirm("正文有未保存的修改，确定关闭吗？")) return;
              }
              onClose();
            }}
          >
            ×
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {isEditing ? (
        /* Interactive Content Editor */
        <div className="content-editor-container">
          <div className="editor-toolbar">
            <div className="editor-toolbar-left">
              <span className={`editor-badge ${isContentModified ? "modified" : "clean"}`}>
                {isContentModified ? "● 有未保存的修改" : "已是最新"}
              </span>
              <span>
                {lineCount} 行 · {charCount} 字符
              </span>
              {file.file_type === "json" && jsonValidation && (
                <span className={`json-status-tag ${jsonValidation.valid ? "valid" : "invalid"}`}>
                  {jsonValidation.valid ? "✓ JSON 格式正确" : `⚠ ${jsonValidation.error}`}
                </span>
              )}
            </div>

            <div className="editor-toolbar-right">
              {file.file_type === "json" && (
                <button type="button" className="btn btn-line operator-mini" onClick={handleFormatJson}>
                  格式化 JSON
                </button>
              )}

              {file.file_type === "md" && (
                <div className="editor-view-modes">
                  <button
                    type="button"
                    className={editViewMode === "edit" ? "active" : ""}
                    onClick={() => setEditViewMode("edit")}
                  >
                    纯文本
                  </button>
                  <button
                    type="button"
                    className={editViewMode === "split" ? "active" : ""}
                    onClick={() => setEditViewMode("split")}
                  >
                    分屏对比
                  </button>
                  <button
                    type="button"
                    className={editViewMode === "preview" ? "active" : ""}
                    onClick={() => setEditViewMode("preview")}
                  >
                    预览效果
                  </button>
                </div>
              )}

              <button
                type="button"
                className="btn btn-quiet"
                disabled={isSavingContent}
                onClick={exitEditMode}
              >
                放弃修改
              </button>

              <button
                type="button"
                className="btn btn-primary"
                disabled={isSavingContent || !isContentModified}
                onClick={handleSaveContent}
              >
                {isSavingContent ? "正在保存…" : "保存修改"}
              </button>
            </div>
          </div>

          <div className="editor-body-split">
            {editViewMode !== "preview" && (
              <div className="editor-textarea-pane">
                <textarea
                  ref={textareaRef}
                  className="editor-textarea"
                  value={editContent}
                  spellCheck={false}
                  placeholder="在此输入或粘贴文件正文内容..."
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={handleTextareaKeyDown}
                />
              </div>
            )}

            {(editViewMode === "split" || editViewMode === "preview") && file.file_type === "md" && (
              <div className="editor-preview-pane">
                <MarkdownText text={editContent} />
              </div>
            )}
          </div>

          <div className="editor-footer-bar">
            <span>支持快捷键 Ctrl+S (⌘+S) 保存 · 保存后原文件将写入 MinIO 并自动自增版本号</span>
            <span>当前版本 v{file.version_no} → 保存后将为 v{file.version_no + 1}</span>
          </div>
        </div>
      ) : (
        /* Normal View Area */
        <div className="preview-content" aria-busy={loading}>
          {loading && (
            <div className="viewer-state" role="status">
              <span className="loading-ring" />
              <h3>正在读取原文件</h3>
              <p>正在生成在线预览，请稍候…</p>
            </div>
          )}

          {!loading && error && (
            <div className="viewer-state" role="alert">
              <span className="viewer-state-mark">!</span>
              <h3>暂时无法预览</h3>
              <p>{error}</p>
              <button type="button" className="btn btn-primary" onClick={() => setRetry((v) => v + 1)}>
                重新加载
              </button>
            </div>
          )}

          {!loading && !error && payload?.kind === "image" && blobUrl && (
            <ImageCanvas
              key={blobUrl}
              url={blobUrl}
              name={file.original_name}
              onError={() => setError("图片无法解码，可能已损坏或格式不正确。请下载原文件核对。")}
            />
          )}

          {!loading && !error && payload?.kind === "pdf" && blobUrl && (
            <iframe
              className="pdf-viewer"
              title={`PDF 预览：${file.original_name}`}
              src={`${blobUrl}#view=FitH&navpanes=0`}
            />
          )}

          {!loading && !error && payload?.kind === "text" && (
            <div className="text-viewport">
              {file.file_type === "md" ? <MarkdownText text={text} /> : <pre className="document-text">{text}</pre>}
              {payload.truncated && (
                <p className="preview-truncated">内容较长，仅展示前 200,000 字。请下载查看全文或点击上方编辑修改。</p>
              )}
            </div>
          )}

          {!loading && !error && payload?.kind === "document" && (
            <div className="office-document">
              <div className="office-toolbar">
                <span>DOCX 阅读视图 · 显示文字、图片、表格、代码块；如需修改可点击上方“替换文件”上传新版本</span>
                {payload.warnings?.length ? (
                  <span className="office-warning">{payload.warnings.join("；")}</span>
                ) : null}
              </div>
              <iframe
                className="docx-viewer"
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                referrerPolicy="no-referrer"
                title={`DOCX 预览：${file.original_name}`}
                srcDoc={documentSrcDoc(payload.document_html || "")}
              />
            </div>
          )}

          {!loading && !error && payload?.kind === "spreadsheet" && (
            <SpreadsheetViewer
              payload={payload}
              onSheet={(name) => {
                if (name !== payload.active_sheet) setRequestedSheet(name);
              }}
            />
          )}

          {!loading && !error && payload?.kind === "binary" && (
            <div className="viewer-state">
              <span className="type-seal">{file.file_type}</span>
              <h3>此格式暂不支持在线直接渲染</h3>
              <p>可点击右上角“替换文件”上传新版本覆盖内容，或下载后在本地打开。</p>
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <a className="btn btn-primary" href={file.file_url}>
                  下载原文件
                </a>
                <button
                  type="button"
                  className="btn btn-line"
                  onClick={() => {
                    setReplacementFile(null);
                    setReplaceError("");
                    setShowReplaceModal(true);
                  }}
                >
                  替换新版本
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Replacement File Modal Overlay */}
      {showReplaceModal && (
        <div className="replace-modal-overlay" onMouseDown={() => !isReplacing && setShowReplaceModal(false)}>
          <div className="replace-modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 18, fontFamily: "var(--serif)" }}>替换文件内容</h3>
              <button
                type="button"
                className="icon-btn"
                disabled={isReplacing}
                onClick={() => setShowReplaceModal(false)}
              >
                ×
              </button>
            </div>

            <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              选择或拖入新文件覆盖当前内容。系统将把新文件写入 MinIO / 本地存储，保留原有记录 ID 与集合，并将版本号自增（v{file.version_no} → v{file.version_no + 1}）。
            </p>

            <div style={{ padding: "10px 14px", background: "#f8f3ed", borderRadius: 10, fontSize: 12.5 }}>
              <span>当前原文件：</span>
              <strong>{file.original_name}</strong>
              <span className="muted">（{formatBytes(file.file_size)} · v{file.version_no}）</span>
            </div>

            <input
              ref={replaceFileInputRef}
              type="file"
              className="sr-only"
              disabled={isReplacing}
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) {
                  setReplacementFile(picked);
                  setReplaceError("");
                }
              }}
            />

            {!replacementFile ? (
              <div
                className="replace-dropzone"
                style={{ padding: 28 }}
                onClick={() => replaceFileInputRef.current?.click()}
              >
                <div style={{ fontSize: 24, marginBottom: 6 }}>↑</div>
                <strong style={{ display: "block", fontSize: 15 }}>点击选择替换文件，或拖入文件</strong>
                <span className="muted" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                  支持任意文档、表格及图片，单文件最大 50MB
                </span>
              </div>
            ) : (
              <div className="replace-chosen-file" style={{ padding: 14 }}>
                <div>
                  <strong style={{ fontSize: 14 }}>{replacementFile.name}</strong>
                  <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>
                    大小：{formatBytes(replacementFile.size)}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={isReplacing}
                  onClick={() => setReplacementFile(null)}
                >
                  更换
                </button>
              </div>
            )}

            {replaceError && <p className="inline-error" role="alert">{replaceError}</p>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-line"
                disabled={isReplacing}
                onClick={() => setShowReplaceModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={isReplacing || !replacementFile}
                onClick={handleReplaceFileConfirm}
              >
                {isReplacing ? "正在上传替换…" : "确认替换文件内容"}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="preview-footer">
        <span>{file.collection_name} · {file.file_type.toUpperCase()}</span>
        <span>{isEditing ? "编辑模式：可直接修改文本正文内容" : explanation} · Esc 关闭</span>
      </footer>
    </dialog>
  );
}
