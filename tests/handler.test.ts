// Handler-level tests against a mock upstream: routing, headers and protocol
// conversion end to end. Retry behavior gets its own file.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHandler } from "../src/gateway.ts"
import { startMockUpstream, type MockUpstream } from "./helpers.ts"

function handlerFor(baseURL: string) {
  return createHandler({
    upstreams: [{ id: "mock", name: "Mock", prefix: "m", type: "openai", baseURL, apiKey: "key-1" }],
  }).handler
}

function post(handler: (request: Request) => Promise<Response>, path: string, body: any, headers: Record<string, string> = {}) {
  return handler(
    new Request(`http://gw${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
}

test("chat passthrough: prefix routing, auth header and body relay", async () => {
  const upstreamBody = { id: "c1", object: "chat.completion", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }
  const mock: MockUpstream = await startMockUpstream(() => ({ status: 200, body: JSON.stringify(upstreamBody) }))
  try {
    const response = await post(handlerFor(mock.baseURL), "/v1/chat/completions", {
      model: "m/x",
      messages: [{ role: "user", content: "hi" }],
    }, { "x-opencode-session": "sess-9" })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), upstreamBody)
    assert.equal(mock.requests.length, 1)
    assert.equal(mock.requests[0].url, "/chat/completions")
    assert.equal(mock.requests[0].headers.authorization, "Bearer key-1")
    assert.equal(JSON.parse(mock.requests[0].body).model, "x")
  } finally {
    await mock.close()
  }
})

test("messages: anthropic request is converted to chat upstream and back", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 200,
    body: JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }),
  }))
  try {
    const response = await post(handlerFor(mock.baseURL), "/v1/messages", {
      model: "m/x",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(response.status, 200)
    const message = await response.json()
    assert.equal(message.type, "message")
    assert.deepEqual(message.content, [{ type: "text", text: "Hello" }])
    assert.equal(message.stop_reason, "end_turn")
    assert.deepEqual(message.usage, { input_tokens: 2, output_tokens: 3 })
    assert.equal(JSON.parse(mock.requests[0].body).max_tokens, 100)
  } finally {
    await mock.close()
  }
})

test("messages stream: chat SSE becomes anthropic SSE", async () => {
  const sse =
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n"
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: sse,
  }))
  try {
    const response = await post(handlerFor(mock.baseURL), "/v1/messages", {
      model: "m/x",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    const frames = (await response.text()).split("\n\n").filter(Boolean)
    const types = frames.map((frame) => /event: (.+)/.exec(frame)?.[1] ?? null)
    assert.deepEqual(types, [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  } finally {
    await mock.close()
  }
})

test("upstream auth errors relay through once, without retry", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 401,
    body: JSON.stringify({ error: { message: "bad key" } }),
  }))
  try {
    const response = await post(handlerFor(mock.baseURL), "/v1/chat/completions", {
      model: "m/x",
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(response.status, 401)
    assert.equal(mock.requests.length, 1)
    assert.deepEqual(await response.json(), { error: { message: "bad key" } })
  } finally {
    await mock.close()
  }
})

test("unknown model prefixes fall through to the first enabled upstream", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 200,
    body: JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
  }))
  try {
    const response = await post(handlerFor(mock.baseURL), "/v1/chat/completions", {
      model: "some/other",
      messages: [{ role: "user", content: "hi" }],
    })
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(mock.requests[0].body).model, "some/other")
  } finally {
    await mock.close()
  }
})

test("missing model is rejected without touching the upstream", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({ status: 200, body: "{}" }))
  try {
    const response = await post(handlerFor(mock.baseURL), "/v1/chat/completions", { messages: [] })
    assert.equal(response.status, 400)
    assert.equal(mock.requests.length, 0)
  } finally {
    await mock.close()
  }
})
