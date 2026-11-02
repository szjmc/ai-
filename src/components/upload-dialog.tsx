"use client";

import { useEffect, useId, useRef, useState } from "react";
import { uploadFile } from "@/lib/client-api";
import { CHUNK_STRATEGIES, IMAGE_TYPES, isFileType, MAX_FILE_BYTES, STRATEGY_META } from "@/lib/constants";
import { formatBytes } from "@/lib/format";
import { FILE_TYPES, type ChunkStrategy, type FileDict, type Operator } from "@/lib/types";
import { useModalDialog } from "./use-modal-dialog";
import { ArchiveArt } from "./archive-art";
import { OperatorSelect } from "./operator-select";
import { CollectionCombobox } from "./collection-combobox";
import type { CollectionStat } from "@/lib/types";

type Props = {
  open: boolean; collections: (string | CollectionStat)[]; preferredCollection: string; initialFile: File | null;
  onClose: () => void; onUploaded: (file: FileDict, message: string) => void;
  onPreview: (file: FileDict) => void; onInfo: (file: FileDict) => void;
  operators: Operator[];
  onAddOperator: (name: string) => Promise<Operator>;
  onRenameOperator: (id: number, name: string) => Promise<Operator>;
};
function fileError(file: File) {
  if (!isFileType(file.name.split(".").pop()?.toLowerCase() || "")) return "不支持此文件类型，请选择文档或 PNG、JPG、WebP、GIF 图片";
  if (!file.size) return "文件内容为空";
  if (file.size > MAX_FILE_BYTES) return "文件大小超过 50MB 限制";
  return "";
}

