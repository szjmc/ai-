import assert from "node:assert/strict";
import test from "node:test";
import { extractEchartsOption } from "../src/lib/echarts-option";

const OPTION = {
  title: { text: "营养风险等级统计", left: "center" },
  xAxis: { type: "category", data: ["低风险", "高风险", "中风险"] },
  yAxis: { type: "value", name: "数量" },
  series: [{ name: "数量", type: "bar", data: [25, 14, 11] }],
};

// Shape returned by /api/v1/text2echarts/generate: a list of workflow message
// events whose `answer` is Markdown with an ```echarts fence.
const workflowMessages = [{
  event: "message",
  task_id: "b5374b70-b6c9-43f4-a550-aa63c419100b",
  message_id: "0f11d9a9-1d5e-41ed-beb7-516ce97499a4",
  conversation_id: "3de15e86-8db1-49f9-8145-a5fa3052aacf",
  mode: "advanced-chat",
  answer: "```echarts\n\n" + JSON.stringify(OPTION, null, 2) + "\n\n```",
  metadata: { usage: { total_tokens: 2071, latency: 6.506 }, reasoning: {} },
  created_at: 1793607016,
}];

test("reads the option from a ```echarts fenced workflow answer", () => {
  const option = extractEchartsOption(workflowMessages);
  assert.ok(option);
  assert.deepEqual(option.series, OPTION.series);
  assert.deepEqual(option.xAxis, OPTION.xAxis);
});

test("accepts json, unlabeled and prose-wrapped fences", () => {
  for (const answer of [
    "```json\n" + JSON.stringify(OPTION) + "\n```",
    "```\n" + JSON.stringify(OPTION) + "\n```",
    "这是图表：\n\n```echarts\n" + JSON.stringify(OPTION) + "\n```\n\n如需调整请告诉我。",
    "图表配置如下 " + JSON.stringify(OPTION) + " 请查收",
  ]) {
    assert.deepEqual(extractEchartsOption([{ answer }])?.series, OPTION.series, answer.slice(0, 24));
  }
});

test("walks outputs/data wrappers and stringified JSON", () => {
  assert.ok(extractEchartsOption({ outputs: { chart: JSON.stringify({ series: [{ type: "pie", data: [1] }] }) } }));
  assert.ok(extractEchartsOption({ data: { result: { option: { series: [{ type: "line", data: [] }] } } } }));
  assert.ok(extractEchartsOption([{ answer: JSON.stringify({ answer: "```echarts\n" + JSON.stringify(OPTION) + "\n```" }) }]));
});

test("tolerates trailing commas but never evaluates JavaScript", () => {
  const lenient = '{"series":[{"type":"bar","data":[1,2],},],}';
  assert.deepEqual(extractEchartsOption("```echarts\n" + lenient + "\n```")?.series, [{ type: "bar", data: [1, 2] }]);
  assert.equal(extractEchartsOption("```echarts\n{ series: [{ type: 'bar' }] }\n```"), null);
  assert.equal(extractEchartsOption([{ answer: "抱歉，无法生成图表。" }]), null);
  assert.equal(extractEchartsOption(null), null);
});
