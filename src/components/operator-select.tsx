"use client";

import { useState } from "react";
import type { Operator } from "@/lib/types";

type Props = {
  operators: Operator[];
  value: number;
  disabled?: boolean;
  label: string;
  onChange: (id: number) => void;
  onAdd: (name: string) => Promise<Operator>;
  onRename: (id: number, name: string) => Promise<Operator>;
};

/**
 * Operator picker with inline add / rename. Selecting a person only fills the form;
 * the caller still has to save, so an unsaved change is obvious and reversible.
 */
export function OperatorSelect({ operators, value, disabled, label, onChange, onAdd, onRename }: Props) {
  const [mode, setMode] = useState<"pick" | "add" | "rename">("pick");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = operators.find((operator) => operator.id === value);

  async function submit() {
    const next = name.trim();
    if (!next) { setError("请填写姓名"); return; }
    setBusy(true); setError("");
    try {
      if (mode === "add") {
        const created = await onAdd(next);
        onChange(created.id);
      } else {
        await onRename(value, next);
      }
      setMode("pick"); setName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请重试");
    } finally { setBusy(false); }
  }

  if (mode !== "pick") {
    return (
      <div className="operator-edit">
        <input
          aria-label={mode === "add" ? "新操作人姓名" : "修改操作人姓名"}
          value={name}
          maxLength={20}
          autoFocus
          disabled={busy}
          placeholder={mode === "add" ? "输入新操作人姓名" : "输入新姓名"}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }}
        />
        <div className="operator-edit-actions">
          <button type="button" className="btn btn-primary operator-mini" disabled={busy} onClick={submit}>
            {busy ? "保存中…" : mode === "add" ? "添加并选用" : "保存姓名"}
          </button>
          <button type="button" className="btn btn-line operator-mini" disabled={busy} onClick={() => { setMode("pick"); setError(""); }}>
            取消
          </button>
        </div>
        {error && <p className="operator-error" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <div className="operator-pick">
        <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))}>
          {!current && <option value={value}>操作员 {value}</option>}
          {operators.map((operator) => (
            <option key={operator.id} value={operator.id}>
              {operator.name}{operator.role ? ` · ${operator.role}` : ""}（ID {operator.id}）
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-line operator-mini" disabled={disabled} onClick={() => { setName(""); setMode("add"); }}>
          ＋ 新增
        </button>
        <button type="button" className="btn btn-line operator-mini" disabled={disabled || !current} onClick={() => { setName(current?.name || ""); setMode("rename"); }}>
          改名
        </button>
      </div>
      {error && <p className="operator-error" role="alert">{error}</p>}
    </div>
  );
}
