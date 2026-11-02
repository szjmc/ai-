"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChartAnswer, type ChartResult } from "./chart-answer";

type Turn = {
  id: string;
  question: string;
  chartType: string;
  state: "loading" | "ok" | "error";
  error?: string;
  result?: ChartResult;
};

const CHART_TYPES = ["柱状图", "折线图", "饼图"];
const MAX_QUESTION = 300;
const SUGGESTIONS = [
  "统计各个风险等级的人数，并按人数从高到低排序",
  "各疾病类型中高风险人数及占比",
  "最近 3 个月高风险会员数量变化趋势",
];

let turnSeed = 0;
const nextTurnId = () => `turn-${Date.now()}-${turnSeed++}`;

export function Text2EchartsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [chartType, setChartType] = useState(CHART_TYPES[0]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState<"idle" | "on" | "off">("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  const scrollToEnd = useCallback(() => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (turns.length) scrollToEnd();
  }, [turns, scrollToEnd]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const ask = useCallback(async (text: string, type: string) => {
    const id = nextTurnId();
    setTurns((current) => [...current, { id, question: text, chartType: type, state: "loading" }]);
    setBusy(true);
    try {
      const response = await fetch("/api/v1/text2echarts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, echarts_type: type, auto_execute: true, limit: 10 }),
      });
      const data = await response.json() as ChartResult & { detail?: unknown };
      if (!response.ok || !data.success) throw new Error(data.error || "图表生成失败，请检查服务状态。");
      setOnline("on");
      setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, state: "ok", result: data } : turn)));
    } catch (caught) {
      setOnline("off");
      setTurns((current) => current.map((turn) => (turn.id === id
        ? { ...turn, state: "error", error: caught instanceof Error ? caught.message : "图表生成失败" }
        : turn)));
    } finally {
      setBusy(false);
    }
  }, []);

  const send = useCallback(() => {
    const text = question.trim();
    if (!text || busy) return;
    setQuestion("");
    void ask(text, chartType);
    inputRef.current?.focus();
  }, [ask, busy, chartType, question]);

  const retry = useCallback((turn: Turn) => {
    setTurns((current) => current.filter((item) => item.id !== turn.id));
    void ask(turn.question, turn.chartType);
  }, [ask]);

  if (!open) return null;

  const suggestions = turns.length ? [] : SUGGESTIONS;

  return <section className="ana-shell workspace-tool" aria-labelledby="ana-title">
    <header className="ana-header">
      <div className="ana-brand">
        <span className="ana-logo" aria-hidden="true">✦</span>
        <div><h2 id="ana-title">数据分析助手</h2><p>支持问题解析、趋势图、表格和智能报告输出</p></div>
      </div>
      <div className="ana-header-right">
        <span className={`ana-pill${online === "on" ? " on" : online === "off" ? " off" : ""}`} role="status">
          <i aria-hidden="true" />{online === "on" ? "在线" : online === "off" ? "未连接" : "待检测"}
        </span>
        {turns.length > 0 && <button className="btn btn-quiet ana-reset" type="button" onClick={() => setTurns([])}>新对话</button>}
        <button className="icon-btn" type="button" onClick={onClose} aria-label="返回知识文件">←</button>
      </div>
    </header>

    <div className={`ana-scroll${turns.length ? "" : " is-empty"}`} ref={scrollRef}>
      <article className="ana-turn">
        <div className="ana-msg ana-msg-bot">
          <span className="ana-avatar" aria-hidden="true">✦</span>
          <div className="ana-answer">
            <p className="ana-greeting">你好，我是数据分析助手。用一句话描述你想看的数据，我会生成 SQL、图表、数据表和要点报告。</p>
            {suggestions.length > 0 && <div className="ana-suggestions">{suggestions.map((item) => (
              <button key={item} type="button" className="ana-chip" onClick={() => { setQuestion(item); inputRef.current?.focus(); }}>{item}</button>
            ))}</div>}
          </div>
        </div>
      </article>

      {turns.map((turn) => <article className="ana-turn" key={turn.id}>
        <div className="ana-msg ana-msg-user"><p>{turn.question}</p><span className="ana-msg-tag">{turn.chartType}</span></div>
        <div className="ana-msg ana-msg-bot">
          <span className="ana-avatar" aria-hidden="true">✦</span>
          <div className="ana-answer">
            {turn.state === "loading" && <div className="ana-loading" role="status">
              <span className="loading-ring" aria-hidden="true" />
              <div><strong>正在分析数据</strong><p>生成 SQL → 执行查询 → 生成图表与报告，请稍候。</p></div>
            </div>}
            {turn.state === "error" && <div className="ana-error" role="alert">
              <strong>本次分析没有完成</strong><p>{turn.error}</p>
              <button type="button" className="btn btn-line" onClick={() => retry(turn)}>重新生成</button>
            </div>}
            {turn.state === "ok" && turn.result && <ChartAnswer result={turn.result} />}
          </div>
        </div>
      </article>)}
    </div>

    <form className="ana-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="ana-composer-box">
        <label className="sr-only" htmlFor="ana-question">请输入分析问题</label>
        <textarea
          id="ana-question"
          ref={inputRef}
          rows={2}
          maxLength={MAX_QUESTION}
          value={question}
          placeholder="请输入分析问题，例如：最近3个月高血压会员风险变化及干预建议"
          onChange={(event) => setQuestion(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            if (composing.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
        />
        <div className="ana-composer-foot">
          <div className="ana-type-picker" role="group" aria-label="图表类型">
            {CHART_TYPES.map((type) => <button key={type} type="button" className={`ana-type${chartType === type ? " on" : ""}`} aria-pressed={chartType === type} onClick={() => setChartType(type)}>{type}</button>)}
          </div>
          <div className="ana-composer-actions">
            <span className={`ana-counter${question.length >= MAX_QUESTION ? " full" : ""}`}>{question.length} / {MAX_QUESTION}</span>
            <button type="submit" className="btn btn-primary ana-send" disabled={busy || !question.trim()}>{busy ? "生成中…" : "发送提问"}</button>
          </div>
        </div>
      </div>
      <p className="ana-hint">按 Enter 发送，Shift + Enter 换行<span>·</span>生成过程包含 SQL 查询与图表配置生成，请核对生成的 SQL 和结果。</p>
    </form>
  </section>;
}
