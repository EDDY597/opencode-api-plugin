// Lane circuit-breaker tests: a burst of quota-style failures pauses the whole
// upstream so the next request fails fast instead of re-walking the retry ladder,
// a success resets the lane, and client-actionable errors never open it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHandler, breakerState, resetBreakers } from "../src/gateway.ts"
import { startMockUpstream, type MockUpstream } from "./helpers.ts"

const CHAT_OK = { id: "c1", object: "chat.completion", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }
const CHAT_BODY = { model: "m/x", messages: [{ role: "user", content: "hi" }] }

function handlerFor(baseURL: string, extra: Record<string, unknown> = {}) {
  return createHandler({
    token: "",
    upstreams: [{ id: "mock", prefix: "m", type: "openai", baseURL, apiKey: "key-1", ...extra }],
  }).handler
}

function post(handler: (request: Request) => Promise<Response>, body: any = CHAT_BODY) {
  return handler(
    new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

const QUOTA_429 = {
  status: 429,
  headers: { "content-type": "application/json" },
  body: '{"error":{"message":"FreeUsageLimitError: free usage limit reached"}}',
}

test("three consecutive quota 429s open the breaker and the next call fails fast", async () => {
  resetBreakers()
  const mock: MockUpstream = await startMockUpstream(() => QUOTA_429)
  try {
    // One attempt per call keeps each request cheap: the point is the strike count.
    const handler = handlerFor(mock.baseURL, { retry: { attempts: 1, maxDelayMs: 10 } })

    for (let i = 0; i < 3; i++) {
      const response = await post(handler)
      assert.equal(response.status, 429, `call ${i + 1} should relay the upstream 429`)
      assert.equal(response.headers.get("retry-after"), null)
    }
    const hitsBefore = mock.requests.length
    assert.equal(hitsBefore, 3)
    assert.ok(breakerState("mock").openUntil > Date.now(), "breaker should be open after 3 strikes")

    // Fourth call: refused locally, no upstream request at all.
    const fast = await post(handler)
    assert.equal(fast.status, 429)
    const body = await fast.json()
    assert.equal(body.error.code, "UPSTREAM_LANE_PAUSED")
    assert.equal(body.error.retryable, true)
    assert.ok(body.error.message.includes("free usage limit reached"), "must echo the upstream wording")
    assert.ok(Number(fast.headers.get("retry-after")) > 0, "must advertise when to retry")
    assert.equal(mock.requests.length, hitsBefore, "a paused lane must not touch the network")
  } finally {
    await mock.close()
    resetBreakers()
  }
})

test("a success resets the strike count so two failures alone never open the lane", async () => {
  resetBreakers()
  let mode: "fail" | "ok" = "fail"
  const mock: MockUpstream = await startMockUpstream(() =>
    mode === "fail" ? QUOTA_429 : { status: 200, body: JSON.stringify(CHAT_OK) },
  )
  try {
    const handler = handlerFor(mock.baseURL, { retry: { attempts: 1, maxDelayMs: 10 } })
    for (let i = 0; i < 2; i++) await post(handler)
    assert.equal(breakerState("mock").strikes, 2)

    mode = "ok"
    assert.equal((await post(handler)).status, 200)
    assert.equal(breakerState("mock").strikes, 0, "success must clear strikes")
    assert.equal(breakerState("mock").openUntil, 0)

    // Two more failures: still below the threshold because the success reset them.
    mode = "fail"
    for (let i = 0; i < 2; i++) await post(handler)
    assert.equal(breakerState("mock").strikes, 2)
    assert.equal(breakerState("mock").openUntil, 0, "lane must stay closed")
  } finally {
    await mock.close()
    resetBreakers()
  }
})

test("client-actionable errors never count toward the breaker", async () => {
  resetBreakers()
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 422,
    headers: { "content-type": "application/json" },
    body: '{"error":{"message":"context_length_exceeded"}}',
  }))
  try {
    const handler = handlerFor(mock.baseURL, { retry: { attempts: 1, maxDelayMs: 10 } })
    for (let i = 0; i < 5; i++) await post(handler)
    const state = breakerState("mock")
    assert.ok(!state || state.openUntil === 0, "a malformed request must not pause the lane")
    assert.equal(state?.strikes ?? 0, 0)
  } finally {
    await mock.close()
    resetBreakers()
  }
})

test("breaker: false opts a lane out", async () => {
  resetBreakers()
  const mock: MockUpstream = await startMockUpstream(() => QUOTA_429)
  try {
    const handler = handlerFor(mock.baseURL, { retry: { attempts: 1, maxDelayMs: 10 }, breaker: false })
    for (let i = 0; i < 5; i++) await post(handler)
    assert.equal(mock.requests.length, 5, "every call must reach the upstream")
    assert.equal(breakerState("mock"), undefined, "no state should be recorded")
  } finally {
    await mock.close()
    resetBreakers()
  }
})

test("a region-block 403 does not pause the lane (only fingerprint/quota 403s do)", async () => {
  resetBreakers()
  const mock: MockUpstream = await startMockUpstream(() => ({
    status: 403,
    headers: { "content-type": "application/json" },
    body: '{"error":{"message":"RegionError: not available in your country"}}',
  }))
  try {
    const handler = handlerFor(mock.baseURL, { retry: { attempts: 1, maxDelayMs: 10 } })
    for (let i = 0; i < 5; i++) await post(handler)
    const state = breakerState("mock")
    assert.ok(!state || state.openUntil === 0, "one model's region block must not pause the lane")
  } finally {
    await mock.close()
    resetBreakers()
  }
})
