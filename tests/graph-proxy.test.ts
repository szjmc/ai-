import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { GET, POST } from "../src/app/api/v1/graph/graph_generate/route";
import { POST as INTERRUPT_POST } from "../src/app/api/v1/graph/interrupt/route";
import { POST as RESUME_POST } from "../src/app/api/v1/graph/resume/route";
import { GET as STATE_GET } from "../src/app/api/v1/graph/state/[threadId]/route";
import {
  consumeGraphGenerateStream,
  createInitialGraphState,
  extractChartFromText,
  parseQuestionChartHint,
  splitSseFrames,
} from "../src/lib/graph-stream";

const originalFetch = globalThis.fetch;
const originalFastapiUrl = process.env.FASTAPI_URL;
const originalGraphUrl = process.env.GRAPH_GENERATE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalFastapiUrl === undefined) delete process.env.FASTAPI_URL;
  else process.env.FASTAPI_URL = originalFastapiUrl;
  if (originalGraphUrl === undefined) delete process.env.GRAPH_GENERATE_URL;
  else process.env.GRAPH_GENERATE_URL = originalGraphUrl;
});

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test("POST /api/v1/graph/graph_generate streams SSE directly from upstream FastAPI", async () => {
  process.env.FASTAPI_URL = "http://graph-host:9099";
  let calledUrl = "";
  let sentBody = "";

  const sseChunks = [
    'event: step\ndata: {"type":"step","step":0,"message":"开始处理请求"}\n\n',
    'event: step\ndata: {"type":"step","step":1,"message":"1. 正在生成 SQL..."}\n\n',
    'event: result\ndata: {"type":"result","success":true,"chart_type":"饼图","table":{"columns":["风险等级","人数"],"rows":[["高风险",14]]},"analysis":"**总结**：高风险共 14 人","summary":"高风险共 14 人","echarts_option":{"series":[{"type":"pie","data":[{"name":"高风险","value":14}]}]}}\n\n',
    "data: [DONE]\n\n",
  ];

  globalThis.fetch = (async (input, init) => {
    calledUrl = String(input);
    sentBody = String(init?.body || "");
    return new Response(makeSseStream(sseChunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }) as typeof fetch;

  const req = new Request("http://localhost/api/v1/graph/graph_generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "查询高风险(饼图)" }),
  });

  const res = await POST(req);
  assert.equal(calledUrl, "http://graph-host:9099/api/v1/graph/graph_generate");
  assert.equal(JSON.parse(sentBody).question, "查询高风险(饼图)");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const fullText = await res.text();
  assert.match(fullText, /开始处理请求/);
  assert.match(fullText, /"echarts_option"/);
});

test("GRAPH_GENERATE_URL overrides upstream endpoint and GET forwards cleanly", async () => {
  process.env.GRAPH_GENERATE_URL = "http://custom-agent:8888/api/v1/graph/graph_generate";
  let calledUrl = "";
  globalThis.fetch = (async (input) => {
    calledUrl = String(input);
    return Response.json({ success: true, summary: "完成", echarts_option: { series: [] } });
  }) as typeof fetch;

  const res = await GET(new Request("http://localhost/api/v1/graph/graph_generate?question=查询高风险&stream=false"));
  assert.equal(calledUrl, "http://custom-agent:8888/api/v1/graph/graph_generate");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { success: boolean; summary: string };
  assert.equal(json.success, true);
  assert.equal(json.summary, "完成");
});

test("validates question and chart type and hides internal upstream errors", async () => {
  let upstreamCalled = false;
  globalThis.fetch = (async () => {
    upstreamCalled = true;
    return Response.json({ detail: "Table 'test_db.user_health_risk' failed at 127.0.0.1:8018" }, { status: 500 });
  }) as typeof fetch;

  const emptyRes = await POST(
    new Request("http://localhost/api/v1/graph/graph_generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "   " }),
    }),
  );
  assert.equal(emptyRes.status, 400);

  const badTypeRes = await POST(
    new Request("http://localhost/api/v1/graph/graph_generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "查询高风险", echarts_type: "雷达图" }),
    }),
  );
  assert.equal(badTypeRes.status, 400);
  assert.equal(upstreamCalled, false);

  const upstreamErrRes = await POST(
    new Request("http://localhost/api/v1/graph/graph_generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "查询高风险" }),
    }),
  );
  assert.equal(upstreamErrRes.status, 502);
  const errBody = (await upstreamErrRes.json()) as { error: string };
  assert.doesNotMatch(errBody.error, /test_db|127\.0\.0\.1|8018|FASTAPI/);
  assert.match(errBody.error, /分析服务暂时不可用/);

  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8018");
  }) as typeof fetch;
  const offlineRes = await POST(
    new Request("http://localhost/api/v1/graph/graph_generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "查询高风险" }),
    }),
  );
  assert.equal(offlineRes.status, 503);
  const offlineBody = (await offlineRes.json()) as { error: string };
  assert.doesNotMatch(offlineBody.error, /127\.0\.0\.1|8018/);
});

