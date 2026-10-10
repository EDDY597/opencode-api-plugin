import { createServer } from "node:http"
import { createHandler, loadFileConfig } from "./gateway.ts"

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

const localUpstreams = upstreams.filter((upstream) => upstream.local)

function shutdown(signal: string) {
  console.log(`\n[Gateway] Received ${signal}, shutting down...`)
  for (const upstream of localUpstreams) upstream.local?.killBackend()
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
  for (const upstream of localUpstreams) {
    upstream.local
      ?.warmup()
      .then(() => console.log(`[Gateway] Local OpenCode backend ready for upstream '${upstream.id}'`))
      .catch((error: any) => console.error(`[Gateway] Local backend warmup failed for '${upstream.id}':`, error?.message))
  }
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
