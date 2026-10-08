// Golden tests for the non-stream protocol converters in src/gateway.ts.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chatToResponses,
  responsesToChat,
  anthropicToChat,
  chatToAnthropic,
  chatToAnthropicRequest,
  anthropicToChatResponse,
} from "../src/gateway.ts"

test("chatToResponses: roles, tools and params", () => {
  const payload = chatToResponses({
    model: "x",
    messages: [
      { role: "system", content: "sys" },
      { role: "developer", content: "dev" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "working", tool_calls: [{ id: "t1", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "42" },
    ],
    temperature: 0.3,
    max_tokens: 128,
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "f" } },
  })
  assert.deepEqual(payload, {
    model: "x",
    input: [
      { role: "system", content: "sys" },
      { role: "system", content: "dev" },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: "working" },
      { type: "function_call", call_id: "t1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "t1", output: "42" },
    ],
    tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "f" },
    temperature: 0.3,
    max_output_tokens: 128,
  })
})

test("responsesToChat: text, reasoning, tool calls and finish mapping", () => {
  const chat = responsesToChat(
    {
      id: "resp_1",
      created_at: 123,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "why" }] },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 4, output_tokens: 9 },
    },
    "m",
  )
  assert.equal(chat.id, "resp_1")
  assert.equal(chat.model, "m")
  // Tool calls take precedence over the incomplete/length finish.
  assert.equal(chat.choices[0].finish_reason, "tool_calls")
  assert.equal(chat.choices[0].message.content, "answer")
  assert.equal(chat.choices[0].message.reasoning_content, "why")
  assert.deepEqual(chat.choices[0].message.tool_calls, [
    { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
  ])
  assert.deepEqual(chat.usage, {
    prompt_tokens: 4,
    completion_tokens: 9,
    total_tokens: 13,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  })
})

test("anthropicToChat: system, blocks, images and tool results", () => {
  const chat = anthropicToChat({
    model: "x",
    system: "be good",
    max_tokens: 10,
    stop_sequences: ["END"],
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "using tool" },
          { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "result" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AB" } },
          { type: "text", text: "and this" },
        ],
      },
    ],
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "f" },
  })
  assert.deepEqual(chat, {
    model: "x",
    messages: [
      { role: "system", content: "be good" },
      {
        role: "assistant",
        content: "using tool",
        tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AB" } },
          { type: "text", text: "and this" },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "result" },
    ],
    max_tokens: 10,
    stop: ["END"],
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "f" } },
  })
})

test("chatToAnthropic: reasoning_content becomes a thinking block", () => {
  const message = chatToAnthropic(
    {
      id: "chatcmpl-9",
      choices: [
        {
          message: { reasoning_content: "because", content: "so", tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    },
    "m",
  )
  assert.equal(message.id, "msg_chatcmpl-9")
  assert.equal(message.type, "message")
  assert.deepEqual(message.content, [
    { type: "thinking", thinking: "because" },
    { type: "text", text: "so" },
    { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
  ])
  assert.equal(message.stop_reason, "tool_use")
  assert.deepEqual(message.usage, { input_tokens: 3, output_tokens: 5 })
})

test("chatToAnthropicRequest: system hoist, tool_result grouping and images", () => {
  const payload = chatToAnthropicRequest({
    model: "x",
    messages: [
      { role: "system", content: "s1" },
      { role: "developer", content: "s2" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "t1", content: "r1" },
      { role: "tool", tool_call_id: "t2", content: [{ type: "text", text: "r2" }] },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,CQ==" } }] },
    ],
    stop: "END",
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "required",
  })
  assert.equal(payload.system, "s1\n\ns2")
  assert.deepEqual(payload.messages, [
    { role: "user", content: "hi" },
    // Empty assistant text is dropped; only the tool_use block survives.
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "r1" },
        { type: "tool_result", tool_use_id: "t2", content: "r2" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "CQ==" } },
      ],
    },
  ])
  assert.deepEqual(payload.stop_sequences, ["END"])
  assert.deepEqual(payload.tools, [{ name: "f", description: undefined, input_schema: { type: "object" } }])
  assert.deepEqual(payload.tool_choice, { type: "any" })
})

test("anthropicToChatResponse: thinking and tool_use become chat fields", () => {
  const chat = anthropicToChatResponse(
    {
      id: "msg_1",
      stop_reason: "max_tokens",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "part" },
        { type: "tool_use", id: "t1", name: "f", input: {} },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
    },
    "m",
  )
  assert.equal(chat.choices[0].finish_reason, "length")
  assert.equal(chat.choices[0].message.content, "part")
  assert.equal(chat.choices[0].message.reasoning_content, "hmm")
  assert.equal(chat.usage.total_tokens, 5)
})
