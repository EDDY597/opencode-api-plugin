// Unit tests for the `opencode run` CLI backend adapter.
//
// These cover the pure mapping logic only: prompt flattening, NDJSON event absorption and
// failure classification. Spawning the real CLI is deliberately out of scope — it is slow,
// needs the opencode binary and a live network entitlement.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  absorbCliEvent,
  buildCliPrompt,
  cliFailureText,
  contentToText,
  normalizeCliModel,
  onlyErrorText,
  parseCliLine,
  type CliRunResult,
} from "../src/opencode-local/cli-backend.ts"

function emptyResult(): CliRunResult {
  return {
    text: "",
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, total: 0 },
    cost: 0,
    toolCalls: [],
    finishReason: "stop",
  }
}

test("contentToText flattens strings and content parts", () => {
  assert.equal(contentToText("hello"), "hello")
  assert.equal(
    contentToText([
      { type: "text", text: "a" },
      { type: "image", source: {} },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  )
  assert.equal(contentToText(null), "")
  assert.equal(contentToText(42), "42")
})

test("buildCliPrompt sends a lone user message verbatim", () => {
  const prompt = buildCliPrompt([{ role: "user", content: "  reply with exactly: PONG  " }])
  assert.equal(prompt, "reply with exactly: PONG")
})

test("buildCliPrompt replays history as a transcript", () => {
  const prompt = buildCliPrompt([
    { role: "system", content: "Be terse." },
    { role: "user", content: "My name is Bob." },
    { role: "assistant", content: "Noted." },
    { role: "user", content: "What is my name?" },
  ])
  assert.match(prompt, /\[system instructions\]\nBe terse\./)
  assert.match(prompt, /user: My name is Bob\./)
  assert.match(prompt, /assistant: Noted\./)
  assert.match(prompt, /user: What is my name\?/)
  // The scaffold must ask for the assistant turn only, not a continued transcript.
  assert.match(prompt, /conversation transcript/)
})

test("buildCliPrompt drops tool turns instead of replaying them", () => {
  const prompt = buildCliPrompt([
    { role: "user", content: "list files" },
    { role: "assistant", content: "running" },
    { role: "tool", content: "file-a\nfile-b" },
    { role: "user", content: "thanks" },
  ])
  assert.doesNotMatch(prompt, /file-a/)
  assert.match(prompt, /user: thanks/)
})

test("buildCliPrompt skips empty messages", () => {
  const prompt = buildCliPrompt([
    { role: "user", content: "   " },
    { role: "user", content: "real question" },
  ])
  assert.equal(prompt, "real question")
})

test("parseCliLine ignores banner noise and bad JSON", () => {
  assert.equal(parseCliLine("> build · big-pickle"), undefined)
  assert.equal(parseCliLine("{not json"), undefined)
  assert.deepEqual(parseCliLine('{"type":"text"}'), { type: "text" })
})

test("absorbCliEvent accumulates text, usage, cost and tools", () => {
  const acc = emptyResult()
  absorbCliEvent(acc, {
    type: "text",
    sessionID: "ses_1",
    part: { type: "text", text: "Hello" },
  })
  absorbCliEvent(acc, {
    type: "text",
    part: { type: "text", text: " world" },
  })
  absorbCliEvent(acc, {
    type: "tool_use",
    part: { type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "a\nb" } },
  })
  absorbCliEvent(acc, {
    type: "step_finish",
    part: {
      reason: "stop",
      cost: 0,
      tokens: { total: 100, input: 10, output: 5, reasoning: 2, cache: { read: 80 } },
    },
  })

  assert.equal(acc.text, "Hello world")
  assert.equal(acc.sessionID, "ses_1")
  assert.equal(acc.cost, 0)
  assert.equal(acc.finishReason, "stop")
  assert.deepEqual(acc.usage, { input: 10, output: 5, reasoning: 2, cacheRead: 80, total: 100 })
  assert.equal(acc.toolCalls.length, 1)
  assert.equal(acc.toolCalls[0].name, "bash")
  assert.equal(acc.toolCalls[0].output, "a\nb")
})

test("absorbCliEvent sums usage across multiple steps", () => {
  const acc = emptyResult()
  absorbCliEvent(acc, { type: "step_finish", part: { tokens: { total: 10, input: 4, output: 2 } } })
  absorbCliEvent(acc, { type: "step_finish", part: { tokens: { total: 20, input: 6, output: 3 } } })
  assert.equal(acc.usage.input, 10)
  assert.equal(acc.usage.output, 5)
  assert.equal(acc.usage.total, 30)
})

test("normalizeCliModel adds the opencode provider when missing", () => {
  assert.equal(normalizeCliModel("big-pickle"), "opencode/big-pickle")
  assert.equal(normalizeCliModel("opencode/big-pickle"), "opencode/big-pickle")
  assert.equal(normalizeCliModel(""), "opencode/big-pickle")
  assert.equal(normalizeCliModel(undefined, "opencode/x"), "opencode/x")
})

test("cliFailureText recognises the CLI's synthesized provider errors", () => {
  assert.match(cliFailureText("Unexpected server error. Check server logs for details.", "") ?? "", /Unexpected server error/)
  assert.match(cliFailureText("Free usage limit reached. Subscribe to OpenCode Go", "") ?? "", /Free usage limit/)
  assert.equal(cliFailureText("The answer is 42.", ""), undefined)
})

test("cliFailureText falls back to stderr only when there is no text", () => {
  assert.match(cliFailureText("", "Error: spawn failed") ?? "", /spawn failed/)
  // Successful runs write banners to stderr; that must not count as a failure.
  assert.equal(cliFailureText("real answer", "banner: welcome"), undefined)
})

test("onlyErrorText distinguishes a pure error notice from a real answer", () => {
  assert.equal(onlyErrorText("Unexpected server error. Check server logs for details."), true)
  assert.equal(onlyErrorText("I listed 12 files; no errors occurred."), false)
  assert.equal(onlyErrorText(""), false)
})
