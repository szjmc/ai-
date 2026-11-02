"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDrawer } from "./file-drawer";
import { FilePreview } from "./file-preview";
import { UploadDialog } from "./upload-dialog";
import { ChunkDialog } from "./chunk-dialog";
import { AssistantDialog } from "./assistant-dialog";
import { Text2SqlDialog } from "./text2sql-dialog";
import { Text2EchartsDialog } from "./text2echarts-dialog";
import { BrandMark } from "./archive-art";
import { createOperator, fetchFileList, fetchOperators, fetchStats, renameOperator, type ListParams } from "@/lib/client-api";
import { FILE_STATUSES, FILE_TYPES, OPERATORS, STATUS_META, statusLabel, strategyLabel } from "@/lib/constants";
import { formatBytes, relativeTime, toneFor } from "@/lib/format";
import { searchTokens } from "@/lib/file-search";
import type { FileDict, Operator, PageInfo, Stats } from "@/lib/types";

type Toast = { id: string; kind: "ok" | "err"; text: string };
const DEFAULT_FILTERS: ListParams = { q: "", collectionName: "", status: "", fileType: "", sort: "created_desc", page: 1, perPage: 8 };
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = searchTokens(query).map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!tokens.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${tokens.join("|")})`, "ig"));
  return <>{parts.map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}

export function KnowledgeConsole() {
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [filters, setFilters] = useState<ListParams>(DEFAULT_FILTERS);
  const [items, setItems] = useState<FileDict[]>([]);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [operators, setOperators] = useState<Operator[]>(OPERATORS.map((operator) => ({ ...operator })));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statsError, setStatsError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<FileDict | null>(null);
  const [previewEditMode, setPreviewEditMode] = useState(false);
  const [chunkFile, setChunkFile] = useState<FileDict | null>(null);
  const [view, setView] = useState<"files" | "assistant" | "sql" | "charts">("files");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [revision, setRevision] = useState(0);
  const [listRetry, setListRetry] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const pushToast = useCallback((kind: "ok" | "err", text: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current, { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4500);
  }, []);

  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => {
      const next = query.normalize("NFKC").trim();
      setFilters((current) => current.q === next ? current : { ...current, q: next, page: 1 });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, composing]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    fetchFileList(filters, controller.signal).then((list) => {
      if (!controller.signal.aborted) { setItems(list.items); setPageInfo(list.page); }
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) { setError(caught instanceof Error ? caught.message : "文件列表读取失败"); setItems([]); setPageInfo(null); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, revision, listRetry]);

  useEffect(() => {
    const controller = new AbortController();
    fetchOperators(controller.signal).then((list) => { if (!controller.signal.aborted && list.length) setOperators(list); }).catch(() => { /* keep defaults */ });
    return () => controller.abort();
  }, []);
  const addOperator = useCallback(async (name: string) => {
    const created = await createOperator({ name });
    setOperators((current) => [...current.filter((item) => item.id !== created.id), created].sort((a, b) => a.id - b.id));
    return created;
  }, []);
  const renameOperatorById = useCallback(async (id: number, name: string) => {
    const updated = await renameOperator(id, name);
    setOperators((current) => current.map((item) => (item.id === id ? updated : item)));
    return updated;
  }, []);

  // A slow or unavailable statistics endpoint must never block the search results.
  useEffect(() => {
    const controller = new AbortController();
    setStatsError("");
    fetchStats(controller.signal).then((next) => { if (!controller.signal.aborted) setStats(next); })
      .catch(() => { if (!controller.signal.aborted) setStatsError("概览暂未更新，仍可搜索和查看文件"); });
    return () => controller.abort();
  }, [revision]);

  const modalOpen = uploadOpen || Boolean(selectedId) || Boolean(previewFile) || Boolean(chunkFile);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") setDragging(false);
      if (modalOpen || target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName || "")) return;
      if (event.key.toLowerCase() === "u") { event.preventDefault(); setDroppedFile(null); setUploadOpen(true); }
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
    };
    const isFile = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => { if (!isFile(event)) return; event.preventDefault(); if (!modalOpen) { dragDepth.current++; setDragging(true); } };
    const over = (event: DragEvent) => { if (isFile(event)) event.preventDefault(); };
    const leave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
    const drop = (event: DragEvent) => {
      if (!isFile(event)) return;
      event.preventDefault(); dragDepth.current = 0; setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file && !modalOpen) { setDroppedFile(file); setUploadOpen(true); }
    };
    window.addEventListener("keydown", onKey); window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [modalOpen]);

  const closeUpload = useCallback(() => { setUploadOpen(false); setDroppedFile(null); }, []);
  const closeInfo = useCallback(() => setSelectedId(null), []);
  const closePreview = useCallback(() => setPreviewFile(null), []);
  const openPreview = (file: FileDict, editMode = false) => {
    closeUpload();
    setSelectedId(null);
    setPreviewEditMode(editMode);
    setPreviewFile(file);
  };
  const openInfo = (file: FileDict) => { closeUpload(); setPreviewFile(null); setSelectedId(file.id); };
  const openChunk = (file: FileDict) => { closeUpload(); setPreviewFile(null); setSelectedId(null); setChunkFile(file); };
  const closeChunk = useCallback(() => setChunkFile(null), []);
  const changeFilters = (patch: Partial<ListParams>) => { setView("files"); setFilters((current) => ({ ...current, ...patch, page: 1 })); };
  const reset = () => { setView("files"); setQuery(""); setFilters(DEFAULT_FILTERS); };
  const clearSearch = () => { setQuery(""); changeFilters({ q: "" }); searchRef.current?.focus(); };
  const collections = stats?.collections || [];
  const typeCounts = useMemo(() => new Map(stats?.types.map((item) => [item.key, item.count]) || []), [stats]);
  const statusCounts = useMemo(() => new Map(stats?.statuses.map((item) => [item.key, item.count]) || []), [stats]);
  const filtered = Boolean(filters.q || filters.collectionName || filters.status || filters.fileType);
  const bucket = stats?.bucket || "knowledge-base";

  return (
    <div className="zhizhan">
      <header className="topbar"><div className="top-inner">
        <div className="brand"><BrandMark /><div><h1>知栈</h1><p className="brand-subtitle">知识管理工作台</p></div></div>
        <form className="search" role="search" onSubmit={(event) => {
          event.preventDefault(); if (composing) return;
          changeFilters({ q: query.normalize("NFKC").trim() });
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m16 16 4.5 4.5" stroke="currentColor" strokeWidth="1.5" /></svg>
          <label className="sr-only" htmlFor="knowledge-search">搜索知识文件</label>
          <input ref={searchRef} id="knowledge-search" value={query} maxLength={256} placeholder="搜索文件名、集合或描述" autoComplete="off" onChange={(event) => { setView("files"); setQuery(event.target.value); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
          {query && <button type="button" className="search-clear" aria-label="清空搜索" onClick={clearSearch}>×</button>}
          <button type="submit" className="search-submit">搜索</button>
        </form>
        <div className="bucket-pill" title={`MinIO ${stats?.minio_endpoint || "127.0.0.1:9100"}`}><span className="dot" style={{ background: "#c6a36a" }} />{bucket}</div>
        <button className="btn btn-primary top-upload" type="button" onClick={() => { setDroppedFile(null); setUploadOpen(true); }}><span aria-hidden="true">＋</span> 上传文件</button>
      </div></header>

      <div className="workspace">
        <aside className="side"><div className="panel side-card">
          <div className="side-heading">工作空间 <span>WORKSPACE</span></div>
          <button type="button" className={`side-overview${view === "files" ? " active" : ""}`} aria-current={view === "files" ? "page" : undefined} onClick={() => setView("files")}><span className="side-icon">▦</span><span>知识文件</span>{view === "files" && <span className="side-current">当前</span>}</button>
          <div className="panel-label"><span>智能工具</span></div>
          <button aria-label="AI 问答" className={`tool-nav${view === "assistant" ? " active" : ""}`} aria-current={view === "assistant" ? "page" : undefined} type="button" onClick={() => setView("assistant")}><span className="tool-icon">✧</span><span>AI 问答<small>知识问答与检索</small></span><span className="tool-arrow" aria-hidden="true">›</span></button>
          <button aria-label="Text2SQL 问数" className={`tool-nav sql-entry${view === "sql" ? " active" : ""}`} aria-current={view === "sql" ? "page" : undefined} type="button" onClick={() => setView("sql")}><span className="tool-icon">⌘</span><span>Text2SQL 问数<small>用自然语言查询数据</small></span><span className="tool-arrow" aria-hidden="true">›</span></button>
          <button aria-label="数据分析助手" className={`tool-nav chart-entry${view === "charts" ? " active" : ""}`} aria-current={view === "charts" ? "page" : undefined} type="button" onClick={() => setView("charts")}><span className="tool-icon">▥</span><span>数据分析助手<small>图表 · 表格 · 智能报告</small></span><span className="tool-arrow" aria-hidden="true">›</span></button>
          <div className="side-divider" />
          <div className="panel-label"><span>知识集合</span><span>{collections.length}</span></div>
          <button className={`nav-btn${view === "files" && !filters.collectionName ? " active" : ""}`} type="button" onClick={() => changeFilters({ collectionName: "" })}><i className="dot" style={{ background: "#1b140f" }} /><span className="nav-label">全部文件</span><span className="count">{stats?.total ?? "—"}</span></button>
          {collections.map((item) => <button key={item.name} className={`nav-btn${view === "files" && filters.collectionName === item.name ? " active" : ""}`} type="button" onClick={() => changeFilters({ collectionName: item.name })}><i className="dot" style={{ background: toneFor(item.name) }} /><span className="nav-label">{item.name}</span><span className="count">{item.count}</span></button>)}
          <div className="panel-label"><span>文件状态</span></div>
          {FILE_STATUSES.map((status) => <button key={status} className={`nav-btn${filters.status === status ? " active" : ""}`} type="button" onClick={() => changeFilters({ status: filters.status === status ? "" : status })}><span className={`status status-${status}`}>{STATUS_META[status].label}</span><span className="count">{statusCounts.get(status) || 0}</span></button>)}
          <div className="panel-label"><span>文件类型</span></div>
          <div className="type-grid">{FILE_TYPES.map((type) => <button key={type} className={`btn btn-line type-chip${filters.fileType === type ? " on" : ""}`} type="button" aria-pressed={filters.fileType === type} onClick={() => changeFilters({ fileType: filters.fileType === type ? "" : type })}>{type}<span className="count">{typeCounts.get(type) || 0}</span></button>)}</div>
          <div className="side-footer"><span className="side-footer-icon">◈</span><div><strong>知识管理工作台</strong><p>让知识与数据更有价值</p></div></div>
        </div></aside>

        <main className="main">
          {view === "files" && <>
          {stats?.storage_mode === "local" && <div className="storage-notice" role="status"><span className="dot" style={{ background: "#b8883b" }} />当前未连接你的 MySQL / MinIO。配置里的 127.0.0.1 指的是运行本页面的服务器，不是你的电脑，所以这里看不到你的真实数据，上传的文件也只暂存在本服务器。请在 MySQL（{stats.mysql_db || "test_db"}）与 MinIO（{stats.minio_endpoint || "127.0.0.1:9100"}）所在的机器上运行本项目。</div>}
          {statsError && <div className="storage-notice" role="status">{statsError}<button type="button" className="btn btn-quiet" onClick={() => setRevision((value) => value + 1)}>重试概览</button></div>}
          <div className="page-intro"><div><div className="breadcrumbs">工作空间 <span>/</span> 知识文件</div><h2>知识文件</h2><p>集中管理企业知识，让信息查找和使用更高效。</p></div><div className="intro-badge"><span>✦</span> 您的知识工作空间</div></div>
          <section className="stats" aria-label="台账概览">
            <div className="stat"><span>文件总数</span><strong>{stats?.total ?? "—"}</strong><em>已归档的知识文件</em></div>
            <div className="stat"><span>知识集合</span><strong>{stats?.collections.length ?? "—"}</strong><em>按主题有序管理</em></div>
            <div className="stat"><span>已激活</span><strong>{stats?.active ?? "—"}</strong><em>{stats?.uploaded ?? "—"} 份待处理</em></div>
            <div className="stat"><span>原文件体积</span><strong className="stat-size">{stats ? formatBytes(stats.bytes) : "—"}</strong><em>{stats?.storage_mode === "local" ? "本服务器暂存文件" : "MinIO 对象存储"}</em></div>
          </section>
          <div className="lede"><div><p className="kicker">KNOWLEDGE LIBRARY</p><h2>{filters.collectionName || "全部知识文件"}</h2><p>点击文件名打开大屏预览，或通过「信息」管理描述、状态与分块策略。</p></div></div>
          <div className="toolbar">
            <p role="status" aria-live="polite">{loading ? (filters.q ? `正在搜索「${filters.q}」…` : "正在读取文件…") : error ? "文件列表未加载" : filters.q ? `「${filters.q}」· 找到 ${pageInfo?.total || 0} 份文件` : `共 ${pageInfo?.total || 0} 份文件`}</p>
            <div className="toolbar-actions"><button className="btn btn-quiet" type="button" onClick={() => setRevision((value) => value + 1)}>刷新</button><label><span className="sr-only">文件排序</span><select value={filters.sort} onChange={(event) => changeFilters({ sort: event.target.value })}><option value="created_desc">最近入库</option><option value="created_asc">最早入库</option><option value="name">按文件名</option><option value="size">按体积</option></select></label></div>
          </div>
          {filtered && <div className="filter-chips" aria-label="已应用的筛选">
            {filters.q && <button type="button" onClick={clearSearch}>关键词：{filters.q} <span>×</span></button>}
            {filters.collectionName && <button type="button" onClick={() => changeFilters({ collectionName: "" })}>集合：{filters.collectionName} <span>×</span></button>}
            {filters.status && <button type="button" onClick={() => changeFilters({ status: "" })}>{statusLabel(filters.status)} <span>×</span></button>}
            {filters.fileType && <button type="button" onClick={() => changeFilters({ fileType: "" })}>{filters.fileType.toUpperCase()} <span>×</span></button>}
            <button className="reset-filters" type="button" onClick={reset}>清空全部筛选</button>
          </div>}
          <section className="ledger" aria-label="知识文件台账" aria-busy={loading}>
            <div className="ledger-head"><span /><span>文件名称</span><span className="hide-md">集合</span><span className="hide-md">分块策略</span><span>状态</span><span className="hide-md">入库时间</span><span>操作</span></div>
            {error && <div className="error-banner" role="alert"><div><strong>文件列表读取失败</strong><p className="muted">{error}</p></div><button className="btn btn-line" type="button" onClick={() => setListRetry((value) => value + 1)}>重新加载</button></div>}
            {loading && <div className="skeleton-wrap" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <div className="skeleton-row" key={index}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>)}</div>}
            {!loading && !error && !items.length && <div className="empty"><p className="kicker">A little room for knowledge</p><h3>{filtered ? "没有找到匹配的文件" : "从第一份文件开始"}</h3><p>{filters.q ? "可搜索完整文件名、文件名片段、集合或描述；多个词用空格分隔。" : "上传文档或图片，在这里统一整理和预览。"}</p>{filtered ? <button type="button" className="btn btn-line" onClick={reset}>清空全部筛选</button> : <button type="button" className="btn btn-primary" onClick={() => setUploadOpen(true)}>上传文件</button>}</div>}
            {!loading && !error && items.map((file) => <div key={file.id} className={`row${highlightId === file.id ? " fresh" : ""}`}>
              <span className="type-seal">{file.file_type}</span>
              <div className="name"><button type="button" className="file-name-button" onClick={() => openPreview(file)} title={`预览 ${file.original_name}`}><Highlight text={file.original_name || file.file_name} query={filters.q || ""} /></button><small title={file.description}>{file.file_size ? `${formatBytes(file.file_size)} · ` : ""}{file.description || "暂无描述"}</small></div>
              <span className="collection-name hide-md"><i className="dot" style={{ background: toneFor(file.collection_name) }} /><span title={file.collection_name}><Highlight text={file.collection_name} query={filters.q || ""} /></span></span>
              <span className="muted hide-md">{strategyLabel(file.chunk_strategy)}</span>
              <span className={`status status-${file.status}`}>{statusLabel(file.status)}</span>
              <span className="muted hide-md" title={file.created_time}>{relativeTime(file.created_time)}</span>
              <div className="row-actions"><button type="button" className="row-action preview-action" onClick={() => openPreview(file)} aria-label={`预览 ${file.original_name}`}>预览</button><button type="button" className="row-action" onClick={() => openInfo(file)} aria-label={`文件信息 ${file.original_name}`}>信息</button><button type="button" className="row-action chunk-action" onClick={() => openChunk(file)} aria-label={`分片解析 ${file.original_name}`}>分片</button><a className="download" href={file.file_url} aria-label={`下载 ${file.original_name}`} title="下载原文件"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 12v2h10v-2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></a></div>
            </div>)}
            {!loading && !error && pageInfo && pageInfo.total > 0 && <div className="pager"><span className="muted">第 {pageInfo.page} / {pageInfo.pages} 页 · 共 {pageInfo.total} 份</span><div className="pager-actions"><button className="btn btn-line" type="button" disabled={pageInfo.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: pageInfo.page - 1 }))}>上一页</button><button className="btn btn-line" type="button" disabled={pageInfo.page >= pageInfo.pages} onClick={() => setFilters((current) => ({ ...current, page: pageInfo.page + 1 }))}>下一页</button></div></div>}
          </section>
          <p className="ledger-note">原文件与文件信息独立管理。图片支持 PNG、JPG、JPEG、WebP 和 GIF。</p>
          </>}
          <AssistantDialog open={view === "assistant"} onClose={() => setView("files")} onToast={pushToast} />
          <Text2SqlDialog open={view === "sql"} onClose={() => setView("files")} onToast={pushToast} />
          <Text2EchartsDialog open={view === "charts"} onClose={() => setView("files")} />
        </main>
      </div>
      {dragging && <div className="drop-veil"><div><strong>将文件放到这里</strong><p>松开后选择集合，确认再上传。</p></div></div>}
      <UploadDialog open={uploadOpen} collections={collections} preferredCollection={filters.collectionName || ""} initialFile={droppedFile} onClose={closeUpload} onPreview={(f) => openPreview(f, false)} onInfo={openInfo} operators={operators} onAddOperator={addOperator} onRenameOperator={renameOperatorById} onUploaded={(file, message) => {
        setHighlightId(file.id); setQuery(""); setFilters({ ...DEFAULT_FILTERS, collectionName: file.collection_name }); setRevision((value) => value + 1); pushToast("ok", message || "文件已上传");
      }} />
      <FileDrawer
        id={selectedId}
        collections={collections}
        onClose={closeInfo}
        onPreview={(f) => openPreview(f, false)}
        onChunk={openChunk}
        onEditContent={(f) => {
          closeInfo();
          openPreview(f, true);
        }}
        operators={operators}
        onAddOperator={addOperator}
        onRenameOperator={renameOperatorById}
        onChanged={(updated) => {
          setRevision((v) => v + 1);
          if (previewFile?.id === updated.id) setPreviewFile(updated);
        }}
        onDeleted={() => {
          setSelectedId(null);
          setRevision((value) => value + 1);
        }}
        onToast={pushToast}
      />
      <ChunkDialog file={chunkFile} storageMode={stats?.storage_mode} onClose={closeChunk} onToast={pushToast} />
      <FilePreview
        file={previewFile}
        initialEditMode={previewEditMode}
        onClose={closePreview}
        onInfo={openInfo}
        onFileUpdated={(updated) => {
          setRevision((v) => v + 1);
          setPreviewFile(updated);
        }}
        onToast={pushToast}
      />
      <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast${toast.kind === "err" ? " err" : ""}`}>{toast.text}</div>)}</div>
    </div>
  );
}
