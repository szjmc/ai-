"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  askRagQuery,
  fetchChatStatus,
  fetchFileList,
  transcribeAudio,
} from "@/lib/client-api";
import { formatBytes, formatTime } from "@/lib/format";
import type { ChatStatus, FileDict, RagQueryResult } from "@/lib/types";
import { useModalDialog } from "./use-modal-dialog";

type Props = {
  open: boolean;
  initialFileId?: string;
  onClose: () => void;
  onToast: (kind: "ok" | "err", text: string) => void;
};

type Tab = "nl" | "form" | "voice";

/** NRS2002 form fields → composed into one Chinese sentence for the backend. */
type FormState = {
  bmi: string;
  weightLoss: string;
  intakeLoss: string;
  age: string;
  inpatient: string;
  disease: string;
  note: string;
};

const EMPTY_FORM: FormState = {
  bmi: "", weightLoss: "", intakeLoss: "", age: "", inpatient: "1", disease: "", note: "",
};

const DISEASE_PRESETS = [
  "良性疾病，正常进食（稳定期慢性病）",
  "慢性病急性发作，需卧床（如 COPD 急性加重）",
  "大手术 / 中风 / ICU，需人工营养",
  "大面积烧伤 / 多器官衰竭，紧急营养",
  "2 型糖尿病稳定期",
  "胃癌术后化疗",
];

/** Fallback only; the real default comes from the backend config (MILVUS_DEFAULT_COLLECTION). */
const DEFAULT_COLLECTION = "rag_knowledge";

function buildQuestion(form: FormState) {
  const parts: string[] = [];
  if (form.age.trim()) parts.push(`${form.age.trim()}岁`);
  parts.push(form.inpatient === "1" ? "住院患者" : "非住院患者");
  if (form.bmi.trim()) parts.push(`BMI ${form.bmi.trim()}`);
  if (form.weightLoss.trim()) parts.push(`近3个月体重下降 ${form.weightLoss.trim()}%`);
  if (form.intakeLoss.trim()) parts.push(`近1周进食量减少 ${form.intakeLoss.trim()}%`);
  if (form.disease.trim()) parts.push(form.disease.trim());
  if (form.note.trim()) parts.push(form.note.trim());
  return `${parts.join("，")}。请根据 NRS2002 规则给出评分与依据。`;
}

function speak(text: string, onDone: () => void) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 1;
  utterance.onend = onDone;
  utterance.onerror = onDone;
  window.speechSynthesis.speak(utterance);
  return true;
}

function resultToSpeech(result: RagQueryResult) {
  const info = result.score_info;
  const risk = info.score >= 3 ? "存在营养风险，建议启动营养支持" : "暂未达到营养风险，建议继续监测";
  return `NRS2002 评分为 ${info.score} 分，${risk}。其中营养状态受损 ${info.nutritional_impairment} 分，疾病严重程度 ${info.disease_severity} 分，年龄 ${info.age} 分。评分依据：${info.basis}`;
}

