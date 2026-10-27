// Session-header tests for the OpenCode Go preset.
//
// Measured 2026-10-27 against https://opencode.ai/zen/go/v1:
//   no session header            -> 400 MissingSessionID
//   x-opencode-session-id only   -> 400 MissingSessionID
//   x-opencode-session: <sha1>   -> 200 (any value works; no id minting needed)
//
// These tests pin that shape so a refactor cannot silently drop the header and
// reintroduce "every Go request fails with 400".
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHandler } from "../src/gateway.ts"
import { startMockUpstream } from "./helpers.ts"

const CHAT_OK = { id: "c1", object: "chat.completion", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }

function goHandler(baseURL: string) {
  return createHandler({
    token: "",
    upstreams: [{ id: "go", prefix: "go", type: "opencode-go", baseURL, apiKey: "oc_sk_test" }],
  }).handler
}

function post(handler: (request: Request) => Promise<Response>, body: any, headers: Record<string, string> = {}) {
  return handler(
    new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
}

const BODY = { model: "go/kimi-k3", messages: [{ role: "user", content: "hi" }] }

test("Go preset always forwards x-opencode-session (the header upstream demands)", async () => {
  const mock = await startMockUpstream(() => ({ status: 200, body: JSON.stringify(CHAT_OK) }))
  try {
    const response = await post(goHandler(mock.baseURL), BODY)
    assert.equal(response.status, 200)
    const sent = mock.requests[0]?.headers ?? {}
    assert.ok(sent["x-opencode-session"], "x-opencode-session must be present on every Go request")
  } finally {
    await mock.close()
  }
})

test("Go preset keeps a caller-named session verbatim", async () => {
  const mock = await startMockUpstream(() => ({ status: 200, body: JSON.stringify(CHAT_OK) }))
  try {
    await post(goHandler(mock.baseURL), BODY, { "x-opencode-session": "ses_0000000ffeABCdefGHIJklmn" })
    assert.equal(mock.requests[0]?.headers["x-opencode-session"], "ses_0000000ffeABCdefGHIJklmn")
  } finally {
    await mock.close()
  }
})

test("a subagent parent_session_id becomes the forwarded session", async () => {
  const mock = await startMockUpstream(() => ({ status: 200, body: JSON.stringify(CHAT_OK) }))
  try {
    await post(goHandler(mock.baseURL), { ...BODY, parent_session_id: "ses_parent00000ffeABCdefGHIJkl" })
    assert.equal(mock.requests[0]?.headers["x-opencode-session"], "ses_parent00000ffeABCdefGHIJkl")
  } finally {
    await mock.close()
  }
})

test("RegionError is fatal: reported once, never retried", async () => {
  const mock = await startMockUpstream(() => ({
    status: 403,
    headers: { "content-type": "application/json" },
    body: '{"type":"error","error":{"type":"RegionError","message":"This model is not available in your country"}}',
  }))
  try {
    // A status of 403 already classifies as fatal; the point of the body match is
    // an upstream that wraps the same refusal in a retryable status instead.
    const response = await post(goHandler(mock.baseURL), BODY)
    assert.equal(response.status, 403)
    assert.equal(mock.requests.length, 1, "a country block must not consume the retry ladder")
  } finally {
    await mock.close()
  }
})

test("a non-Go upstream with sessionHeader mirrors both spellings", async () => {
  // The official client sends `x-opencode-session` and `x-opencode-session-id`
  // together; community probes report the free lane reads whichever it finds.
  // Go is the exception: there only the un-suffixed name is checked, so it must
  // not be the only header an upstream ever sees.
  const mock = await startMockUpstream(() => ({ status: 200, body: JSON.stringify(CHAT_OK) }))
  try {
    const handler = createHandler({
      token: "",
      upstreams: [
        { id: "zen", prefix: "z", type: "openai", baseURL: mock.baseURL, apiKey: "k", sessionHeader: true },
      ],
    }).handler
    await post(handler, { model: "z/some-model", messages: [{ role: "user", content: "hi" }] })
    const sent = mock.requests[0]?.headers ?? {}
    assert.ok(sent["x-opencode-session"], "un-suffixed header is the one upstream requires")
    assert.equal(sent["x-opencode-session-id"], sent["x-opencode-session"])
  } finally {
    await mock.close()
  }
})
