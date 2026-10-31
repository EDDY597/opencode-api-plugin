import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHandler, loadFileConfig } from "./gateway.ts"
import { startFreeLane, stopFreeLane } from "./free-lane.ts"
import { startOc2apiLane, stopOc2apiLane } from "./oc2api-lane.ts"
import { loopbackHealthy, startLaneWatchdog, type LaneTarget } from "./lane-watchdog.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Set once the lanes are up; cleared by shutdown. */
let stopWatchdog: (() => void) | undefined

const fileConfig = loadFileConfig() ?? {}

if (!process.env.OPENCODE_GO_API_KEY && fileConfig.apiKey) {
  process.env.OPENCODE_GO_API_KEY = String(fileConfig.apiKey)
}
if (!process.env.OPENCODE_GO_GATEWAY_PORT && fileConfig.port) {
  process.env.OPENCODE_GO_GATEWAY_PORT = String(fileConfig.port)
}
if (!process.env.OPENCODE_GO_GATEWAY_HOST && fileConfig.hostname) {
  process.env.OPENCODE_GO_GATEWAY_HOST = String(fileConfig.hostname)
}
if (!process.env.OPENCODE_GO_GATEWAY_TOKEN && fileConfig.token) {
  process.env.OPENCODE_GO_GATEWAY_TOKEN = String(fileConfig.token)
}

const { handler, upstreams } = createHandler({})
const hostname = process.env.OPENCODE_GO_GATEWAY_HOST ?? "127.0.0.1"
const parsedPort = Number(process.env.OPENCODE_GO_GATEWAY_PORT ?? 8787)
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8787

// Disabled upstreams must not spawn backends: a disabled embedded lane would
// otherwise start `opencode serve` at boot and idle there forever (and its
// requests would still burn the machine's free-tier quota if anything local
// pointed at it). Shutdown keeps the unfiltered list: kill what exists.
const localUpstreams = upstreams.filter((upstream) => upstream.local)
const warmableLocalUpstreams = localUpstreams.filter((upstream) => upstream.enabled)

function shutdown(signal: string) {
  console.log(`\n[Gateway] Received ${signal}, shutting down...`)
  for (const upstream of localUpstreams) upstream.local?.killBackend()
  // Stop the watchdog before the lanes so it cannot resurrect one mid-shutdown.
  stopWatchdog?.()
  stopWatchdog = undefined
  // The free lane is a child of this process: stopping the gateway must stop it too, or a
  // stale 18080 survives and the next gateway run reuses a half-dead server.
  stopOc2apiLane()
  stopFreeLane()
  server.close(() => process.exit(0))
  // Fallback if connections keep the server open.
  setTimeout(() => process.exit(0), 3000).unref()
}

const server = createServer(async (request, response) => {
  try {
    const url = `http://${request.headers.host ?? `${hostname}:${port}`}${request.url ?? "/"}`
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const webRequest = new Request(url, {
      method: request.method,
      headers: request.headers as any,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    })
    const webResponse = await handler(webRequest)
    response.statusCode = webResponse.status
    webResponse.headers.forEach((value, key) => response.setHeader(key, value))
    if (webResponse.body) {
      const reader = webResponse.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        response.write(Buffer.from(value))
      }
    }
    response.end()
  } catch (error: any) {
    // A streaming upstream can drop after headers are already flushed. Setting
    // the status then throws ERR_HTTP_HEADERS_SENT, which — inside this async
    // callback — becomes an unhandled rejection and kills the process. Tear the
    // socket down instead so the gateway survives.
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined)
      return
    }
    response.statusCode = 500
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ error: { message: error?.message ?? "server error" } }))
  }
})

