// Fires a free-model request through the gateway while sampling every TCP
// connection owned by the gateway and the opencode backend, so we can tell
// whether the upstream call left via the proxy (127.0.0.1:7897) or went direct.
import { execFileSync } from "node:child_process"

const GATEWAY = "http://127.0.0.1:8787/v1/chat/completions"

function listeningPids(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" })
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`)) continue
      if (!line.includes("LISTENING")) continue
      const cols = line.trim().split(/\s+/)
      pids.add(cols[cols.length - 1])
    }
    return [...pids]
  } catch {
    return []
  }
}

function connectionsOf(pids) {
  const wanted = new Set(pids)
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" })
    const rows = []
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("ESTABLISHED")) continue
      const cols = line.trim().split(/\s+/)
      const pid = cols[cols.length - 1]
      if (!wanted.has(pid)) continue
      const local = cols[1]
      const remote = cols[2]
      if (remote.startsWith("127.0.0.1") || remote.startsWith("[::1]")) continue
      rows.push({ pid, local, remote })
    }
    return rows
  } catch {
    return []
  }
}

const gatewayPids = listeningPids(8787)
const backendPids = listeningPids(10001)
console.log("gateway pids:", gatewayPids.join(","), "| backend pids:", backendPids.join(","))

const samples = []
const timer = setInterval(() => {
  const rows = connectionsOf([...gatewayPids, ...backendPids])
  for (const row of rows) {
    const key = `${row.pid}|${row.remote}`
    if (!samples.some((s) => s.key === key)) samples.push({ key, ...row })
  }
}, 120)

const started = Date.now()
try {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "free/opencode/mimo-v2.6-flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 8,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  console.log(`gateway: status=${res.status} elapsed=${Date.now() - started}ms`)
  console.log("body:", text.slice(0, 300))
} catch (e) {
  console.log("gateway request failed:", e.message)
} finally {
  clearInterval(timer)
}

console.log("\n=== outbound connections observed ===")
if (samples.length === 0) console.log("(none)")
for (const s of samples) console.log(`pid=${s.pid} ${s.local} -> ${s.remote}`)
