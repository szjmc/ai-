"use client";

import { useEffect, useState } from "react";
import { fetchPreview } from "@/lib/client-api";
import { formatBytes } from "@/lib/format";
import type { FileDict, PreviewPayload } from "@/lib/types";

type Props = {
  file: FileDict | null;
  onClose: () => void;
};

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineFormat(value: string) {
  return value
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function renderMarkdown(source: string) {
  const lines = escapeHtml(source).split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inCode = false;
  const code: string[] = [];
  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code.length = 0;
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || ordered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li>${inlineFormat((bullet ?? ordered)![1])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
    } else if (line.startsWith("&gt; ")) {
      html.push(`<blockquote>${inlineFormat(line.slice(5))}</blockquote>`);
    } else {
      html.push(`<p>${inlineFormat(line)}</p>`);
    }
  }
  if (inCode) html.push(`<pre><code>${code.join("\n")}</code></pre>`);
  closeList();
  return html.join("");
}

function prettyText(fileType: string, text: string) {
  if (fileType !== "json") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function PreviewModal({ file, onClose }: Props) {
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mdSource, setMdSource] = useState(false);
  const [wrap, setWrap] = useState(true);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setPreview(null);
    setError("");
    setMdSource(false);
    setLoading(true);
    fetchPreview(file.id)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message || "预览加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    if (!file) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [file, onClose]);

  if (!file) return null;

  const inlineUrl = `/api/v1/file/${file.id}/download?disposition=inline`;
  const text = preview?.kind === "text" ? prettyText(file.file_type, preview.text) : "";
  const lines = text ? text.split("\n") : [];

  return (
    <div className="viewer-overlay" onMouseDown={onClose}>
      <section
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${file.original_name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="viewer-bar">
          <div className="viewer-title">
            <span className="type-seal">{file.file_type || "file"}</span>
            <div>
              <h2 title={file.original_name}>{file.original_name}</h2>
              <p>
                {file.collection_name} · {file.file_size > 0 ? formatBytes(file.file_size) : "大小未知"}
                {preview?.kind === "text" ? ` · ${lines.length} 行` : ""}
              </p>
            </div>
          </div>
          <div className="viewer-actions">
            {preview?.kind === "text" && file.file_type === "md" ? (
              <button className="btn btn-ghost" type="button" onClick={() => setMdSource((value) => !value)}>
                {mdSource ? "渲染视图" : "查看源码"}
              </button>
            ) : null}
            {preview?.kind === "text" && (file.file_type !== "md" || mdSource) ? (
              <button className="btn btn-ghost" type="button" onClick={() => setWrap((value) => !value)}>
                {wrap ? "不换行" : "自动换行"}
              </button>
            ) : null}
            <a className="btn btn-ghost" href={inlineUrl} target="_blank" rel="noreferrer">
              新标签打开
            </a>
            <a className="btn btn-primary" href={file.file_url}>
              下载
            </a>
            <button className="viewer-close" type="button" onClick={onClose} aria-label="关闭预览">
              ×
            </button>
          </div>
        </header>

        <div className="viewer-body">
          {loading ? <p className="viewer-note">正在从 MinIO 读取文件…</p> : null}
          {error ? (
            <div className="viewer-note">
              <strong>预览失败</strong>
              <p>{error}</p>
            </div>
          ) : null}

          {preview?.kind === "pdf" ? (
            <iframe className="viewer-pdf" title={`PDF 预览 ${file.original_name}`} src={`${inlineUrl}#view=FitH`} />
          ) : null}

          {preview?.kind === "text" && file.file_type === "md" && !mdSource ? (
            <article className="viewer-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          ) : null}

          {preview?.kind === "text" && (file.file_type !== "md" || mdSource) ? (
            <pre className={`viewer-code${wrap ? " wrap" : ""}`}>
              <code>
                {lines.map((line, index) => (
                  <span className="code-line" key={index}>
                    <span className="code-no">{index + 1}</span>
                    <span className="code-text">{line || " "}</span>
                  </span>
                ))}
              </code>
            </pre>
          ) : null}

          {preview?.truncated ? <p className="viewer-foot">仅显示前 8000 字，完整内容请下载原文件。</p> : null}

          {preview?.kind === "binary" ? (
            <div className="viewer-note">
              <strong>{file.file_type.toUpperCase()} 暂不支持在线预览</strong>
              <p>Word 与 Excel 文件请下载后用本地软件打开。</p>
              <a className="btn btn-primary" href={file.file_url}>
                下载原文件
              </a>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
