// Param-rule and reasoning-cache tests.
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildUpstreams, applyParamRules, stripReasoningParams, isParamError, injectReasoningContent, captureReasoningContent } from "../src/gateway.ts"

test("applyParamRules: per-model params, effort map and strip list", () => {
  const [upstream] = buildUpstreams({
    upstreams: [
      {
        id: "u",
        prefix: "u",
        type: "openai",
        baseURL: "http://127.0.0.1:1",
        modelParams: { mdl: { temperature: 0.2, top_p: 0.9 } },
        reasoningEffortMap: { high: "max" },
        stripParams: ["verbosity"],
      },
    ],
  })
  const out = applyParamRules(
    { model: "mdl", temperature: 1, reasoning_effort: "high", verbosity: "low", messages: [] },
    upstream,
    "mdl",
  )
  assert.deepEqual(out, { model: "mdl", temperature: 0.2, top_p: 0.9, reasoning_effort: "max", messages: [] })
})

test("applyParamRules: per-model params only apply to their model", () => {
  const [upstream] = buildUpstreams({
    upstreams: [{ id: "u", prefix: "u", type: "openai", baseURL: "http://127.0.0.1:1", modelParams: { mdl: { temperature: 0.2 } } }],
  })
  const out = applyParamRules({ model: "other", temperature: 1 }, upstream, "other")
  assert.deepEqual(out, { model: "other", temperature: 1 })
})

test("stripReasoningParams: removes every reasoning key and reports the change", () => {
  const { body, changed } = stripReasoningParams({
    reasoning_effort: "high",
    thinking: { type: "disabled" },
    thinking_budget: 100,
    verbosity: "low",
    temperature: 0.5,
  })
  assert.equal(changed, true)
  assert.deepEqual(body, { temperature: 0.5 })
  const clean = stripReasoningParams({ temperature: 0.5 })
  assert.equal(clean.changed, false)
  assert.deepEqual(clean.body, { temperature: 0.5 })
})

test("isParamError: only 400/422 with parameter-ish text", () => {
  assert.equal(isParamError(400, "Unknown parameter: 'thinking'"), true)
  assert.equal(isParamError(422, "参数不支持"), true)
  assert.equal(isParamError(400, "Your api key is invalid"), false)
  assert.equal(isParamError(500, "unknown parameter"), false)
  assert.equal(isParamError(401, "reasoning"), false)
})

test("reasoning cache: capture by tool_call id, inject into later history", () => {
  captureReasoningContent("sess-1", {
    tool_calls: [{ id: "call_a" }, { id: "call_b" }],
    reasoning_content: "why I called",
  })
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_a" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_b" }] },
  ]
  injectReasoningContent(history, "sess-1")
  assert.equal(history[1].reasoning_content, "why I called")
  assert.equal(history[2].reasoning_content, "why I called")
  // Existing reasoning_content is never overwritten.
  const kept = [{ role: "assistant", content: null, tool_calls: [{ id: "call_a" }], reasoning_content: "already" }]
  injectReasoningContent(kept, "sess-1")
  assert.equal(kept[0].reasoning_content, "already")
})

test("reasoning cache: evicts the oldest session past the cap", () => {
  for (let i = 0; i < 201; i++) {
    captureReasoningContent(`bulk-${i}`, { tool_calls: [{ id: "t" }], reasoning_content: `r${i}` })
  }
  const stale = [{ role: "assistant", content: null, tool_calls: [{ id: "t" }] }]
  injectReasoningContent(stale, "bulk-0")
  assert.equal(stale[0].reasoning_content, "")
  const fresh = [{ role: "assistant", content: null, tool_calls: [{ id: "t" }] }]
  injectReasoningContent(fresh, "bulk-200")
  assert.equal(fresh[0].reasoning_content, "r200")
})
