// Streaming converter tests with fixture SSE feeds (chunked mid-frame to
// exercise the SSE parser across socket boundaries).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chatStreamToAnthropic,
  anthropicStreamToChat,
  responsesStreamToChat,
  ThinkTagExtractor,
  THINK_OPEN,
  THINK_CLOSE,
  chatToAnthropic,
} from "../src/gateway.ts"
import { sseStream, collect, frameData } from "./helpers.ts"

function chatChunk(delta: any, extra: any = {}) {
  return (
    "data: " +
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "x",
      choices: [{ index: 0, delta, finish_reason: null, ...extra }],
      ...extra,
    }) +
    "\n\n"
  )
}

const CHAT_STREAM_FIXTURE =
  chatChunk({ role: "assistant", content: "" }) +
  chatChunk({ reasoning_content: "why" }) +
  chatChunk({ content: "Hello" }) +
  chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get", arguments: "" } }] }) +
  chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }) +
  "data: " +
  JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "x",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { completion_tokens: 7 },
  }) +
  "\n\n" +
  "data: [DONE]\n\n"

test("chatStreamToAnthropic: thinking, text and tool blocks in first-seen order", async () => {
  const frames = await collect(chatStreamToAnthropic(sseStream(CHAT_STREAM_FIXTURE), "m"))
  const events = frames.map((frame) => {
    const type = /event: (.+)/.exec(frame)?.[1]
    return { type, data: frameData(frame) }
  })
  assert.deepEqual(
    events.map((entry) => entry.type),
    [
      "message_start",
      "content_block_start", // thinking idx 0
      "content_block_delta",
      "content_block_start", // text idx 1
      "content_block_delta",
      "content_block_start", // tool_use idx 2
      "content_block_delta",
      "content_block_stop",
      "content_block_stop",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  )
  assert.equal(events[1].data.index, 0)
  assert.deepEqual(events[1].data.content_block, { type: "thinking", thinking: "" })
  assert.deepEqual(events[2].data.delta, { type: "thinking_delta", thinking: "why" })
  assert.equal(events[3].data.index, 1)
  assert.deepEqual(events[4].data.delta, { type: "text_delta", text: "Hello" })
  assert.equal(events[5].data.index, 2)
  assert.deepEqual(events[5].data.content_block, { type: "tool_use", id: "call_1", name: "get", input: {} })
  assert.deepEqual(events[6].data.delta, { type: "input_json_delta", partial_json: '{"a":1}' })
  assert.equal(events[10].data.delta.stop_reason, "tool_use")
  assert.deepEqual(events[10].data.usage, { output_tokens: 7 })
  assert.equal(events[11].data.type, "message_stop")
})

test("chatStreamToAnthropic: upstream error frame ends the stream as an error event", async () => {
  const fixture = 'data: {"error":{"type":"overloaded_error","message":"busy"}}\n\ndata: [DONE]\n\n'
  const frames = await collect(chatStreamToAnthropic(sseStream(fixture), "m"))
  // message_start is emitted unconditionally before the loop.
  assert.equal(frames.length, 2)
  assert.equal(/event: (.+)/.exec(frames[0])?.[1], "message_start")
  assert.deepEqual(frameData(frames[1]), { type: "error", error: { type: "overloaded_error", message: "busy" } })
})

// The empty-response fallback: a stream that ends with nothing ever opened
// becomes a protocol-level error instead of a successful empty message.
test("chatStreamToAnthropic: usage-only stream ends as an EMPTY_RESPONSE error", async () => {
  const fixture =
    "data: " +
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "x",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 1 },
    }) +
    "\n\ndata: [DONE]\n\n"
  const frames = await collect(chatStreamToAnthropic(sseStream(fixture), "m"))
  assert.equal(frames.length, 2) // message_start + error
  assert.equal(/event: (.+)/.exec(frames[1])?.[1], "error")
  assert.deepEqual(frameData(frames[1]).error, {
    type: "api_error",
    message: "Upstream returned an empty response",
    code: "EMPTY_RESPONSE",
  })
})

const RESPONSES_STREAM_FIXTURE =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n' +
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"f"}}\n\n' +
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}\n\n' +
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n' +
  'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n' +
  'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":5}}}\n\n' +
  "data: [DONE]\n\n"

test("responsesStreamToChat: tool calls, text, reasoning and final usage", async () => {
  const frames = await collect(responsesStreamToChat(sseStream(RESPONSES_STREAM_FIXTURE), "m"))
  const data = frames.map(frameData)
  assert.equal(data[0].choices[0].delta.role, "assistant") // role first (function_call added)
  assert.deepEqual(data[1].choices[0].delta.tool_calls, [
    { index: 0, id: "call_9", type: "function", function: { name: "f", arguments: "" } },
  ])
  assert.deepEqual(data[2].choices[0].delta.tool_calls, [{ index: 0, function: { arguments: "{}" } }])
  assert.deepEqual(data[3].choices[0].delta, { content: "Hi" })
  assert.deepEqual(data[4].choices[0].delta, { reasoning_content: "think" })
  const final = data[data.length - 2]
  assert.equal(final.choices[0].finish_reason, "tool_calls")
  assert.deepEqual(final.usage, {
    prompt_tokens: 3,
    completion_tokens: 5,
    total_tokens: 8,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  })
  assert.equal(frameData(frames[frames.length - 1]), "[DONE]")
})

