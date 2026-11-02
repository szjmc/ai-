"use client";

import { useMemo, useState } from "react";
import { formatBytes } from "@/lib/format";
import type { BackendFile } from "@/lib/backend-source";

type Props = { files: BackendFile[] };

export function BackendBrowser({ files }: Props) {
  const [activePath, setActivePath] = useState(files[0]?.path ?? "");
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState("");

  const active = files.find((file) => file.path === activePath) ?? files[0];

  const groups = useMemo(() => {
    const map = new Map<string, BackendFile[]>();
    for (const file of files) {
      const list = map.get(file.group) ?? [];
      list.push(file);
      map.set(file.group, list);
    }
    return Array.from(map.entries());
  }, [files]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const hits: { path: string; line: number; text: string }[] = [];
    for (const file of files) {
      file.code.split("\n").forEach((text, index) => {
        if (text.toLowerCase().includes(needle)) {
          hits.push({ path: file.path, line: index + 1, text: text.trim().slice(0, 160) });
        }
      });
    }
    return hits.slice(0, 40);
  }, [files, query]);

  const totalLines = files.reduce((sum, file) => sum + file.lines, 0);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  async function copy() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="zhizhan">
      <header className="topbar">
        <div className="top-inner">
          <div className="brand">
            <img src="/images/seal.jpg" alt="知栈印记" />
            <div>
              <p className="kicker">Backend source</p>
              <h1>知栈入库台</h1>
            </div>
          </div>
          <div className="search" style={{ background: "transparent", border: 0 }}>
            <input
              value={query}
              placeholder="在全部源码里查找，例如 uploadFile、minio_path"
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索源码"
            />
          </div>
          <a className="btn btn-ghost" href="/">
            ← 返回台账
          </a>
        </div>
      </header>

      <div className="workspace source-workspace">
        <aside className="side">
          <div className="panel side-card">
            <div className="panel-label">
              <span>后端目录</span>
              <span>{files.length}</span>
            </div>
            <p className="note" style={{ margin: "0 8px 10px" }}>
              FastAPI 代码原样收录于 <code>backend/</code>，{totalLines} 行 · {formatBytes(totalBytes)}。
            </p>
            {groups.map(([group, list]) => (
              <div key={group}>
                <div className="panel-label">
                  <span>{group}</span>
                </div>
                {list.map((file) => (
                  <button
                    key={file.path}
                    className={`nav-btn${file.path === active?.path ? " active" : ""}`}
                    type="button"
                    onClick={() => setActivePath(file.path)}
                  >
                    <span className="source-dot" />
                    <span className="nav-label" title={file.path}>{file.path}</span>
                  </button>
                ))}
              </div>
            ))}
            <div className="panel-label"><span>配置</span></div>
            <p className="note" style={{ margin: "0 8px 8px" }}>
              MinIO 指向 <code>127.0.0.1:9100</code>（桶 <code>knowledge-base</code>），MySQL 指向 <code>127.0.0.1:3306/test_db</code>。
            </p>
            <figure className="shelf">
              <img src="/images/shelves.jpg" alt="" />
              <figcaption>
                <strong>MinIO + MySQL</strong>
                <span>前后端统一使用 MinIO 桶 knowledge-base 与 MySQL test_db.knowledge_files，无其他数据库。</span>
              </figcaption>
            </figure>
          </div>
        </aside>

        <main className="main">
          <div className="lede">
            <div>
              <p className="kicker">backend/</p>
              <h2>后端源码</h2>
              <p>
                路由、业务层、DAO、SQLAlchemy 模型、Schema、异常与 MinIO 工具，均按你提供的版本入库。原文件可单独下载。
              </p>
            </div>
          </div>

          {matches ? (
            <section className="ledger source-hits" aria-label="搜索结果">
              <div className="panel-label" style={{ margin: 0, padding: "12px 16px 4px" }}>
                <span>命中 {matches.length} 处</span>
                <button className="btn btn-quiet" type="button" onClick={() => setQuery("")}>清除</button>
              </div>
              {matches.length === 0 ? (
                <p className="note" style={{ padding: "8px 16px 16px" }}>没有匹配内容。</p>
              ) : null}
              {matches.map((hit) => (
                <button
                  key={`${hit.path}-${hit.line}`}
                  className="hit"
                  type="button"
                  onClick={() => {
                    setActivePath(hit.path);
                    setQuery("");
                  }}
                >
                  <span className="muted">{hit.path}:{hit.line}</span>
                  <code>{hit.text}</code>
                </button>
              ))}
            </section>
          ) : null}

          {active ? (
            <section className="ledger source-viewer" aria-label="源码内容">
              <div className="source-head">
                <div>
                  <p className="kicker">{active.group}</p>
                  <h3>{active.path}</h3>
                  <p className="muted">{active.note} · {active.lines} 行 · {formatBytes(active.bytes)}</p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-line" type="button" onClick={copy}>
                    {copied ? "已复制" : "复制代码"}
                  </button>
                  <a className="btn btn-primary" href={`/api/backend/file?path=${encodeURIComponent(active.path)}`}>
                    下载原文件
                  </a>
                </div>
              </div>
              <div className="code-block">
                <pre>
                  <code>
                    {active.code.split("\n").map((line, index) => (
                      <span className="code-line" key={index}>
                        <span className="code-no">{String(index + 1).padStart(3, "0")}</span>
                        <span className="code-text">{line || " "}</span>
                      </span>
                    ))}
                  </code>
                </pre>
              </div>
            </section>
          ) : (
            <div className="empty">
              <h3>没有可展示的源码</h3>
              <p>请确认 backend/ 目录存在。</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
