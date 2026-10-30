"use client";

import { useEffect, useRef, useState } from "react";
import { deleteFile, fetchFile, replaceFileContent, updateFile } from "@/lib/client-api";
import { CHUNK_STRATEGIES, FILE_STATUSES, STATUS_META, STRATEGY_META, TEXT_PREVIEW_TYPES, isFileType, MAX_FILE_BYTES, operatorName, statusLabel } from "@/lib/constants";
import { formatBytes, formatTime } from "@/lib/format";
import type { CollectionStat, FileDict, Operator } from "@/lib/types";
import { useModalDialog } from "./use-modal-dialog";
import { OperatorSelect } from "./operator-select";
import { CollectionCombobox } from "./collection-combobox";

type Props = {
  id: string | null;
  collections?: (string | CollectionStat)[];
  onClose: () => void;
  onChanged: (file: FileDict) => void;
  onDeleted: (id: string) => void;
  onToast: (kind: "ok" | "err", text: string) => void;
  onPreview: (file: FileDict) => void;
  onEditContent?: (file: FileDict) => void;
  onChunk?: (file: FileDict) => void;
  operators: Operator[];
  onAddOperator: (name: string) => Promise<Operator>;
  onRenameOperator: (id: number, name: string) => Promise<Operator>;
};

type Draft = {
  collection_name: string;
  description: string;
  status: string;
  chunk_strategy: string;
  updated_by: number;
};

const draftOf = (file: FileDict): Draft => ({
  collection_name: file.collection_name,
  description: file.description,
  status: file.status,
  chunk_strategy: file.chunk_strategy || "adaptive",
  updated_by: file.updated_by || file.created_by || 1,
});