const ANTHROPIC_STREAM_FIXTURE =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"f"}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"thinking_delta","thinking":"why"}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'

test("anthropicStreamToChat: tool_use, text and thinking deltas", async () => {
  const frames = await collect(anthropicStreamToChat(sseStream(ANTHROPIC_STREAM_FIXTURE), "m"))
  const data = frames.map(frameData)
  assert.deepEqual(data[0].choices[0].delta, { role: "assistant", content: "" })
  assert.deepEqual(data[1].choices[0].delta.tool_calls, [
    { index: 0, id: "t1", type: "function", function: { name: "f", arguments: "" } },
  ])
  assert.deepEqual(data[2].choices[0].delta.tool_calls, [{ index: 0, function: { arguments: "{}" } }])
  assert.deepEqual(data[3].choices[0].delta, { content: "ok" })
  assert.deepEqual(data[4].choices[0].delta, { reasoning_content: "why" })
  const final = data[data.length - 2]
  assert.equal(final.choices[0].finish_reason, "tool_calls")
  assert.deepEqual(final.usage, { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 })
  assert.equal(frameData(frames[frames.length - 1]), "[DONE]")
})

test("anthropicStreamToChat: error event becomes an error chunk then DONE", async () => {
  const fixture = 'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n\n'
  const frames = await collect(anthropicStreamToChat(sseStream(fixture), "m"))
  assert.deepEqual(frameData(frames[0]), { error: { type: "api_error", message: "boom" } })
  assert.equal(frameData(frames[1]), "[DONE]")
})

// --- inline charted… extraction ------------------------------------------------

function segmentsOf(feed: string[], flush = false) {
  const extractor = new ThinkTagExtractor()
  const out = feed.flatMap((input) => extractor.feed(input))
  if (flush) out.push(...extractor.flush())
  return out
}

test("ThinkTagExtractor: single feed, several segments", () => {
  assert.deepEqual(segmentsOf(["a" + THINK_OPEN + "secret" + THINK_CLOSE + "b"], true), [
    { kind: "text", text: "a" },
    { kind: "reasoning", text: "secret" },
    { kind: "text", text: "b" },
  ])
})

test("ThinkTagExtractor: tag split across deltas never leaks", () => {
  assert.deepEqual(segmentsOf(["Hello " + THINK_OPEN.slice(0, 6), THINK_OPEN.slice(6) + " secret"], true), [
    { kind: "text", text: "Hello " },
    { kind: "reasoning", text: " secret" },
  ])
  // A lookalike that never completes stays literal text.
  assert.deepEqual(segmentsOf(["x<thi", "ink is not a tag"], true), [
    { kind: "text", text: "x" },
    { kind: "text", text: "<thiink is not a tag" },
  ])
})

test("ThinkTagExtractor: unclosed think becomes reasoning at flush", () => {
  assert.deepEqual(segmentsOf(["before " + THINK_OPEN + "hidden"], true), [
    { kind: "text", text: "before " },
    { kind: "reasoning", text: "hidden" },
  ])
})

test("chatToAnthropic: inline think content splits into thinking and text", () => {
  const message = chatToAnthropic(
    {
      id: "chatcmpl-2",
      choices: [{ message: { content: THINK_OPEN + "why" + THINK_CLOSE + "answer" }, finish_reason: "stop" }],
    },
    "m",
  )
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "why" },
    { type: "text", text: "answer" },
  ])
})

test("chatStreamToAnthropic: inline think deltas land in the thinking block", async () => {
  const fixture =
    chatChunk({ content: THINK_OPEN.slice(0, 5) }) +
    chatChunk({ content: THINK_OPEN.slice(5) + " secret" }) +
    chatChunk({ content: THINK_CLOSE + "done" }) +
    "data: " +
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "x",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    "\n\ndata: [DONE]\n\n"
  const frames = await collect(chatStreamToAnthropic(sseStream(fixture), "m"))
  const events = frames.map((frame) => ({
    type: /event: (.+)/.exec(frame)?.[1],
    data: frameData(frame),
  }))
  const starts = events.filter((entry) => entry.type === "content_block_start")
  assert.deepEqual(starts.map((entry) => entry.data.content_block.type), ["thinking", "text"])
  const deltas = events.filter((entry) => entry.type === "content_block_delta")
  assert.deepEqual(deltas.map((entry) => entry.data.delta), [
    { type: "thinking_delta", thinking: " secret" },
    { type: "text_delta", text: "done" },
  ])
  // All blocks closed exactly once.
  assert.equal(events.filter((entry) => entry.type === "content_block_stop").length, 2)
})