export function UploadDialog({ open, collections, preferredCollection, initialFile, onClose, onUploaded, onPreview, onInfo, operators, onAddOperator, onRenameOperator }: Props) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialog = useModalDialog(open);
  const [file, setFile] = useState<File | null>(null);
  const [collection, setCollection] = useState("");
  const [description, setDescription] = useState("");
  const [strategy, setStrategy] = useState<ChunkStrategy>("adaptive");
  const [createdBy, setCreatedBy] = useState(1);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<FileDict | null>(null);
  const [thumbnail, setThumbnail] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const extension = file?.name.split(".").pop()?.toLowerCase() || "";
  useEffect(() => {
    if (!open) return;
    const error = initialFile ? fileError(initialFile) : "";
    setFile(error ? null : initialFile); setError(error); setProgress(0); setBusy(false);
    setUploaded(null); setResultMessage(""); setDescription(""); setCollection(preferredCollection); setStrategy("adaptive");
    // Capture the preferred collection only when opening, not when the upload updates the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);
  useEffect(() => {
    if (!open || !file || !IMAGE_TYPES.has(extension)) { setThumbnail(""); return; }
    const url = URL.createObjectURL(file); setThumbnail(url);
    return () => URL.revokeObjectURL(url);
  }, [file, extension, open]);
  if (!open) return null;

  function takeFile(next: File | null) {
    if (busy) return;
    const error = next ? fileError(next) : "";
    setError(error); setFile(error ? null : next); setUploaded(null); setProgress(0);
  }
  async function submit() {
    if (!file) { setError("请先选择文件"); return; }
    const error = fileError(file);
    if (error) { setError(error); return; }
    if (!collection.trim()) { setError("请填写集合名称"); return; }
    setBusy(true); setError(""); setProgress(0);
    const form = new FormData();
    form.set("file", file); form.set("collection_name", collection.trim());
    form.set("description", description.trim()); form.set("chunk_strategy", strategy); form.set("created_by", String(createdBy));
    try {
      const response = await uploadFile(form, setProgress);
      setUploaded(response.data); setResultMessage(response.message); setProgress(100); onUploaded(response.data, response.message);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "上传失败，请重试"); }
    finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="upload-modal modal" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header><div><p className="kicker">Add to your knowledge</p><h2 id={titleId}>{uploaded ? "上传完成" : "上传知识文件"}</h2></div><button className="icon-btn" type="button" onClick={onClose} disabled={busy} aria-label="关闭上传">×</button></header>
      {uploaded ? <div className="upload-success">
        <div className="success-check" aria-hidden="true">✓</div><h3>{uploaded.original_name}</h3><p role="status">{resultMessage}</p>
        <div className="meta-grid"><div><span>所属集合</span><strong>{uploaded.collection_name}</strong></div><div><span>文件类型与大小</span><strong>{uploaded.file_type.toUpperCase()} · {formatBytes(uploaded.file_size)}</strong></div></div>
        <div className="success-actions"><button className="btn btn-primary" type="button" onClick={() => onPreview(uploaded)}>预览文件</button><button className="btn btn-line" type="button" onClick={() => onInfo(uploaded)}>查看文件信息</button></div>
        <div className="modal-foot"><button className="btn btn-quiet" type="button" onClick={() => { setUploaded(null); setFile(null); setDescription(""); setProgress(0); }}>继续上传</button><button className="btn btn-line" type="button" onClick={onClose}>返回台账</button></div>
      </div> : <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="modal-grid">
          <div className={`dropzone${dragOver ? " drag" : ""}`} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragOver(false); takeFile(event.dataTransfer.files[0] || null); }}>
            <ArchiveArt />
            <input className="sr-only" ref={inputRef} type="file" aria-label="选择上传文件" accept={FILE_TYPES.map((type) => `.${type}`).join(",")} disabled={busy} onChange={(event) => { takeFile(event.target.files?.[0] || null); event.target.value = ""; }} />
            {file ? <div className="file-chip">{thumbnail ? <img className="upload-thumbnail" src={thumbnail} alt={`待上传图片 ${file.name}`} onError={() => setThumbnail("")} /> : <span className="type-seal">{extension}</span>}<strong>{file.name}</strong><span>{formatBytes(file.size)} · {extension.toUpperCase()}</span><button className="btn btn-ghost" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>更换文件</button></div> : <button className="choose-file" type="button" onClick={() => inputRef.current?.click()}><span className="upload-symbol" aria-hidden="true">↑</span><strong>拖入文件，或点击选择</strong><span>支持文档及 PNG、JPG、WebP、GIF 图片<br />单文件不超过 50MB</span></button>}
          </div>
          <div className="fields">
            <div className="field">
              <span>所属集合 <b className="required">*</b></span>
              <CollectionCombobox
                value={collection}
                collections={collections}
                disabled={busy}
                required
                placeholder="搜索已有集合，或直接输入新集合名称"
                onChange={setCollection}
              />
              {collection.trim() && !collections.some((c) => (typeof c === "string" ? c : c.name) === collection.trim()) && (
                <span className="hint">将使用新集合：“{collection.trim()}”（保存时自动创建）</span>
              )}
            </div>
            <label className="field"><span>文件描述</span><textarea aria-label="文件描述" value={description} maxLength={255} disabled={busy} placeholder="添加关键词或说明，方便之后搜索" onChange={(event) => setDescription(event.target.value)} /><span className="counter">{description.length}/255</span></label>
            <label className="field"><span>分块策略</span><select value={strategy} disabled={busy} onChange={(event) => setStrategy(event.target.value as ChunkStrategy)}>{CHUNK_STRATEGIES.map((value) => <option key={value} value={value}>{STRATEGY_META[value].label} — {STRATEGY_META[value].hint}</option>)}</select><span className="muted">{IMAGE_TYPES.has(extension) ? "图片按原文件保存，此处仅记录策略，不执行文字识别。" : "这里只记录分块策略，上传不执行内容切分。"}</span></label>
            <div className="field"><span>创建者</span><OperatorSelect label="创建者" operators={operators} value={createdBy} disabled={busy} onChange={setCreatedBy} onAdd={onAddOperator} onRename={onRenameOperator} /></div>
          </div>
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {busy && <><div className="progress" role="progressbar" aria-label="文件上传进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><b style={{ width: `${progress}%` }} /></div><p className="phase" role="status">{progress >= 100 ? "文件已发送，正在等待后端保存完成…" : `正在上传… ${progress}%`}</p></>}
        <div className="modal-foot"><span className="muted">上传完成后可独立预览和编辑信息</span><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "正在保存…" : "上传并保存"}</button></div>
      </form>}
    </dialog>
  );
}
