// Mid-stream upstream cuts: a cut after bytes must end the client stream with
// a structured error frame instead of a socket abort, and a cut before the
// first byte must replay the request while that is still safe.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHandler } from "../src/gateway.ts"
import { startMockUpstream, type MockUpstream } from "./helpers.ts"

const SSE = { "content-type": "text/event-stream; charset=utf-8" }

function chunk(delta: any, finishReason: string | null = null) {
  return "data: " + JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "x",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }) + "\n\n"
}

const HEAD = chunk({ role: "assistant", content: "Hel" })
const TAIL = chunk({ content: "lo" }, "stop") + "data: [DONE]\n\n"
const FULL = HEAD + TAIL

function handlerFor(baseURL: string, extra: Record<string, unknown> = {}) {
  return createHandler({
    upstreams: [{ id: "mock", name: "Mock", prefix: "m", type: "openai", baseURL, apiKey: "key-1", ...extra }],
  }).handler
}

function post(handler: (request: Request) => Promise<Response>, path: string, body: any) {
  return handler(new Request(`http://gw${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
}

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<string> {
  assert.ok(body !== null)
  return await new Response(body).text()
}

/** The parsed payload of the last `data:` frame carrying `upstream_truncated`. */
function truncationPayload(text: string): any {
  const frame = text.split("\n\n").find(part => part.includes("upstream_truncated"))
  assert.ok(frame !== undefined, `no truncation frame in ${JSON.stringify(text.slice(-200))}`)
  const line = frame.split("\n").find(part => part.startsWith("data: "))
  assert.ok(line !== undefined)
  return JSON.parse(line.slice(6))
}

const CHAT_BODY = { model: "m/x", messages: [{ role: "user", content: "hi" }], stream: true }

test("a cut after bytes ends with an error frame and [DONE], and is never replayed", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 200,
    headers: SSE,
    body: FULL,
    cutAfterBytes: HEAD.length + 8,
  }))
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 3, maxDelayMs: 10 } }), "/v1/chat/completions", CHAT_BODY)
    assert.equal(response.status, 200)
    const text = await readAll(response.body)
    assert.match(text, /"content":"Hel"/, "the bytes that made it out are relayed")
    const payload = truncationPayload(text)
    assert.equal(payload.error.code, "upstream_truncated", "a structured, parseable error frame replaces the socket abort")
    assert.equal(payload.error.type, "upstream_stream_error")
    assert.ok(text.trimEnd().endsWith("data: [DONE]"), `stream ends with [DONE]: ${JSON.stringify(text.slice(-80))}`)
    assert.equal(mock.requests.length, 1, "partial output is not replayed")
  } finally {
    await mock.close()
  }
})

test("a cut before the first byte replays the request and the client never sees the seam", async () => {
  const mock: MockUpstream = await startMockUpstream((_request, _body, hit) => (
    hit === 1
      ? { status: 200, headers: SSE, body: FULL, cutAfterBytes: 0 }
      : { status: 200, headers: SSE, body: FULL }
  ))
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 3, maxDelayMs: 10 } }), "/v1/chat/completions", CHAT_BODY)
    const text = await readAll(response.body)
    assert.equal(mock.requests.length, 2, "the untouched attempt is replayed")
    assert.match(text, /"content":"Hel"/)
    assert.match(text, /"content":"lo"/)
    assert.ok(!text.includes("upstream_truncated"), "a successful replay surfaces no error")
    assert.ok(text.trimEnd().endsWith("data: [DONE]"))
  } finally {
    await mock.close()
  }
})

test("a spent retry budget still ends the stream cleanly instead of aborting it", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 200,
    headers: SSE,
    body: FULL,
    cutAfterBytes: 0,
  }))
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 1, maxDelayMs: 10 } }), "/v1/chat/completions", CHAT_BODY)
    const text = await readAll(response.body)
    assert.equal(mock.requests.length, 1)
    assert.equal(truncationPayload(text).error.code, "upstream_truncated")
    assert.ok(text.trimEnd().endsWith("data: [DONE]"))
  } finally {
    await mock.close()
  }
})

test("the Anthropic route renders the same cut as an error event", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 200,
    headers: SSE,
    body: FULL,
    cutAfterBytes: HEAD.length + 8,
  }))
  try {
    const response = await post(handlerFor(mock.baseURL), "/v1/messages", {
      model: "m/x",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })
    const text = await readAll(response.body)
    assert.match(text, /event: error/)
    assert.match(text, /upstream_truncated/)
  } finally {
    await mock.close()
  }
})

test("a cut landing mid-frame drops the partial frame instead of shipping invalid JSON", async () => {
  // The upstream dies inside a data frame: everything after HEAD is one
  // unterminated `data:` line. Strict SSE clients (vercel AI SDK among them)
  // parse every event and die on invalid JSON — so the relay must drop the
  // partial frame and end with the structured error event alone.
  const partialFrame = "data: " + JSON.stringify({ id: "c1", object: "chat.completion.chunk", extra: "cut" }).slice(0, 24)
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 200,
    headers: SSE,
    body: HEAD + partialFrame,
    cutAfterBytes: HEAD.length + 12,
  }))
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 3, maxDelayMs: 10 } }), "/v1/chat/completions", CHAT_BODY)
    const text = await readAll(response.body)
    for (const event of text.split("\n\n").filter(part => part.startsWith("data:"))) {
      const payload = event.replace(/^data: ?/m, "")
      if (payload === "[DONE]") continue
      assert.doesNotThrow(() => JSON.parse(payload), `unparseable event shipped to the client: ${JSON.stringify(payload)}`)
    }
    const payload = truncationPayload(text)
    assert.equal(payload.error.code, "upstream_truncated")
    assert.equal(payload.error.retryable, true, "the client must see that a fresh turn is safe")
    assert.equal(mock.requests.length, 1, "bytes were on the wire, no replay")
  } finally {
    await mock.close()
  }
})
