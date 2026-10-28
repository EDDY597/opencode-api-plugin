// Prove the full chain: gateway (Node) -> local oc2api (Go/uTLS) -> zen free.
//
// The point: Node's TLS fingerprint is rejected upstream, but the hop to oc2api is
// plain HTTP on loopback, so it carries no TLS at all. oc2api does the TLS that
// upstream actually checks. If this returns 200, the free lane has a working shape
// that does not depend on spawning the opencode CLI.
import { createHandler } from "../src/gateway.ts"

const { handler } = createHandler({
  token: "",
  upstreams: [
    {
      id: "free-oc2api",
      name: "OpenCode Free via oc2api",
      type: "openai",
      prefix: "free",
      baseURL: "http://127.0.0.1:18090/v1",
      apiKey: "unused",
      protocol: "openai",
      enabled: true,
    },
  ],
})

const started = Date.now()
const response = await handler(
  new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "free/glm-5.3-flash-free",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
    }),
  }),
)
const text = await response.text()
console.log(`gateway -> oc2api: HTTP ${response.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(text.slice(0, 300))

// And the models list, to confirm the gateway can enumerate them through this lane.
const models = await handler(new Request("http://gw/v1/models"))
const json: any = await models.json()
const free = (json?.data ?? []).map((m: any) => m.id).filter((id: string) => id.startsWith("free/"))
console.log(`\n/v1/models free entries: ${free.length}`)
console.log(free.join(", "))