function displayPath(value: string) {
  if (!/^https?:\/\//.test(value)) return value;
  try {
    return decodeURIComponent(new URL(value).pathname.replace(/^\//, ""));
  } catch {
    return value.split("?")[0];
  }
}

export function FileDrawer({
  id,
  collections = [],
  onClose,
  onChanged,
  onDeleted,
  onToast,
  onPreview,
  onEditContent,
  onChunk,
  operators,
  onAddOperator,
  onRenameOperator,
}: Props) {
  const dialog = useModalDialog(Boolean(id));
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<FileDict | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setFile(null);
    setDraft(null);
    setConfirmDelete(false);
    setFeedback("");
    setReplacementFile(null);

    fetchFile(id, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setFile(next);
          setDraft(draftOf(next));
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : "文件信息读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [id, retry]);

  if (!id) return null;

  const dirty = Boolean(
    file &&
      draft &&
      (draft.collection_name !== file.collection_name ||
        draft.description !== file.description ||
        draft.status !== file.status ||
        draft.chunk_strategy !== file.chunk_strategy ||
        draft.updated_by !== (file.updated_by || file.created_by || 1))
  );

  const isTextEditable =
    file && (TEXT_PREVIEW_TYPES.has(file.file_type) || ["txt", "md", "json", "sql"].includes(file.file_type));

  const leave = (next: () => void) => {
    if (!saving && !replacing && (!dirty || window.confirm("还有未保存的修改，确定离开文件信息吗？"))) {
      next();
    }
  };

  async function save() {
    if (!file || !draft) return;
    setSaving(true);
    setFeedback("");
    try {
      const next = await updateFile(file.id, draft);
      setFile(next);
      setDraft(draftOf(next));
      onChanged(next);
      setFeedback(`已保存，当前版本 v${next.version_no}`);
      onToast("ok", "文件信息已保存");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!file) return;
    setSaving(true);
    try {
      await deleteFile(file.id);
      onDeleted(file.id);
      onToast("ok", "文件已删除");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleReplacementSubmit() {
    if (!file || !replacementFile) return;
    const ext = replacementFile.name.split(".").pop()?.toLowerCase() || "";
    if (!isFileType(ext)) {
      setError(`不支持的文件类型：${ext || "未知"}`);
      return;
    }
    if (replacementFile.size > MAX_FILE_BYTES) {
      setError("替换文件超过 50MB 限制");
      return;
    }

    setReplacing(true);
    setError("");
    try {
      const updated = await replaceFileContent(file.id, replacementFile, draft?.updated_by);
      setFile(updated);
      setDraft(draftOf(updated));
      setReplacementFile(null);
      onChanged(updated);
      setFeedback(`文件内容已成功替换！当前版本升至 v${updated.version_no}`);
      onToast("ok", `已替换文件内容（v${updated.version_no}）`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "替换文件内容失败");
    } finally {
      setReplacing(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="file-info-dialog"
      aria-labelledby="file-info-title"
      onCancel={(event) => {
        event.preventDefault();
        leave(onClose);
      }}
    >
      <header className="info-header">
        <div>
          <p className="kicker">File information</p>
          <h2 id="file-info-title">文件信息</h2>
        </div>
        <button
          className="icon-btn"
          type="button"
          aria-label="关闭文件信息"
          disabled={saving || replacing}
          onClick={() => leave(onClose)}
        >
          ×
        </button>
      </header>

      <div className="info-scroll">
        {loading && <p className="phase" role="status">正在读取文件信息…</p>}
        {error && (
          <div className="inline-error" role="alert">
            <p>{error}</p>
            {!file && (
              <button className="btn btn-line" type="button" onClick={() => setRetry((v) => v + 1)}>
                重新加载
              </button>
            )}
          </div>
        )}

        {file && draft && (
          <>
            <div className="info-file-heading">
              <span className="type-seal">{file.file_type}</span>
              <div>
                <h3>{file.original_name}</h3>
                <span className={`status status-${file.status}`}>{statusLabel(file.status)}</span>
              </div>
            </div>

            <div className="info-preview-callout">
              <div>
                <strong>查看与修改文件内容</strong>
                <span>支持在线预览大窗口；文档类可在线修改文字或上传新版本覆盖。</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {isTextEditable && onEditContent && (
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => leave(() => onEditContent(file))}
                  >
                    在线编辑正文 ✎
                  </button>
                )}
                <button className="btn btn-line" type="button" onClick={() => leave(() => onPreview(file))}>
                  打开预览 ↗
                </button>
              </div>
            </div>

            {onChunk && (
              <div className="info-preview-callout">
                <div>
                  <strong>文档分片与元数据入库</strong>
                  <span>调用后端解析服务：下载 MinIO 原文件 → Jieba 分词切分 → 生成分片元数据 → 写入 Milvus。</span>
                </div>
                <button className="btn btn-line" type="button" onClick={() => leave(() => onChunk(file))}>
                  分片解析 ⚙
                </button>
              </div>
            )}

            <dl className="info-facts">
              <div>
                <dt>文件大小</dt>
                <dd>{file.file_size ? formatBytes(file.file_size) : "未获取"}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>v{file.version_no}</dd>
              </div>
              <div>
                <dt>创建者</dt>
                <dd>{operatorName(file.created_by, operators)}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{formatTime(file.created_time, true)}</dd>
              </div>
              <div>
                <dt>更新者</dt>
                <dd>{file.updated_by ? operatorName(file.updated_by, operators) : "—"}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{formatTime(file.updated_time, true)}</dd>
              </div>
            </dl>

            <div className="fields">
              <div className="field">
                <span>所属集合 <b className="required">*</b></span>
                <CollectionCombobox
                  value={draft.collection_name}
                  collections={collections}
                  placeholder="搜索已有集合，或直接输入新集合名称"
                  onChange={(next) => setDraft({ ...draft, collection_name: next })}
                />
              </div>

              <label className="field">
                <span>文件描述</span>
                <textarea
                  aria-label="文件描述"
                  value={draft.description}
                  maxLength={255}
                  placeholder="为文件补充说明，方便搜索"
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
                <span className="counter">{draft.description.length}/255</span>
              </label>

              <div className="field">
                <span>文件状态</span>
                <div className="status-picks">
                  {FILE_STATUSES.map((status) => (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={draft.status === status}
                      className={draft.status === status ? "on" : ""}
                      onClick={() => setDraft({ ...draft, status })}
                    >
                      {STATUS_META[status].label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="field">
                <span>分块策略</span>
                <select
                  value={draft.chunk_strategy}
                  onChange={(event) => setDraft({ ...draft, chunk_strategy: event.target.value })}
                >
                  {CHUNK_STRATEGIES.map((strategy) => (
                    <option key={strategy} value={strategy}>
                      {STRATEGY_META[strategy].label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field">
                <span>本次操作人 <b className="required">*</b></span>
                <OperatorSelect
                  label="本次操作人"
                  operators={operators}
                  value={draft.updated_by}
                  onChange={(nextId) => {
                    setDraft({ ...draft, updated_by: nextId });
                    setFeedback("操作人已变更，请点击“保存修改”生效");
                  }}
                  onAdd={onAddOperator}
                  onRename={onRenameOperator}
                />
                <span className="muted">可直接切换、新增或给操作人改名；保存后写入 updated_by，并更新时间和版本号。</span>
              </div>
            </div>

            {/* Replacement File Area */}
            <div className="replace-content-card">
              <div className="replace-content-header">
                <strong>替换文件内容（上传新版本）</strong>
                <span className="muted">当前版本 v{file.version_no}</span>
              </div>
              <p className="muted" style={{ margin: "0 0 10px", fontSize: 12 }}>
                可上传已在本地修改完成的文件覆盖当前内容，自动更新大小并递增版本号。
              </p>
              <input
                ref={replaceInputRef}
                type="file"
                className="sr-only"
                disabled={replacing}
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) setReplacementFile(picked);
                }}
              />
              {!replacementFile ? (
                <div
                  className="replace-dropzone"
                  role="button"
                  tabIndex={0}
                  onClick={() => replaceInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") replaceInputRef.current?.click();
                  }}
                >
                  <span>点击选择新文件以替换此文件内容</span>
                </div>
              ) : (
                <div className="replace-chosen-file">
                  <div>
                    <strong>{replacementFile.name}</strong>
                    <span className="muted" style={{ display: "block", fontSize: 11, marginTop: 2 }}>
                      {formatBytes(replacementFile.size)}（原大小: {formatBytes(file.file_size)}）
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={replacing}
                      onClick={() => setReplacementFile(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={replacing}
                      onClick={handleReplacementSubmit}
                    >
                      {replacing ? "正在替换…" : "确认替换"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <details className="storage-details">
              <summary>查看存储信息</summary>
              <dl>
                <dt>文件 ID</dt>
                <dd>{file.id}</dd>
                <dt>存储文件名</dt>
                <dd>{file.file_name}</dd>
                <dt>对象路径</dt>
                <dd>{displayPath(file.minio_path)}</dd>
              </dl>
              <button
                type="button"
                className="btn btn-line"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(displayPath(file.minio_path));
                    setFeedback("对象路径已复制");
                  } catch {
                    setFeedback("无法自动复制，请选择上方路径手动复制");
                  }
                }}
              >
                复制对象路径
              </button>
            </details>

            {feedback && <p className="save-feedback" role="status">{feedback}</p>}

            {confirmDelete && (
              <div className="delete-confirm">
                <strong>确定删除此文件？</strong>
                <p>文件及其记录将被移除，无法撤销。</p>
                <div>
                  <button className="btn btn-line" type="button" onClick={() => setConfirmDelete(false)}>
                    取消
                  </button>
                  <button className="btn btn-danger" type="button" disabled={saving || replacing} onClick={remove}>
                    确认删除
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {file && draft && (
        <footer className="info-footer">
          <button
            type="button"
            className="btn btn-danger"
            disabled={saving || replacing}
            onClick={() => setConfirmDelete(true)}
          >
            删除文件
          </button>
          <div>
            <a className="btn btn-line" href={file.file_url}>
              下载
            </a>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!dirty || saving || replacing || !draft.collection_name.trim()}
              onClick={save}
            >
              {saving ? "保存中…" : "保存修改"}
            </button>
          </div>
        </footer>
      )}
    </dialog>
  );
}