server.on("error", (error: any) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Set OPENCODE_GO_GATEWAY_PORT or gateway.config.json "port".`)
    process.exit(1)
  }
  console.error(error)
  process.exit(1)
})

server.listen(port, hostname, () => {
  console.log(`OpenCode Go gateway listening on http://${hostname}:${port}/v1`)
  // Node's fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY/--use-env-proxy
  // was set before the process started, and this host reaches its upstreams only
  // through that proxy: without it every call fails as `fetch failed` (connect
  // timeout) while /v1/models still answers from the local catalog. Say so once,
  // loudly, instead of leaving 502s to explain themselves.
  const proxyEnv = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy
  if (proxyEnv !== undefined && process.env.NODE_USE_ENV_PROXY === undefined) {
    console.warn(
      `[Gateway] HTTPS_PROXY=${proxyEnv} is set but NODE_USE_ENV_PROXY is not: fetch connects directly and upstream calls will fail on a proxied network.`
      + ' Start through start-gateway.cmd or the tray (both set it) instead of a bare `node src/standalone.ts`.',
    )
  }
  for (const upstream of warmableLocalUpstreams) {
    upstream.local
      ?.warmup()
      .then(() => console.log(`[Gateway] Local OpenCode backend ready for upstream '${upstream.id}'`))
      .catch((error: any) => console.error(`[Gateway] Local backend warmup failed for '${upstream.id}':`, error?.message))
  }

  // Both local lanes are children of this process, so their lifetime matches the gateway
  // and no separate autostart entry has to win a race against the DSH plugin's load.
  //
  // Order matters: cli-server is a plain forwarder when pointed at oc2api, so oc2api has
  // to be up first. `lanes` in gateway.config.json decides what runs:
  //
  //   lanes.oc2api     { enabled, port, apiKey }  — bin/oc2api.exe, uTLS to zen
  //   lanes.cliServer  { enabled, port, apiKey? } — src/cli-server.ts, the 18080 shim
  //                                                 the DSH plugin expects
  //
  // Both default to "only when asked". oc2api used to be `enabled !== false`, which made a
  // config without a `lanes` block try to start a network service and then fail on the
  // missing key — a confusing half-start rather than a decision. It also let the key get
  // out of sync with the `free-oc2api` upstream's `apiKey`, and oc2api answers 401 to every
  // request when they differ, so it is now inherited from that upstream unless overridden.
  //
  // The cliServer lane is the one that decides whether an unauthenticated port exists at
  // all, so it never starts implicitly.
  //
  // Node cannot reach zen for free models at all (TLS fingerprint, measured 2026-10-28),
  // so a cliServer lane with no oc2api behind it can only fail; it is started anyway when
  // asked, and its own logs say why a request failed.
  const lanes = (fileConfig as any).lanes ?? {}
  const oc2api: any = lanes.oc2api ?? {}
  const cliLane: any = lanes.cliServer ?? {}

  const oc2apiPort = Number(oc2api.port ?? 18090)
  const oc2apiBase = `http://127.0.0.1:${oc2apiPort}/v1`
  const shimPort = Number(cliLane.port ?? 18080)

  // The upstream that talks to this lane. Its apiKey is what oc2api must accept, so the
  // lane uses the same value unless it is spelled out separately. The lookup is local,
  // case-insensitive and does not depend on whether that upstream is enabled: a config
  // that disables `free-oc2api` still keeps its key, and 18080 can forward to the lane.
  const portSuffix = `:${oc2apiPort}/v1`
  const matchLaneUpstream = (u: any) => {
    const base = String(u?.baseURL ?? "").replace(/\/+$/, "").toLowerCase()
    return String(u?.id ?? "").toLowerCase() === "free-oc2api" || base.endsWith(portSuffix.toLowerCase())
  }
  const freeUpstream: any =
    (fileConfig.upstreams ?? []).find((u: any) => String(u?.id ?? "").toLowerCase() === "free-oc2api") ??
    (fileConfig.upstreams ?? []).find(matchLaneUpstream)
  const oc2apiEnabled = oc2api.enabled === true
  const oc2apiKey = String(oc2api.apiKey ?? freeUpstream?.apiKey ?? "")
  const shimKey = String(cliLane.apiKey ?? oc2apiKey)

  // The gateway's own `free` upstream has to send the same key oc2api expects, or every
  // request 401s. Check before the lane is up, so the message names the config instead of
  // surfacing as an upstream auth error.
  if (oc2apiEnabled && freeUpstream && String(freeUpstream.apiKey ?? "") !== oc2apiKey) {
    console.warn(
      `[Gateway] ${freeUpstream.id}.apiKey does not match lanes.oc2api.apiKey; requests through that upstream will 401. `
      + 'Set them to the same value (or drop one and inherit).',
    )
  }

  const laneLogger = {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
  }
  // `lanes.oc2api.env` reaches oc2api verbatim. That is where its proxy pool lives:
  // PROXY_SUBSCRIPTION_URL turns a Clash/URI subscription into an in-process node pool
  // (health-probed, rotated on 429/403/transport failures) without any proxy client on
  // this machine. Without it oc2api dials directly and `/ip` reports "proxy pool is not
  // configured". Kept in config so the tray, the Run key and a bare shell all agree.
  const oc2apiEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries((oc2api.env ?? {}) as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      oc2apiEnv[String(key)] = String(value)
    }
  }
  const oc2apiOptions = { root: ROOT, port: oc2apiPort, apiKey: oc2apiKey, env: oc2apiEnv, logger: laneLogger }
  const shimOptions = {
    httpBase: oc2apiBase,
    apiKey: oc2apiKey || undefined,
  }

  void (async () => {
    if (oc2apiEnabled) await startOc2apiLane(oc2apiOptions)
    if (cliLane.enabled === true) {
      // Forwarding into a lane that is not up cannot answer, and an unkeyed shim would be
      // an open port on 18080. Both are configuration errors worth refusing loudly.
      if (!oc2apiEnabled || !shimKey) {
        laneLogger.warn(
          `[Gateway] lanes.cliServer is enabled but ${!oc2apiEnabled ? "lanes.oc2api is not" : "neither lanes.cliServer.apiKey nor lanes.oc2api.apiKey is set"}`
          + '; not starting the 18080 shim.',
        )
      } else {
        await startFreeLane(ROOT, shimPort, laneLogger, shimOptions, shimKey)
      }
    }

    // The DSH plugin judges the free route once, when it loads, and its 60s refresh
    // loop only refreshes the model *listing* -- it does not rebuild the runtime. So a
    // lane that dies while the gateway is up costs the user their free models until they
    // restart DSH. Keep both lanes answering instead; the probes are loopback-only and
    // spend no quota.
    const targets: LaneTarget[] = []
    if (oc2apiEnabled) {
      targets.push({
        name: `oc2api :${oc2apiPort}`,
        check: () => loopbackHealthy(`http://127.0.0.1:${oc2apiPort}/health`),
        restart: async () => {
          stopOc2apiLane()
          await startOc2apiLane(oc2apiOptions)
        },
      })
    }
    if (cliLane.enabled === true && oc2apiEnabled && shimKey) {
      targets.push({
        name: `free shim :${shimPort}`,
        check: () => loopbackHealthy(`http://127.0.0.1:${shimPort}/healthz`),
        restart: async () => {
          stopFreeLane()
          await startFreeLane(ROOT, shimPort, laneLogger, shimOptions, shimKey)
        },
      })
    }
    if (targets.length) {
      const interval = Number(process.env.OPENCODE_LANE_WATCHDOG_MS ?? 30_000)
      stopWatchdog = startLaneWatchdog(targets, laneLogger, Number.isFinite(interval) && interval >= 5_000 ? interval : 30_000)
    }
  })()
})

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

// Keep the gateway alive on stray async errors instead of dying silently and
// taking the tray down with it (which makes clients reconnect in a loop).
process.on("unhandledRejection", (reason) => {
  console.error("[Gateway] Unhandled rejection:", reason)
})
process.on("uncaughtException", (error) => {
  console.error("[Gateway] Uncaught exception:", error)
})
