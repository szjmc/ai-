"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CollectionStat } from "@/lib/types";

type Props = {
  value: string;
  collections: (string | CollectionStat)[];
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  label?: string;
  onChange: (value: string) => void;
};

/** Normalizes collection input so it handles either raw string arrays or CollectionStat objects */
function normalizeList(items: (string | CollectionStat)[]): { name: string; count?: number }[] {
  const map = new Map<string, number | undefined>();
  for (const item of items) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name && !map.has(name)) map.set(name, undefined);
    } else if (item && typeof item.name === "string") {
      const name = item.name.trim();
      if (name && !map.has(name)) map.set(name, item.count);
    }
  }
  return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
}

/** Highlights matching substring like Google Search autocomplete */
function highlightMatch(text: string, query: string) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return text;
  const index = text.toLowerCase().indexOf(trimmed);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <strong className="google-match">{text.slice(index, index + trimmed.length)}</strong>
      {text.slice(index + trimmed.length)}
    </>
  );
}

export function CollectionCombobox({
  value,
  collections,
  disabled,
  required,
  placeholder = "搜索或输入集合名称",
  label = "所属集合",
  onChange,
}: Props) {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const allCollections = useMemo(() => normalizeList(collections), [collections]);

  const query = value.trim();

  // Filter collections by user input (case-insensitive substring)
  const matches = useMemo(() => {
    if (!query) return allCollections;
    return allCollections.filter((item) =>
      item.name.toLowerCase().includes(query.toLowerCase())
    );
  }, [allCollections, query]);

  // Is current value an exact match for an existing collection?
  const exactMatch = useMemo(() => {
    return allCollections.some(
      (item) => item.name.toLowerCase() === query.toLowerCase()
    );
  }, [allCollections, query]);

  // Can show "create new collection" option if user typed something not existing
  const showCreateOption = Boolean(query && !exactMatch);

  // Total items in suggestion list
  const totalItems = matches.length + (showCreateOption ? 1 : 0);

  // Close on outside click
  useEffect(() => {
    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, []);

  // Scroll active item into view
  useEffect(() => {
    if (!open || highlightedIndex < 0 || !listRef.current) return;
    const activeEl = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlightedIndex]);

  function selectCollection(name: string) {
    onChange(name);
    setOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlightedIndex(0);
      } else {
        setHighlightedIndex((prev) => (prev + 1) % Math.max(1, totalItems));
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlightedIndex(Math.max(0, totalItems - 1));
      } else {
        setHighlightedIndex((prev) => (prev <= 0 ? totalItems - 1 : prev - 1));
      }
      return;
    }

    if (event.key === "Enter") {
      if (open && highlightedIndex >= 0) {
        event.preventDefault();
        if (showCreateOption && highlightedIndex === 0) {
          selectCollection(query);
        } else {
          const matchIndex = showCreateOption ? highlightedIndex - 1 : highlightedIndex;
          if (matches[matchIndex]) {
            selectCollection(matches[matchIndex].name);
          }
        }
        return;
      }
      // If pressing enter with typed text and dropdown is open, close dropdown
      if (open) {
        setOpen(false);
      }
      return;
    }

    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setHighlightedIndex(-1);
      }
      return;
    }

    if (event.key === "Tab") {
      setOpen(false);
      setHighlightedIndex(-1);
    }
  }

  return (
    <div
      ref={containerRef}
      className={`google-combobox${open ? " is-open" : ""}${disabled ? " is-disabled" : ""}`}
    >
      <div className="google-combobox-input-wrap">
        <span className="google-search-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle
              cx="6.8"
              cy="6.8"
              r="4.8"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M10.5 10.5L14.2 14.2"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </span>

        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={disabled}
          required={required}
          maxLength={256}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          placeholder={placeholder}
          onFocus={() => {
            setOpen(true);
            setHighlightedIndex(-1);
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setHighlightedIndex(-1);
          }}
          onKeyDown={handleKeyDown}
        />

        {value ? (
          <button
            type="button"
            className="google-clear-btn"
            aria-label="清空集合输入"
            disabled={disabled}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
              setOpen(true);
              setHighlightedIndex(-1);
            }}
          >
            ×
          </button>
        ) : null}

        <button
          type="button"
          className="google-dropdown-btn"
          aria-label={open ? "收起集合列表" : "展开集合列表"}
          disabled={disabled}
          tabIndex={-1}
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              inputRef.current?.focus();
              setOpen(true);
            }
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className="dropdown-chevron"
          >
            <path
              d="M2.5 4.5L6 8L9.5 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {open ? (
        <div className="google-suggestions-panel" role="presentation">
          <ul
            id={listboxId}
            ref={listRef}
            role="listbox"
            aria-label="集合搜索建议"
            className="google-suggestions-list"
          >
            {showCreateOption ? (
              <li
                role="option"
                aria-selected={highlightedIndex === 0}
                className={`google-suggestion-item google-create-option${
                  highlightedIndex === 0 ? " is-active" : ""
                }`}
                onMouseEnter={() => setHighlightedIndex(0)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectCollection(query);
                }}
              >
                <span className="google-item-icon create-icon" aria-hidden="true">
                  ＋
                </span>
                <div className="google-item-content">
                  <span className="google-item-title">
                    创建新集合：<strong>{query}</strong>
                  </span>
                  <span className="google-item-hint">按 Enter 或点击选用新集合名称</span>
                </div>
                <span className="google-item-badge new-badge">新集合</span>
              </li>
            ) : null}

            {matches.map((item, index) => {
              const actualIndex = showCreateOption ? index + 1 : index;
              const isActive = highlightedIndex === actualIndex;
              const isSelected = item.name.toLowerCase() === query.toLowerCase();

              return (
                <li
                  key={item.name}
                  role="option"
                  aria-selected={isActive || isSelected}
                  className={`google-suggestion-item${isActive ? " is-active" : ""}${
                    isSelected ? " is-selected" : ""
                  }`}
                  onMouseEnter={() => setHighlightedIndex(actualIndex)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectCollection(item.name);
                  }}
                >
                  <span className="google-item-icon" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 5H12.5C13.33 5 14 5.67 14 6.5V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>

                  <div className="google-item-content">
                    <span className="google-item-title">
                      {highlightMatch(item.name, query)}
                    </span>
                  </div>

                  {typeof item.count === "number" ? (
                    <span className="google-item-count">{item.count} 份文件</span>
                  ) : (
                    <span className="google-item-badge">已有集合</span>
                  )}
                </li>
              );
            })}

            {!matches.length && !showCreateOption ? (
              <li className="google-suggestion-empty">
                <span>暂无可选集合，可直接输入名称创建</span>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