test("graph-stream parses question hints, split SSE chunks, and embedded echarts fences", async () => {
  assert.deepEqual(parseQuestionChartHint("查询高风险(饼图)"), { cleanQuestion: "查询高风险", chartType: "饼图" });
  assert.deepEqual(parseQuestionChartHint("统计人数（柱状图）"), { cleanQuestion: "统计人数", chartType: "柱状图" });
  assert.deepEqual(parseQuestionChartHint("高龄(70岁以上)患者"), { cleanQuestion: "高龄(70岁以上)患者", chartType: null });

  const { frames, rest } = splitSseFrames('event: step\ndata: {"message":"a"}\n\nevent: step\ndata: {"mes');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "step");
  assert.equal(rest, 'event: step\ndata: {"mes');

  const extracted = extractChartFromText(
    '分析如下：\n\n```echarts\n{"series":[{"type":"pie","data":[{"name":"A","value":1}]}]}\n```\n\n**总结**：完成',
  );
  assert.ok(extracted.echartsOption);
  assert.doesNotMatch(extracted.cleanedMarkdown, /```echarts/);
  assert.match(extracted.cleanedMarkdown, /总结/);

  const snapshots: string[] = [];
  const sseRes = new Response(
    makeSseStream([
      'event: step\ndata: {"type":"step","message":"开始处理请求"}\n\n',
      'event: step\ndata: {"type":"step","message":"1. 正在生成 SQL',
      '..."}\n\nevent: analysis\ndata: {"type":"analysis","table":{"columns":["风险等级","人数"],"rows":[["高风险",14]]},"analysis":"1. 高风险 14 人","summary":"共 14 人"}\n\n',
      'event: chart\ndata: {"type":"chart","chart_type":"饼图","echarts_option":{"series":[{"type":"pie","data":[{"name":"高风险","value":14}]}]}}\n\n',
      'event: step\ndata: {"type":"step","message":"所有步骤完成"}\n\ndata: [DONE]\n\n',
    ]),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

  const finalState = await consumeGraphGenerateStream(sseRes, createInitialGraphState("查询高风险(饼图)"), (s) => {
    snapshots.push(`${s.status}:${s.steps.length}`);
  });

  assert.equal(finalState.status, "done");
  assert.deepEqual(
    finalState.steps.map((s) => s.text),
    ["开始处理请求", "1. 正在生成 SQL...", "所有步骤完成"],
  );
  assert.equal(finalState.table?.rows[0][0], "高风险");
  assert.equal(finalState.summary, "共 14 人");
  assert.ok(finalState.echartsOption);
  assert.ok(snapshots.length >= 4);
});

test("interrupt, resume, and state proxy routes forward cleanly and validate payloads", async () => {
  process.env.GRAPH_GENERATE_URL = "http://custom-agent:8888/api/v1/graph/graph_generate";
  const calls: Array<{ url: string; method?: string; body?: string }> = [];

  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined });
    const url = String(input);
    if (url.endsWith("/interrupt")) {
      return Response.json({ status: 200, data: { thread_id: "t-123", pause_requested: true } });
    }
    if (url.endsWith("/state/t-123")) {
      return Response.json({
        status: 200,
        data: { thread_id: "t-123", checkpoint_id: "cp-9", interrupted: true, history: [] },
      });
    }
    if (url.endsWith("/resume")) {
      return new Response(
        makeSseStream([
          'event: chart\ndata: {"type":"chart","chart_type":"饼图","echarts_option":{"series":[{"type":"pie","data":[{"name":"高风险","value":14}]}]}}\n\n',
          'event: result\ndata: {"type":"result","success":true,"thread_id":"t-123","checkpoint_id":"cp-10","chart_type":"饼图","echarts_option":{"series":[{"type":"pie","data":[{"name":"高风险","value":14}]}]}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const badInt = await INTERRUPT_POST(
    new Request("http://localhost/api/v1/graph/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "" }),
    }),
  );
  assert.equal(badInt.status, 400);

  const okInt = await INTERRUPT_POST(
    new Request("http://localhost/api/v1/graph/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "t-123" }),
    }),
  );
  assert.equal(okInt.status, 200);
  assert.equal(calls[0].url, "http://custom-agent:8888/api/v1/graph/interrupt");

  const stateRes = await STATE_GET(new Request("http://localhost/api/v1/graph/state/t-123"), {
    params: Promise.resolve({ threadId: "t-123" }),
  });
  assert.equal(stateRes.status, 200);
  assert.equal(calls[1].url, "http://custom-agent:8888/api/v1/graph/state/t-123");

  const badAction = await RESUME_POST(
    new Request("http://localhost/api/v1/graph/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "t-123", action: "drop_db" }),
    }),
  );
  assert.equal(badAction.status, 400);

  const resumeRes = await RESUME_POST(
    new Request("http://localhost/api/v1/graph/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "t-123", action: "approve", chart_type: "饼图", human_note: "复核完成" }),
    }),
  );
  assert.equal(resumeRes.status, 200);
  assert.equal(calls[2].url, "http://custom-agent:8888/api/v1/graph/resume");
  assert.match(await resumeRes.text(), /"checkpoint_id":"cp-10"/);
});

test("graph-stream preserves interrupted and cancelled states across [DONE]", async () => {
  const intrStream = new Response(
    makeSseStream([
      'event: meta\ndata: {"type":"meta","thread_id":"t-hil-1"}\n\n',
      'event: step\ndata: {"type":"step","agent":"insight_agent","message":"8. 分析结论生成完成"}\n\n',
      'event: analysis\ndata: {"type":"analysis","table":{"columns":["风险等级","人数"],"rows":[["高风险",14]]},"analysis":"高风险 14 人","summary":"高风险 14 人"}\n\n',
      'event: interrupt\ndata: {"type":"interrupt","interrupted":true,"thread_id":"t-hil-1","checkpoint_id":"cp-5","reason":"human_review","prompt":"请确认图表类型","chart_type":"柱状图","row_count":1,"completed_agents":["sql_agent","data_agent","insight_agent"]}\n\n',
      "data: [DONE]\n\n",
    ]),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

  const intrState = await consumeGraphGenerateStream(intrStream, createInitialGraphState("查询高风险"), () => {});
  assert.equal(intrState.status, "interrupted");
  assert.equal(intrState.threadId, "t-hil-1");
  assert.equal(intrState.checkpointId, "cp-5");
  assert.equal(intrState.interruptInfo?.reason, "human_review");
  assert.deepEqual(intrState.completedAgents, ["sql_agent", "data_agent", "insight_agent"]);
  assert.equal(intrState.table?.rows[0][0], "高风险");

  const cancelStream = new Response(
    makeSseStream([
      'event: cancelled\ndata: {"type":"cancelled","cancelled":true,"thread_id":"t-hil-1","message":"流程已按人工指令终止"}\n\n',
      "data: [DONE]\n\n",
    ]),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  const cancelState = await consumeGraphGenerateStream(cancelStream, intrState, () => {});
  assert.equal(cancelState.status, "cancelled");
  assert.equal(cancelState.interruptInfo, null);
});