export function AssistantDialog({ open, initialFileId, onClose, onToast }: Props) {
  const dialog = useModalDialog(open);
  const [tab, setTab] = useState<Tab>("nl");
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [files, setFiles] = useState<FileDict[]>([]);
  const [fileId, setFileId] = useState("");
  const [collection, setCollection] = useState(DEFAULT_COLLECTION);
  const [question, setQuestion] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<RagQueryResult | null>(null);
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);

  // voice
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);

  // ASR custom override settings
  const [showAsrSettings, setShowAsrSettings] = useState(false);
  const [customAsrKey, setCustomAsrKey] = useState("");
  const [customAsrUrl, setCustomAsrUrl] = useState("");
  const [customAsrModel, setCustomAsrModel] = useState("");

  const probe = useCallback(async (signal?: AbortSignal) => {
    setChecking(true);
    try {
      const next = await fetchChatStatus(signal);
      if (!signal?.aborted) setStatus(next);
    } catch {
      if (!signal?.aborted) setStatus(null);
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(""); setResult(null); setElapsed(0);
    setFileId(initialFileId || "");
    probe(controller.signal);
    fetchFileList({ perPage: 50 }, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setFiles(list.items);
        setFileId((current) => current || list.items[0]?.id || "");
      })
      .catch(() => { /* the picker just stays empty */ });
    // Prefer the backend's own MILVUS_DEFAULT_COLLECTION, so the collection actually
    // matches where chunks were written.
    fetchChatStatus(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        const saved = window.localStorage.getItem("kb_milvus_collection");
        setCollection(saved || next.defaults?.collection_name || DEFAULT_COLLECTION);
      })
      .catch(() => {
        const saved = window.localStorage.getItem("kb_milvus_collection");
        if (saved) setCollection(saved);
      });

    setCustomAsrKey(window.localStorage.getItem("kb_custom_asr_key") || "");
    setCustomAsrUrl(window.localStorage.getItem("kb_custom_asr_url") || "");
    setCustomAsrModel(window.localStorage.getItem("kb_custom_asr_model") || "");

    return () => controller.abort();
  }, [open, initialFileId, probe]);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (tab !== "voice") stopRecording(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const activeFile = files.find((file) => file.id === fileId);
  const chatOffline = status ? !status.chat.reachable : false;
  const effectiveAsrReady = Boolean(status?.asr.configured || customAsrKey.trim());
  const asrReady = effectiveAsrReady;

  function saveCustomAsr() {
    window.localStorage.setItem("kb_custom_asr_key", customAsrKey.trim());
    window.localStorage.setItem("kb_custom_asr_url", customAsrUrl.trim());
    window.localStorage.setItem("kb_custom_asr_model", customAsrModel.trim());
    onToast("ok", "自定义 ASR 配置已保存并在本次使用");
    setShowAsrSettings(false);
  }

  function clearCustomAsr() {
    setCustomAsrKey("");
    setCustomAsrUrl("");
    setCustomAsrModel("");
    window.localStorage.removeItem("kb_custom_asr_key");
    window.localStorage.removeItem("kb_custom_asr_url");
    window.localStorage.removeItem("kb_custom_asr_model");
    onToast("ok", "已恢复优先使用后端的 ASR 配置");
  }

  async function submit(text: string) {
    if (!text.trim()) { setError("请先填写或说出患者信息"); return; }
    if (!fileId) { setError("请选择关联的知识文件"); return; }
    if (!collection.trim()) { setError("请填写 Milvus 集合名"); return; }
    window.localStorage.setItem("kb_milvus_collection", collection.trim());

    setRunning(true); setError(""); setResult(null); setElapsed(0);
    try {
      const data = await askRagQuery({
        question: text.trim(), file_id: fileId, collection_name: collection.trim(), top_k: 2,
      });
      setResult(data);
      onToast("ok", `查询完成：NRS2002 ${data.score_info?.score ?? "?"} 分`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "查询失败";
      setError(message);
      onToast("err", message);
    } finally {
      setRunning(false);
    }
  }

  function startRecording() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("当前浏览器不支持录音，请改用文字输入。");
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      setSeconds(0);
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (!blob.size) { setError("没有录到声音，请重试。"); return; }
        setTranscribing(true);
        try {
          const text = await transcribeAudio(blob, "speech.webm", {
            apiKey: customAsrKey || undefined,
            baseUrl: customAsrUrl || undefined,
            model: customAsrModel || undefined,
          });
          setQuestion((current) => (current ? `${current}${text}` : text));
          onToast("ok", "已转写为文字，可直接提交");
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "语音识别失败";
          setError(message);
          onToast("err", message);
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    }).catch(() => setError("无法访问麦克风，请检查浏览器权限。"));
  }

  function stopRecording(silent = false) {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { if (!silent) setError("停止录音失败"); }
    }
  }

  function toggleSpeak() {
    if (speaking) {
      window.speechSynthesis?.cancel();
      setSpeaking(false);
      return;
    }
    if (!result) return;
    if (!("speechSynthesis" in window)) {
      onToast("err", "当前浏览器不支持语音播报");
      return;
    }
    setSpeaking(true);
    speak(resultToSpeech(result), () => setSpeaking(false));
  }

  function close() {
    if (running && !window.confirm("查询仍在后端进行中，关闭不会取消它。确定关闭吗？")) return;
    stopRecording(true);
    window.speechSynthesis?.cancel();
    onClose();
  }

  if (!open) return null;

  return (
    <dialog ref={dialog} className="assistant-dialog" aria-labelledby="assistant-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      <header className="assistant-header">
        <div>
          <p className="kicker">NRS2002 · RAG assistant</p>
          <h2 id="assistant-title">营养风险智能问答</h2>
        </div>
        <div className="assistant-header-right">
          <span className={`assistant-pill${status?.chat.reachable ? " on" : " off"}`} role="status">
            <i />{checking ? "检测中…" : status?.chat.reachable ? "查询服务在线" : "查询服务未连接"}
          </span>
          <button className="icon-btn" type="button" aria-label="关闭问答窗口" onClick={close}>×</button>
        </div>
      </header>

      <div className="assistant-body">
        <aside className="assistant-side">
          <label className="field">
            <span>关联知识文件</span>
            <select value={fileId} onChange={(e) => setFileId(e.target.value)} disabled={running}>
              {!files.length && <option value="">（暂无文件，请先上传并分片）</option>}
              {files.map((file) => (
                <option key={file.id} value={file.id}>{file.original_name}</option>
              ))}
            </select>
            {activeFile && (
              <span className="muted assistant-file-meta">
                {activeFile.file_type.toUpperCase()} · {activeFile.file_size ? formatBytes(activeFile.file_size) : "—"}
              </span>
            )}
          </label>

          <label className="field">
            <span>Milvus 集合名 <b className="required">*</b></span>
            <input
              value={collection}
              maxLength={128}
              disabled={running}
              placeholder={DEFAULT_COLLECTION}
              onChange={(e) => setCollection(e.target.value)}
            />
            <span className="muted">
              必须与后端分片时写入的 Milvus 集合一致（配置项 <code>MILVUS_DEFAULT_COLLECTION</code>），不是知识库的集合名。
            </span>
          </label>

          {chatOffline && (
            <div className="assistant-warn" role="status">
              {status?.chat.reason}
              {status?.chat.hint ? ` · ${status.chat.hint}` : ""}
            </div>
          )}
          <button className="btn btn-line operator-mini" type="button" disabled={checking || running} onClick={() => probe()}>
            重新检测服务
          </button>

          <div className="assistant-note">
            <strong>检索完全在后端</strong>
            <p>
              本页只负责收集输入并转发到 <code>/api/v1/chat/systemRagQuery</code>。
              向量检索、BM25、多路召回、重排与 LLM 生成都由你的 Python 服务完成，前端不参与。
            </p>
          </div>
        </aside>

        <section className="assistant-main">
          <div className="assistant-tabs" role="tablist" aria-label="输入方式">
            <button type="button" role="tab" aria-selected={tab === "nl"} className={tab === "nl" ? "active" : ""} onClick={() => setTab("nl")}>① 自然语言</button>
            <button type="button" role="tab" aria-selected={tab === "form"} className={tab === "form" ? "active" : ""} onClick={() => setTab("form")}>② 表单采集</button>
            <button type="button" role="tab" aria-selected={tab === "voice"} className={tab === "voice" ? "active" : ""} onClick={() => setTab("voice")}>③ 语音输入</button>
          </div>

          {tab === "nl" && (
            <div className="assistant-pane">
              <label className="field">
                <span>患者信息（自然语言）</span>
                <textarea
                  value={question}
                  rows={5}
                  maxLength={2000}
                  disabled={running}
                  placeholder="例：患者女性，65岁，BMI 19.2，2型糖尿病稳定期，近3个月体重从65kg降至62kg（下降4.6%），无进食困难"
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <span className="counter">{question.length}/2000</span>
              </label>
              <button className="btn btn-primary" type="button" disabled={running || !question.trim()} onClick={() => submit(question)}>
                {running ? "查询中…" : "提交查询"}
              </button>
            </div>
          )}

          {tab === "form" && (
            <div className="assistant-pane">
              <div className="assistant-grid">
                <label className="field"><span>年龄</span><input aria-label="年龄" inputMode="numeric" value={form.age} disabled={running} placeholder="65" onChange={(e) => setForm({ ...form, age: e.target.value })} /></label>
                <label className="field"><span>BMI</span><input aria-label="BMI 数值" inputMode="decimal" value={form.bmi} disabled={running} placeholder="19.2" onChange={(e) => setForm({ ...form, bmi: e.target.value })} /></label>
                <label className="field"><span>近3月体重下降(%)</span><input aria-label="近3月体重下降百分比" inputMode="decimal" value={form.weightLoss} disabled={running} placeholder="4.6" onChange={(e) => setForm({ ...form, weightLoss: e.target.value })} /></label>
                <label className="field"><span>近1周进食减少(%)</span><input aria-label="近1周进食减少百分比" inputMode="decimal" value={form.intakeLoss} disabled={running} placeholder="0" onChange={(e) => setForm({ ...form, intakeLoss: e.target.value })} /></label>
                <label className="field"><span>是否住院</span><select aria-label="是否住院" value={form.inpatient} disabled={running} onChange={(e) => setForm({ ...form, inpatient: e.target.value })}><option value="1">住院</option><option value="0">非住院</option></select></label>
                <label className="field"><span>疾病状态</span><select aria-label="疾病状态" value={form.disease} disabled={running} onChange={(e) => setForm({ ...form, disease: e.target.value })}><option value="">请选择（可手填补充）</option>{DISEASE_PRESETS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              </div>
              <label className="field"><span>补充说明</span><textarea aria-label="补充说明" rows={2} value={form.note} disabled={running} placeholder="如：无进食困难；需鼻饲营养" onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
              <div className="assistant-composed">
                <span>将发送的问题</span>
                <p>{buildQuestion(form)}</p>
              </div>
              <button className="btn btn-primary" type="button" disabled={running || !form.age.trim() || !form.bmi.trim()} onClick={() => { const q = buildQuestion(form); setQuestion(q); submit(q); }}>
                {running ? "查询中…" : "用表单数据查询"}
              </button>
            </div>
          )}

          {tab === "voice" && (
            <div className="assistant-pane">
              {!asrReady && (
                <div className="assistant-warn" role="status">
                  语音识别未配置。系统支持：① 直接读取运行中 FastAPI 后端配置；② 提取 <code>backend/.env</code>；③ 或点击下方按钮直接在界面配置。
                </div>
              )}

              <div className="assistant-record">
                <button
                  type="button"
                  className={`record-btn${recording ? " recording" : ""}`}
                  disabled={!asrReady || transcribing || running}
                  onClick={() => (recording ? stopRecording() : startRecording())}
                >
                  {recording ? "■ 停止录音" : "● 开始录音"}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{recording ? `录音中 ${seconds} 秒` : transcribing ? "正在识别…" : "点击后说话，再点停止"}</strong>
                  <span className="muted">音频会转成文字填入下方输入框，再由后端做检索与评分</span>
                </div>
                <button
                  type="button"
                  className="btn btn-line operator-mini"
                  onClick={() => setShowAsrSettings(!showAsrSettings)}
                >
                  {showAsrSettings ? "收起 ASR 设置" : "⚙ ASR 设置"}
                </button>
              </div>

              {/* ASR 配置展示与自定义面板 */}
              {showAsrSettings && (
                <div className="assistant-asr-custom-panel">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <strong>ASR 语音转文字参数配置</strong>
                    <button type="button" className="btn btn-quiet" style={{ fontSize: 11 }} onClick={() => probe()}>
                      ↻ 从后端同步配置
                    </button>
                  </div>
                  <div className="assistant-grid" style={{ marginBottom: 8 }}>
                    <label className="field">
                      <span>API Key（如 sk-xxx）</span>
                      <input
                        type="password"
                        placeholder="输入或粘贴你的 SiliconFlow / 火山 API Key"
                        value={customAsrKey}
                        onChange={(e) => setCustomAsrKey(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>ASR 服务端点 (Base URL)</span>
                      <input
                        placeholder="https://api.siliconflow.cn/v1/audio/transcriptions"
                        value={customAsrUrl}
                        onChange={(e) => setCustomAsrUrl(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>ASR 模型名称</span>
                      <input
                        placeholder="Qwen/Qwen3-ASR-1.7B"
                        value={customAsrModel}
                        onChange={(e) => setCustomAsrModel(e.target.value)}
                      />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    {customAsrKey && (
                      <button type="button" className="btn btn-quiet" style={{ fontSize: 11 }} onClick={clearCustomAsr}>
                        清除自定义，优先使用后端配置
                      </button>
                    )}
                    <button type="button" className="btn btn-primary operator-mini" onClick={saveCustomAsr}>
                      保存设置并应用
                    </button>
                  </div>
                </div>
              )}

              {status?.asr ? (
                <div className="assistant-asr-meta">
                  <span>识别模型 <b>{customAsrModel || status.asr.model || "未配置"}</b></span>
                  <span>配置来源 <b>{customAsrKey ? "浏览器自定义设置" : status.asr.source === "fastapi_backend" ? "FastAPI 后端接口" : status.asr.source === "backend/.env" ? "后端配置文件" : status.asr.source === "env" ? "本地环境变量" : "未检测到"}</b></span>
                  <span>鉴权状态 <b>{customAsrKey || status.asr.has_api_key ? "已配置 API Key" : "未配置 API Key"}</b></span>
                  {status.asr.endpoint ? <span style={{ width: "100%", fontSize: 11, color: "var(--ink-soft)" }}>端点: {customAsrUrl || status.asr.endpoint}</span> : null}
                </div>
              ) : null}
              <label className="field">
                <span>识别出的文字（可修改后提交）</span>
                <textarea value={question} rows={4} maxLength={2000} disabled={transcribing || running} placeholder="录音后此处会出现文字" onChange={(e) => setQuestion(e.target.value)} />
              </label>
              <button className="btn btn-primary" type="button" disabled={running || transcribing || !question.trim()} onClick={() => submit(question)}>
                {running ? "查询中…" : "用这段文字查询"}
              </button>
            </div>
          )}

          {running && (
            <div className="assistant-progress" role="status">
              <span className="loading-ring" />
              <div>
                <strong>后端正在检索并生成…已用时 {elapsed} 秒</strong>
                <span className="muted">嵌入问题向量 → Milvus 检索 → LLM 按 NRS2002 规则评分</span>
              </div>
            </div>
          )}

          {error && !running && (
            <div className="inline-error" role="alert">
              <p>{error}</p>
            </div>
          )}

          {result && !running && (
            <section className="assistant-result" aria-label="评分结果">
              <div className="assistant-score">
                <div>
                  <span>NRS2002 总分</span>
                  <strong>{result.score_info.score}</strong>
                  <em>{result.score_info.score >= 3 ? "存在营养风险" : "暂未达风险阈值"}</em>
                </div>
                <dl>
                  <div><dt>营养状态受损</dt><dd>{result.score_info.nutritional_impairment}</dd></div>
                  <div><dt>疾病严重程度</dt><dd>{result.score_info.disease_severity}</dd></div>
                  <div><dt>年龄</dt><dd>{result.score_info.age}</dd></div>
                </dl>
              </div>

              <div className="assistant-basis">
                <span>评分依据（后端 LLM 生成）</span>
                <p>{result.score_info.basis}</p>
              </div>

              {result.source_basis?.length ? (
                <div className="assistant-sources">
                  <span>命中的规则片段（{result.source_basis.length} 条）</span>
                  <ul>
                    {result.source_basis.map((item, index) => (
                      <li key={index}>
                        <b>{item.file_name || "unknown"}</b>
                        {item.retrieval_type ? <i>{item.retrieval_type}</i> : null}
                        <p>{item.rule_fragment}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="assistant-actions">
                <button className="btn btn-line" type="button" onClick={toggleSpeak}>
                  {speaking ? "■ 停止播报" : "🔊 语音播报"}
                </button>
                {result.query_params?.query_time ? (
                  <span className="muted">查询时间 {formatTime(result.query_params.query_time, true)}</span>
                ) : null}
              </div>
            </section>
          )}
        </section>
      </div>
    </dialog>
  );
}
