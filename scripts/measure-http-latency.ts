// Measure the latency shape of the HTTP (Go) lane: time-to-first-byte vs total.
//
// The CLI lane cannot do this meaningfully: cli-server synthesizes SSE frames only
// after the full reply is in hand, so its TTFB == total. This script exists to put
// a number on the difference instead of asserting it.
import { createHandler } from "../src/gateway.ts"

const { handler } = createHandler({
  token: "",
  upstreams: [{ id: "opencode-go", name: "OpenCode Go", type: "opencode-go", prefix: "go", enabled: true }],
})

const started = Date.now()
const response = await handler(
  new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "go/kimi-k3",
      stream: true,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: "List the numbers from 1 to 60 in order, separated by spaces. Output nothing else.",
        },
      ],
    }),
  }),
)

const ms = (t: number) => `${(t / 1000).toFixed(2)}s`
console.log(`status ${response.status}  headers at ${ms(Date.now() - started)}`)

if (!response.body) {
  console.log("no body")
  process.exit(0)
}

const reader = response.body.getReader()
let firstChunkAt: number | undefined
let chunks = 0
let bytes = 0
let frames = 0
const decoder = new TextDecoder()

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  if (firstChunkAt === undefined) firstChunkAt = Date.now()
  chunks += 1
  bytes += value.byteLength
  frames += (decoder.decode(value, { stream: true }).match(/data: /g) ?? []).length
}

const total = Date.now() - started
console.log(`first chunk at ${ms((firstChunkAt ?? started) - started)}  total ${ms(total)}`)
console.log(`chunks=${chunks} bytes=${bytes} sse_frames≈${frames}`)
console.log(`ttfb share: ${(((firstChunkAt ?? started) - started) / total * 100).toFixed(0)}% of wall time`)
