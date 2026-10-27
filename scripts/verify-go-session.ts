// End-to-end proof that the Go preset forwards x-opencode-session through the
// real gateway code path to the real upstream.
//
// Uses createHandler() directly (same function src/standalone.ts wires to the
// HTTP server) with a single `opencode-go` upstream, so nothing is mocked and no
// port is bound. Run with NODE_USE_ENV_PROXY=1 so fetch honors HTTPS_PROXY.
import { createHandler } from "../src/gateway.ts"

const { handler } = createHandler({
  token: "",
  upstreams: [{ id: "opencode-go", name: "OpenCode Go", type: "opencode-go", prefix: "go", enabled: true }],
})

async function call(label: string, body: any, headers: Record<string, string> = {}) {
  const started = Date.now()
  const response = await handler(
    new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
  const text = await response.text()
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`${label.padEnd(34)} HTTP ${response.status} (${elapsed}s) ${text.slice(0, 160).replace(/\n/g, " ")}`)
  return response.status
}

const base = { model: "go/kimi-k3", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 16 }

const a = await call("no caller session", base)
const b = await call("caller names a session", base, { "x-opencode-session": "ses_0000000ffeABCdefGHIJklmn" })
const c = await call("parent_session_id only", { ...base, parent_session_id: "ses_parent00000ffeABCdefGHIJkl" })

console.log()
console.log(`verdict: no-session=${a} named=${b} parent=${c}`)
console.log(a === 200 && b === 200 && c === 200 ? "PASS - all three forwarded a usable session" : "FAIL - see statuses above")
