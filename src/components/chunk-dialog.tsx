"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchChunkServiceStatus, parseFileChunks } from "@/lib/client-api";
import { formatTime } from "@/lib/format";
import type { ChunkResult, ChunkServiceStatus, FileDict } from "@/lib/types";
import { useModalDialog } from "./use-modal-dialog";

type Props = {
  file: FileDict | null;
  storageMode?: "mysql" | "local";
  onClose: () => void;
  onToast: (kind: "ok" | "err", text: string) => void;
};

/**
 * Triggers the FastAPI chunking pipeline for one file.
 * All parsing, tokenising, embedding and vector writes happen in the Python service;
 * this dialog only builds the request body and renders whatever comes back.
 */

/** chunk_service._load_document uses UnstructuredMarkdownLoader, which expects text. */
const TEXT_LOADER_TYPES = new Set(["md", "txt", "json", "sql"]);

function elapsedLabel(ms: number) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

export function ChunkDialog({ file, storageMode, onClose, onToast }: Props) {
  const dialog = useModalDialog(Boolean(file));
  const [status, setStatus] = useState<ChunkServiceStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<ChunkResult | null>(null);
  const [error, setError] = useState("");
  const [showPayload, setShowPayload] = useState(false);
  const [showIds, setShowIds] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // The backend reads these three keys; file_name doubles as the MinIO object name.
  const payload = useMemo(() => {
    if (!file) return null;
    return { file_id: file.id, minio_path: file.minio_path, file_name: file.file_name };
  }, [file]);

  const probe = async (signal?: AbortSignal) => {
    setChecking(true);
    try {
      const next = await fetchChunkServiceStatus(signal);
      if (!signal?.aborted) setStatus(next);
    } catch {
      if (!signal?.aborted) setStatus(null);
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  };

  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    setResult(null); setError(""); setElapsed(0); setShowPayload(false); setShowIds(false);
    probe(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!file || !payload) return null;

  const loaderWarning = !TEXT_LOADER_TYPES.has(file.file_type);
  const localWarning = storageMode === "local";

  async function run() {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setError(""); setResult(null); setElapsed(0);
    try {
      const next = await parseFileChunks(payload!, controller.signal);
      setResult(next);
      onToast("ok", `分片完成：生成 ${next.chunks_processed} 个分片`);
    } catch (caught) {
      if (controller.signal.aborted) return;
      const message = caught instanceof Error ? caught.message : "分片解析失败";
      setError(message);
      onToast("err", message);
    } finally {
      if (!controller.signal.aborted) setRunning(false);
      abortRef.current = null;
    }
  }

  function close() {
    if (running && !window.confirm("解析仍在后端进行中，关闭窗口不会取消它。确定关闭吗？")) return;
    abortRef.current?.abort();
    onClose();
  }

  return (
    <dialog
      ref={dialog}
      className="chunk-dialog"
      aria-labelledby="chunk-dialog-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
    >
      <header className="chunk-header">
        <div>
          <p className="kicker">Document chunking</p>
          <h2 id="chunk-dialog-title">文档分片与元数据入库</h2>
        </div>
        <button className="icon-btn" type="button" aria-label="关闭分片窗口" onClick={close}>×</button>
      </header>

      <div className="chunk-scroll">
        <div className="chunk-file-card">
          <span className="type-seal">{file.file_type}</span>
          <div>
            <strong title={file.original_name}>{file.original_name}</strong>
            <span className="muted">{file.collection_name} · {file.minio_path}</span>
          </div>
        </div>

        {/* 后端服务状态 */}
        <div className={`chunk-service-row${status?.reachable ? " is-online" : " is-offline"}`} role="status">
          <span className="chunk-dot" aria-hidden="true" />
          <div>
            <strong>
              {checking ? "正在检测解析服务…" : status?.reachable ? "解析服务在线" : "解析服务未连接"}
            </strong>
            <span className="muted">
              {status ? status.endpoint : "—"}
              {status && !status.reachable && status.reason ? ` · ${status.reason}` : ""}
            </span>
            {status && !status.reachable && status.hint ? <span className="muted">{status.hint}</span> : null}
          </div>
          <button className="btn btn-line operator-mini" type="button" disabled={checking || running} onClick={() => probe()}>
            重新检测
          </button>
        </div>

        {localWarning && (
          <div className="chunk-warning" role="status">
            当前为本地暂存模式，文件只存在于本服务器，未写入 MinIO。解析服务会直接从 MinIO 下载对象，因此很可能提示找不到文件。请在连通 MinIO 的环境中执行分片。
          </div>
        )}
        {loaderWarning && (
          <div className="chunk-warning" role="status">
            后端 <code>_load_document</code> 使用 <code>UnstructuredMarkdownLoader</code> 按文本解析，对 <strong>{file.file_type.toUpperCase()}</strong> 这类二进制格式可能失败或得到乱码。建议先用 md、txt、json、sql 验证流程。
          </div>
        )}

        {/* 处理流程说明：对应后端 process_minio_document 的 6 步 */}
        <section className="chunk-pipeline" aria-label="后端处理流程">
          <h3>后端处理流程</h3>
          <ol>
            <li><b>1</b><span>从 MinIO 下载对象到临时目录</span></li>
            <li><b>2</b><span>UnstructuredMarkdownLoader 加载文档正文</span></li>
            <li><b>3</b><span>Jieba 中文分词后按 800 字 / 重叠 100 字切分，丢弃少于 50 字的片段</span></li>
            <li><b>4</b><span>写入元数据：chunk_id、chunk_index、total_chunks、business_scene 等</span></li>
            <li><b>5</b><span>向量化后写入 Milvus 集合</span></li>
            <li><b>6</b><span>清理临时文件并返回结果</span></li>
          </ol>
          <p className="muted">
            分片参数与策略由后端 <code>chunk_router.py</code> 固定（<code>JiebaChunkingStrategy(chunk_size=800, chunk_overlap=100)</code>），页面不提供修改入口。
          </p>
        </section>

        <details className="chunk-payload" open={showPayload} onToggle={(e) => setShowPayload((e.target as HTMLDetailsElement).open)}>
          <summary>查看将要发送的请求</summary>
          <p className="muted">POST <code>/api/v1/chunks/parseFile</code>（由本页转发至 FastAPI，不做任何加工）</p>
          <pre>{JSON.stringify(payload, null, 2)}</pre>
        </details>

        {running && (
          <div className="chunk-progress" role="status">
            <span className="loading-ring" />
            <div>
              <strong>正在解析…已用时 {elapsedLabel(elapsed)}</strong>
              <span className="muted">下载、分词、向量化与写入 Milvus 都在后端进行，大文档可能需要数分钟。</span>
            </div>
          </div>
        )}

        {error && !running && (
          <div className="inline-error" role="alert">
            <p>{error}</p>
            <button className="btn btn-line" type="button" onClick={run}>重试解析</button>
          </div>
        )}

        {result && !running && (
          <section className="chunk-result" aria-label="分片结果">
            <div className="chunk-result-head">
              <span className="success-check" aria-hidden="true">✓</span>
              <div>
                <strong>分片完成</strong>
                <span className="muted">结果由后端返回，已写入 Milvus 向量库</span>
              </div>
            </div>
            <dl className="info-facts">
              <div><dt>生成分片数</dt><dd className="chunk-count">{result.chunks_processed}</dd></div>
              <div><dt>向量 ID 数量</dt><dd>{result.chunk_ids?.length ?? 0}</dd></div>
              <div><dt>文件 ID</dt><dd className="chunk-mono">{result.file_id}</dd></div>
              <div><dt>对象名</dt><dd className="chunk-mono">{result.file_name}</dd></div>
              <div><dt>MinIO 路径</dt><dd className="chunk-mono">{result.minio_path}</dd></div>
              <div><dt>处理时间</dt><dd>{formatTime(result.process_time, true)}</dd></div>
            </dl>
            <p className="muted chunk-meta-note">
              每个分片的元数据由后端 <code>MinIOMetadataStrategy</code> 生成：
              <code>chunk_id</code>（形如 <code>{result.file_id}_chunk_0001</code>）、<code>chunk_index</code>、
              <code>total_chunks</code>、<code>chunk_length</code>、<code>created_at</code>、<code>business_scene</code>。
            </p>
            {result.chunk_ids?.length ? (
              <details className="chunk-payload" open={showIds} onToggle={(e) => setShowIds((e.target as HTMLDetailsElement).open)}>
                <summary>查看 Milvus 向量 ID（{result.chunk_ids.length} 条）</summary>
                <pre>{JSON.stringify(result.chunk_ids, null, 2)}</pre>
              </details>
            ) : null}
          </section>
        )}
      </div>

      <footer className="chunk-footer">
        <span className="muted">解析在后端执行，本页只负责发起与展示</span>
        <div>
          <button className="btn btn-line" type="button" onClick={close}>{result ? "完成" : "取消"}</button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={running || checking || !status?.reachable}
            onClick={run}
          >
            {running ? "解析中…" : result ? "重新解析" : "开始分片解析"}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
