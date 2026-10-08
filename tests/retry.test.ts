// Retry-executor tests: transient failures are retried with backoff, permanent
// ones fail on the first attempt, Retry-After is honored and clamped, TTFB
// timeouts fail fast, and a started stream is never retried.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHandler } from "../src/gateway.ts"
import { startMockUpstream, type MockUpstream } from "./helpers.ts"

const CHAT_OK = { id: "c1", object: "chat.completion", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }

function handlerFor(baseURL: string, extra: Record<string, unknown> = {}) {
  return createHandler({
    upstreams: [{ id: "mock", prefix: "m", type: "openai", baseURL, apiKey: "key-1", ...extra }],
  }).handler
}

function post(handler: (request: Request) => Promise<Response>, body: any) {
  return handler(
    new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

const CHAT_BODY = { model: "m/x", messages: [{ role: "user", content: "hi" }] }

test("429 twice then 200: retried with backoff and succeeds", async () => {
  let hit = 0
  const mock: MockUpstream = await startMockUpstream(() => {
    hit += 1
    if (hit <= 2) return { status: 429, headers: { "content-type": "application/json" }, body: '{"error":{"message":"rate"}}' }
    return { status: 200, body: JSON.stringify(CHAT_OK) }
  })
  try {
    const started = Date.now()
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 4, maxDelayMs: 120 } }), CHAT_BODY)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), CHAT_OK)
    assert.equal(mock.requests.length, 3)
    // Two backoff rungs at the 120ms ceiling: 240ms ± jitter, minus clock slop.
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 200, `backoff waited only ${elapsed}ms`)
  } finally {
    await mock.close()
  }
})

test("Retry-After is honored and clamped to maxDelayMs", async () => {
  let hit = 0
  const mock: MockUpstream = await startMockUpstream(() => {
    hit += 1
    if (hit === 1) return { status: 429, headers: { "content-type": "application/json", "retry-after": "30" }, body: '{"error":{}}' }
    return { status: 200, body: JSON.stringify(CHAT_OK) }
  })
  try {
    const started = Date.now()
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 2, maxDelayMs: 100 } }), CHAT_BODY)
    assert.equal(response.status, 200)
    assert.equal(mock.requests.length, 2)
    // 30s Retry-After clamped to the 100ms ceiling.
    const elapsed = Date.now() - started
    assert.ok(elapsed < 1500, `retry-after waited ${elapsed}ms, not clamped`)
  } finally {
    await mock.close()
  }
})

test("500 exhausted: every attempt is made, final error relays", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 503,
    body: JSON.stringify({ error: { message: "down" } }),
  }))
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 3, maxDelayMs: 50 } }), CHAT_BODY)
    assert.equal(response.status, 503)
    assert.equal(mock.requests.length, 3)
    assert.deepEqual(await response.json(), { error: { message: "down" } })
  } finally {
    await mock.close()
  }
})

test("connection refused: transport failures retry, then a 502 says so", async () => {
  // Start and immediately close a server so the port is guaranteed refused.
  const mock: MockUpstream = await startMockUpstream(() => ({ status: 200, body: "{}" }))
  const { port } = mock
  await mock.close()
  const handler = handlerFor(`http://127.0.0.1:${port}`, { retry: { attempts: 2, maxDelayMs: 50 } })
  const response = await post(handler, CHAT_BODY)
  assert.equal(response.status, 502)
  const payload = await response.json()
  assert.match(payload.error.message, /connection failed|fetch failed/i)
  assert.equal(payload.error.code, "TRANSPORT")
})

test("TTFB timeout: a hung upstream fails fast and is retried", async () => {
  let hit = 0
  const mock: MockUpstream = await startMockUpstream(async () => {
    hit += 1
    if (hit === 1) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { status: 200, body: JSON.stringify(CHAT_OK) }
    }
    return { status: 200, body: JSON.stringify(CHAT_OK) }
  })
  try {
    const started = Date.now()
    const response = await post(handlerFor(mock.baseURL, { timeoutMs: 60, retry: { attempts: 2, maxDelayMs: 50 } }), CHAT_BODY)
    assert.equal(response.status, 200)
    assert.equal(mock.requests.length, 2)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `hung upstream cost ${elapsed}ms instead of failing fast`)
  } finally {
    await mock.close()
  }
})

test("TTFB timeout exhausted: 504 with TIMEOUT code", async () => {
  const mock: MockUpstream = await startMockUpstream(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { status: 200, body: JSON.stringify(CHAT_OK) }
  })
  try {
    const response = await post(handlerFor(mock.baseURL, { timeoutMs: 60, retry: { attempts: 1 } }), CHAT_BODY)
    assert.equal(response.status, 504)
    const payload = await response.json()
    assert.equal(payload.error.code, "TIMEOUT")
    assert.equal(mock.requests.length, 1)
  } finally {
    await mock.close()
  }
})

test("streamed request: a pre-first-byte 500 is retried, then SSE flows", async () => {
  let hit = 0
  const sse =
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n"
  const mock: MockUpstream = await startMockUpstream(() => {
    hit += 1
    if (hit === 1) return { status: 502, body: "bad gateway" }
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: sse }
  })
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 2, maxDelayMs: 50 } }), {
      ...CHAT_BODY,
      stream: true,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    assert.match(await response.text(), /"Hi"/)
    assert.equal(mock.requests.length, 2)
  } finally {
    await mock.close()
  }
})

test("empty non-stream response: retried as EMPTY_RESPONSE, last body wins", async () => {
  let hit = 0
  const mock: MockUpstream = await startMockUpstream(() => {
    hit += 1
    if (hit === 1) {
      return { status: 200, body: JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ message: { content: "" }, finish_reason: "stop" }] }) }
    }
    return { status: 200, body: JSON.stringify(CHAT_OK) }
  })
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 2, maxDelayMs: 50 } }), CHAT_BODY)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), CHAT_OK)
    assert.equal(mock.requests.length, 2)
  } finally {
    await mock.close()
  }
})

test("param errors: strip-and-retry keeps its immediate one-shot behavior", async () => {
  let hit = 0
  const bodies: any[] = []
  const mock: MockUpstream = await startMockUpstream((_req, body) => {
    hit += 1
    bodies.push(JSON.parse(body))
    if (hit === 1) {
      return { status: 400, body: JSON.stringify({ error: { message: "Unknown parameter: 'reasoning_effort'" } }) }
    }
    return { status: 200, body: JSON.stringify(CHAT_OK) }
  })
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 1 } }), {
      ...CHAT_BODY,
      reasoning_effort: "high",
    })
    assert.equal(response.status, 200)
    assert.equal(mock.requests.length, 2)
    assert.equal(bodies[0].reasoning_effort, "high")
    assert.equal(bodies[1].reasoning_effort, undefined)
  } finally {
    await mock.close()
  }
})

test("auth failures are never retried even with attempts left", async () => {
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 401,
    body: JSON.stringify({ error: { message: "bad key" } }),
  }))
  try {
    const response = await post(handlerFor(mock.baseURL, { retry: { attempts: 5, maxDelayMs: 50 } }), CHAT_BODY)
    assert.equal(response.status, 401)
    assert.equal(mock.requests.length, 1)
  } finally {
    await mock.close()
  }
})
