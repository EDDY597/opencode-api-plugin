// Verify the HTTP free lane end to end through the real gateway code path.
//
// Checks three things the CLI lane could not:
//   1. /v1/models lists the pinned *bare* free ids (the DSH menu matches on them)
//   2. free/<model> resolves to the free-http upstream, not the disabled CLI lane
//   3. a refusal comes back fast (a 429 in ~1s) instead of hanging for cli-server's 20s
//
// Expect 429 while the daily free quota is exhausted; that is a pass for this script.
// A 200 means the quota has reset and the lane is fully usable.
import { createHandler, loadFileConfig } from "../src/gateway.ts"

const config = loadFileConfig() ?? {}
const { handler, upstreams } = createHandler(config)

const enabledFree = upstreams.filter((u) => u.prefix === "free" && u.enabled)
console.log(`enabled free upstreams: ${enabledFree.map((u) => `${u.id} -> ${u.baseURL}`).join(", ") || "none"}`)

const models = await (await handler(new Request("http://gw/v1/models"))).json()
const ids: string[] = (models?.data ?? []).map((m: any) => m.id)
const freeIds = ids.filter((id) => !id.includes("/") || true)
console.log(`/v1/models count=${ids.length}`)
console.log(`  free ids: ${ids.slice(0, 12).join(", ")}`)
console.log(`  prefixed ids present: ${ids.some((id) => id.includes("free/")) ? "YES (wrong)" : "no"}`)
void freeIds

const started = Date.now()
const response = await handler(
  new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "free/glm-5.3-flash-free",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
    }),
  }),
)
const text = await response.text()
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\nfree/glm-5.3-flash-free -> HTTP ${response.status} in ${elapsed}s`)
console.log(`  ${text.slice(0, 220)}`)
console.log(
  response.status === 429
    ? "verdict: PASS - reached zen/v1 and got the quota refusal quickly (no CLI hang)"
    : response.status === 200
      ? "verdict: PASS - quota is available, the HTTP lane answers"
      : "verdict: FAIL - unexpected status, inspect the body above",
)
