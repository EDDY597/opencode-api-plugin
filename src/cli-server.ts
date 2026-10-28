import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import {
  normalizeCliModel,
  runCliOnce,
  buildCliPrompt,
  type CliBackendOptions,
  type CliMessage,
} from "./opencode-local/cli-backend.ts"
import { servePrompt, stopServe, serveBaseUrl, quotaBlocked, tripQuotaBreaker, type ServeResult } from "./opencode-local/serve-backend.ts"

/**
 * OpenAI-compatible front end for OpenCode's free models.
 *
 * Two transports, selected with `--transport`:
 *
 *   http (default) — plain HTTPS to zen/v1 with the anonymous free-tier credential.
 *                    Answers in ~1s, real errors (429/403/400) with Retry-After.
 *   cli            — drives the `opencode` CLI (resident `opencode serve`, or one-shot
 *                    runs). Slower and it cannot stream or call tools, but it is the
 *                    official client, so it is the fallback if upstream gates the
 *                    HTTP path for non-official callers.
 *
 * The HTTP transport is a straight forwarder: it sends `Authorization`, a versioned
 * User-Agent, and `stream: true`, and nothing else. It does not fabricate tool
 * declarations or mint session ids to satisfy upstream gates — if those gates are
 * enforced, this transport is supposed to fail loudly rather than route around them.
 *
 *   node src/cli-server.ts [--port 18080] [--transport http|cli]
 */

type Options = CliBackendOptions & {
  port: number
  hostname: string
  /** Keys a client may present. Empty means no auth (loopback only). */
  apiKeys: string[]
  /** `http` forwards to zen/v1; `cli` drives the opencode binary. */
  transport: "http" | "cli"
  /** zen/v1 base for the http transport. */
  httpBaseUrl: string
  /** Free-tier credential. `public` is the anonymous one; no personal key needed. */
  httpKey: string
  /** Sent verbatim; upstream wants an `opencode/<version>` shape. */
  httpUserAgent: string
  /** Keep a warm `opencode serve` backend instead of spawning one CLI per request. */
  useServe: boolean
  /** Port for that backend. */
  servePort: number
  /** Fall back to one-shot runs when the warm backend cannot start. */
  allowFallback: boolean
  /** Additional model ids to advertise on /v1/models (bare names). */
  models: string[]
}

/**
 * Read the accepted keys from a service config.
 *
 * The DSH plugin reads `server_keys[0]` out of `bin/config.json` and sends it on every
 * request, so this service has to accept exactly those keys or every call comes back 401
 * "invalid local API key". Reusing the same file keeps the two in sync with no extra
 * configuration.
 */
function readServerKeys(configPath: string | undefined): string[] {
  if (!configPath) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"))
    const keys = parsed?.server_keys
    if (!Array.isArray(keys)) return []
    return keys.filter((k: any) => typeof k === "string" && k.length > 0)
  } catch {
    return []
  }
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    port: 18081,
    hostname: "127.0.0.1",
    opencodePath: process.env.OPENCODE_CLI_PATH ?? "opencode",
    model: process.env.OPENCODE_CLI_MODEL ?? "opencode/big-pickle",
    autoApprove: true,
    // How long one model call may take. A warm backend answers in 4-5s, so 20s leaves plenty
    // of headroom while keeping a quota wall (where the CLI retries internally and never
    // replies) from holding the client for over a minute. Raise with --timeout if a slow
    // model legitimately needs longer.
    timeoutMs: 20_000,
    dataHome: process.env.OPENCODE_CLI_DATA_HOME,
    cwd: process.env.OPENCODE_CLI_CWD,
    apiKeys: [],
    transport: (process.env.OPENCODE_CLI_TRANSPORT as "http" | "cli") ?? "http",
    httpBaseUrl: process.env.OPENCODE_CLI_HTTP_BASE ?? "https://opencode.ai/zen/v1",
    httpKey: process.env.OPENCODE_CLI_HTTP_KEY ?? "public",
    httpUserAgent: process.env.OPENCODE_CLI_HTTP_UA ?? "opencode/1.19.0",
    useServe: true,
    servePort: Number(process.env.OPENCODE_CLI_SERVE_PORT ?? 10001),
    allowFallback: true,
    models: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[(index += 1)]
    if (arg === "--port") opts.port = Number(next())
    else if (arg === "--hostname") opts.hostname = next()
    else if (arg === "--model") opts.model = next()
    else if (arg === "--opencode-path") opts.opencodePath = next()
    else if (arg === "--cwd") opts.cwd = next()
    else if (arg === "--data-home") opts.dataHome = next()
    else if (arg === "--timeout") opts.timeoutMs = Number(next())
    else if (arg === "--no-auto") opts.autoApprove = false
    else if (arg === "--config") opts.apiKeys = readServerKeys(next())
    else if (arg === "--api-key") opts.apiKeys.push(next())
    else if (arg === "--serve-port") opts.servePort = Number(next())
    else if (arg === "--no-serve") opts.useServe = false
    else if (arg === "--no-fallback") opts.allowFallback = false
    else if (arg === "--models") opts.models = next().split(",")
    else if (arg === "--transport") opts.transport = next() === "cli" ? "cli" : "http"
    else if (arg === "--http-base") opts.httpBaseUrl = next()
    else if (arg === "--http-key") opts.httpKey = next()
    else if (arg === "--http-ua") opts.httpUserAgent = next()
  }
  if (opts.apiKeys.length === 0 && process.env.OPENCODE_CLI_KEYS) {
    opts.apiKeys = process.env.OPENCODE_CLI_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
  }
  return opts
}

function json(res: any, status: number, payload: any) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  })
  res.end(body)
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw.trim()) {
        resolve(undefined)
        return
      }
      try {
        const parsed = JSON.parse(raw)
        // Guard the exact bug that made earlier probes look broken: a body that is a
        // JSON string/array rather than an object must be rejected, not coerced.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("request body must be a JSON object"))
          return
        }
        resolve(parsed)
      } catch (error: any) {
        reject(new Error(`invalid JSON body: ${error?.message ?? "parse error"}`))
      }
    })
    req.on("error", reject)
  })
}

const opts = parseArgs(process.argv.slice(2))

/**
 * The bare model ids this lane advertises.
 *
 * `--models a,b,c` sets them; otherwise the single `--model` is used. They are returned
 * without the `opencode/` prefix because that is how the DSH plugin names its free-tier
 * menu entries, and a prefixed id matches nothing there.
 */
function servedModels(primary: string | undefined): string[] {
  const extra = (opts.models ?? []).map((entry) => entry.trim()).filter(Boolean)
  const bare = (value: string | undefined) => {
    const text = (value ?? "").trim()
    if (!text) return ""
    const slash = text.indexOf("/")
    return slash >= 0 ? text.slice(slash + 1) : text
  }
  const ids = [...extra.map(bare), bare(primary)].filter(Boolean)
  return [...new Set(ids.length ? ids : ["big-pickle"])]
}

/** Cached model discovery for the HTTP transport (which sits in front of oc2api). */
let discoveredCache: { at: number; ids: string[] } | undefined

/**
 * Ask the HTTP upstream for its model list.
 *
 * With `--transport http` this lane is a forwarder, and the upstream (oc2api) already
 * filters to `big-pickle` + `*-free` and refreshes that list itself. Reading it beats
 * pinning ids in the launch arguments, which go stale the moment upstream adds or
 * retires a free model. Any failure returns undefined so the caller falls back to the
 * static list: a listing must always answer, even when the upstream is down.
 */
async function discoveredModels(): Promise<string[] | undefined> {
  if (opts.transport !== "http") return undefined
  const now = Date.now()
  if (discoveredCache && now - discoveredCache.at < 60_000) return discoveredCache.ids
  try {
    const response = await fetch(`${opts.httpBaseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${opts.httpKey}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return undefined
    const body: any = await response.json()
    const ids = (body?.data ?? [])
      .map((entry: any) => (typeof entry === "string" ? entry : entry?.id))
      .filter((id: any) => typeof id === "string" && id.length > 0)
    if (!ids.length) return undefined
    discoveredCache = { at: now, ids }
    return ids
  } catch {
    return undefined
  }
}

/** Flatten a chat message's content to plain text (the upstream takes strings here). */
function messageText(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : part?.type === "text" ? (part.text ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

/** An upstream refusal that kept its HTTP status and Retry-After. */
class UpstreamRefusal extends Error {
  upstreamStatus: number
  retryAfterSeconds?: number
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message)
    this.upstreamStatus = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Drop the `provider/` segment: the CLI wants it, zen/v1 does not. */
function bareModelId(model: string): string {
  const slash = model.indexOf("/")
  return slash >= 0 ? model.slice(slash + 1) : model
}

/**
 * Forward one request to zen/v1 and reassemble the SSE stream.
 *
 * Streaming upstream, buffered locally: that is not a downgrade, it is what the two
 * call sites in this file already do (they synthesize their own SSE frames from the
 * finished text). Asking upstream for `stream: true` keeps us on the path the free
 * tier serves; the caller still gets its answer in one piece.
 */
async function callHttp(messages: CliMessage[], runOptions: Options): Promise<ServeResult> {
  const base = runOptions.httpBaseUrl.replace(/\/+$/, "")
  // `normalizeCliModel` prefixes a bare id with `opencode/` because the CLI needs a
  // provider segment. zen/v1 does not: sending `opencode/glm-5.3-flash-free` there is a
  // 400 "Model is unavailable", which looks like a quota or gate failure but is just a
  // wrong model id.
  const model = bareModelId(normalizeCliModel(runOptions.model))
  const sessionID = `http-${randomUUID().replace(/-/g, "").slice(0, 24)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), runOptions.timeoutMs)

  try {
    let response: Response
    try {
      response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${runOptions.httpKey}`,
          "user-agent": runOptions.httpUserAgent,
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: messages.map((message) => ({ role: message.role, content: messageText(message.content) })),
        }),
        signal: controller.signal,
      })
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw new Error(`upstream did not answer within ${runOptions.timeoutMs}ms (timed out)`)
      }
      throw error
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => "")
      const retryAfterHeader = response.headers.get("retry-after")
      const retryAfter = retryAfterHeader && Number.isFinite(Number(retryAfterHeader))
        ? Number(retryAfterHeader)
        : undefined
      const detail = upstreamDetail(raw)
      throw new UpstreamRefusal(
        `${response.status} ${detail || response.statusText}`,
        response.status,
        retryAfter,
      )
    }

    // A compliant upstream streams; if it ignored `stream`, the body is one JSON object.
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      const json: any = await response.json()
      const message = json?.choices?.[0]?.message ?? {}
      return {
        text: typeof message.content === "string" ? message.content : messageText(message.content),
        usage: usageFromChat(json?.usage),
        cost: 0,
        sessionID,
        finishReason: json?.choices?.[0]?.finish_reason ?? "stop",
      }
    }

    let text = ""
    let finishReason = "stop"
    let usage = usageFromChat(undefined)
    let buffer = ""
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === "[DONE]") continue
          let event: any
          try {
            event = JSON.parse(payload)
          } catch {
            continue
          }
          const choice = event?.choices?.[0]
          const delta = choice?.delta ?? choice?.message
          if (typeof delta?.content === "string") text += delta.content
          if (choice?.finish_reason) finishReason = choice.finish_reason
          if (event?.usage) usage = usageFromChat(event.usage)
        }
      }
    }

    return { text, usage, cost: 0, sessionID, finishReason }
  } finally {
    clearTimeout(timer)
  }
}

/** Map an OpenAI-shaped `usage` block onto this file's ServeResult shape. */
function usageFromChat(usage: any) {
  const input = Number(usage?.prompt_tokens ?? 0)
  const output = Number(usage?.completion_tokens ?? 0)
  return {
    input,
    output,
    reasoning: Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0),
    cacheRead: Number(usage?.prompt_tokens_details?.cached_tokens ?? 0),
    total: Number(usage?.total_tokens ?? input + output),
  }
}

/** Pull a human-readable reason out of an error body. */
function upstreamDetail(raw: string): string {
  try {
    const json = JSON.parse(raw)
    const message = json?.error?.message ?? json?.message
    if (typeof message === "string" && message.trim()) return message.trim()
  } catch {
    void 0
  }
  return raw.trim().slice(0, 300)
}


/**
 * Send one request to a model.
 *
 * The transport decides everything: `http` is a direct zen/v1 call (fast, real status
 * codes), `cli` drives the opencode binary. With `cli`, prefer the persistent
 * `opencode serve` backend — a one-shot `opencode run` costs ~30s per call here, while a
 * warm server answers in 4-5s — and keep the one-shot path as a fallback so the lane
 * degrades in latency rather than failing.
 *
 * This is the only function that reaches a model, so it is the only place quota is spent:
 * nothing here runs on a timer.
 */
async function callModel(messages: CliMessage[], runOptions: Options): Promise<ServeResult | import("./opencode-local/cli-backend.ts").CliRunResult> {
  // The HTTP transport fails fast and reports the real status, so the CLI-era breaker
  // (built to stop a hung binary from holding requests for 20s) does not apply to it.
  if (opts.transport === "http") return callHttp(messages, runOptions)

  // Check the quota breaker before choosing a transport. Putting this only inside the
  // serve path was not enough: when the warm backend is down, the one-shot fallback ran
  // anyway and spent another 30s+ on a window that was already closed.
  const gate = quotaBlocked()
  if (gate.blocked) {
    const minutes = Math.ceil(gate.retryAfterMs / 60_000)
    throw new Error(`${gate.reason} Retry in about ${minutes} minute(s).`)
  }

  if (opts.useServe) {
    try {
      return await servePrompt(
        {
          opencodePath: runOptions.opencodePath,
          port: opts.servePort,
          cwd: runOptions.cwd,
          model: runOptions.model,
        },
        messages,
        opts.timeoutMs,
      )
    } catch (error: any) {
      const message = String(error?.message ?? "")
      // A quota wall or a rejected model does not heal by trying a different transport:
      // re-running one-shot just spends another 30s and fails the same way. Surface it now.
      if (!opts.allowFallback || /free usage|quota|insufficient|not free|subscribe to opencode go|model .*not found|unauthor/i.test(message)) {
        throw error
      }
      process.stderr.write(`[cli-server] fallback to one-shot\n`)
    }
  }
  // The one-shot path has no breaker of its own, and a quota wall there shows up as the
  // CLI's synthesized "Free usage limit reached" text or an exit failure. Arrest it here so
  // the window is not retried request after request.
  try {
    const result = await runCliOnce(messages, runOptions)
    const wall = /free usage limit|subscribe to opencode go/i.test(result.text) ? result.text : undefined
    if (wall) {
      tripQuotaBreaker(wall.slice(0, 200))
      throw new Error(wall.slice(0, 200))
    }
    return result
  } catch (error: any) {
    const message = String(error?.message ?? "")
    if (/free usage limit|subscribe to opencode go|insufficient/i.test(message)) {
      tripQuotaBreaker(message.slice(0, 200))
    }
    throw error
  }
}

function usageFrom(result: any) {
  return {
    prompt_tokens: result.usage.input,
    completion_tokens: result.usage.output,
    total_tokens: result.usage.total || result.usage.input + result.usage.output,
    prompt_tokens_details: { cached_tokens: result.usage.cacheRead },
    completion_tokens_details: { reasoning_tokens: result.usage.reasoning },
  }
}

/** Flatten a Responses API `input` field into the chat message array the CLI expects. */
export function responsesInputToMessages(body: any): CliMessage[] {
  const input = body?.input
  const messages: CliMessage[] = []

  if (typeof body?.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions })
  }

  const pushText = (role: string, content: any) => {
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: any) => (typeof part === "string" ? part : part?.type === "text" || part?.type === "input_text" || part?.type === "output_text" ? part.text ?? "" : ""))
            .filter(Boolean)
            .join("\n")
        : ""
    if (text.trim()) messages.push({ role, content: text })
  }

  if (typeof input === "string") {
    pushText("user", input)
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const role = item?.role ?? (item?.type === "message" ? "user" : undefined)
      if (!role) continue // tool calls / results are dropped: the CLI runs its own loop
      pushText(String(role), item?.content)
    }
  }

  return messages
}

/** Serve the Responses API by translating to chat and back. */
async function handleResponses(body: any, res: any) {
  const messages = responsesInputToMessages(body)
  if (!messages.length) {
    json(res, 400, { error: { message: "input is required", type: "invalid_request_error" } })
    return
  }

  const model = normalizeCliModel(body.model ?? opts.model)
  try {
    const result = await callModel(messages, { ...opts, model })
    const id = `resp-cli-${result.sessionID ?? Date.now()}`
    const created = Math.floor(Date.now() / 1000)

    if (!body.stream) {
      json(res, 200, {
        id,
        object: "response",
        created_at: created,
        model,
        status: "completed",
        output: [
          {
            id: `${id}-msg`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: result.text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: result.usage.input,
          output_tokens: result.usage.output,
          total_tokens: result.usage.total || result.usage.input + result.usage.output,
        },
      })
      return
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    })
    const send = (type: string, payload: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    send("response.created", { response: { id, object: "response", created_at: created, model, status: "in_progress" } })
    send("response.output_item.added", { output_index: 0, item: { id: `${id}-msg`, type: "message", role: "assistant", status: "in_progress", content: [] } })
    send("response.output_text.delta", { item_id: `${id}-msg`, output_index: 0, content_index: 0, delta: result.text })
    send("response.output_item.done", {
      output_index: 0,
      item: {
        id: `${id}-msg`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: result.text, annotations: [] }],
      },
    })
    send("response.completed", {
      response: {
        id,
        object: "response",
        created_at: created,
        model,
        status: "completed",
        usage: {
          input_tokens: result.usage.input,
          output_tokens: result.usage.output,
          total_tokens: result.usage.total || result.usage.input + result.usage.output,
        },
      },
    })
    res.end()
  } catch (error: any) {
    const message = error?.message ?? "cli backend error"
    let status = 502
    if (/free usage|quota|insufficient|subscribe to opencode go/i.test(message)) status = 429
    else if (/model not found|unknown model|no such model|unsupported model/i.test(message)) status = 400
    else if (/unauthorized|invalid api key|authentication/i.test(message)) status = 401
    else if (/timed out/i.test(message)) status = 504
    // The HTTP transport already knows the real status; do not re-derive it from text.
    if (Number.isFinite(Number(error?.upstreamStatus)) && Number(error.upstreamStatus) >= 400) {
      status = Number(error.upstreamStatus)
    }
    if (status === 429 && Number.isFinite(Number(error?.retryAfterSeconds))) {
      res.setHeader("retry-after", String(Math.max(1, Math.round(Number(error.retryAfterSeconds)))))
    }
    json(res, status, { error: { message, type: "upstream_error", code: null } })
  }
}

async function handleCompletion(body: any, res: any) {
  const messages: CliMessage[] = Array.isArray(body.messages) ? body.messages : []
  if (!messages.length) {
    json(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } })
    return
  }

  const model = normalizeCliModel(body.model ?? opts.model)
  const runOptions: Options = { ...opts, model }

  try {
    const result = await callModel(messages, runOptions)
    const id = `chatcmpl-cli-${result.sessionID ?? Date.now()}`
    const created = Math.floor(Date.now() / 1000)

    if (!body.stream) {
      json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.text },
            finish_reason: result.finishReason === "error" ? "stop" : result.finishReason || "stop",
          },
        ],
        usage: usageFrom(result),
      })
      return
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    })
    const send = (payload: any) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: result.text }, finish_reason: null }] })
    send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    send({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usageFrom(result) })
    res.write("data: [DONE]\n\n")
    res.end()
  } catch (error: any) {
    const message = error?.message ?? "cli backend error"
    // Map the CLI's own wording onto statuses the gateway already understands: quota
    // walls must not look like transient 5xx, or the retry ladder burns the client's
    // timeout instead of surfacing the real cause.
    let status = 502
    if (/free usage|quota|insufficient|subscribe to opencode go/i.test(message)) status = 429
    else if (/model not found|unknown model|no such model|unsupported model/i.test(message)) status = 400
    else if (/unauthorized|invalid api key|authentication/i.test(message)) status = 401
    else if (/timed out|did not answer/i.test(message)) status = 504
    // The HTTP transport already knows the real status; do not re-derive it from text.
    if (Number.isFinite(Number(error?.upstreamStatus)) && Number(error.upstreamStatus) >= 400) {
      status = Number(error.upstreamStatus)
    }
    // Retry-After lets a client back off properly instead of hammering a closed window.
    // Upstream's value wins; the CLI path only has its own wording to go on.
    if (status === 429) {
      const minutes = /Retry in about (\d+) minute/i.exec(message)?.[1]
      const seconds = Number.isFinite(Number(error?.retryAfterSeconds))
        ? Number(error.retryAfterSeconds)
        : minutes
          ? Number(minutes) * 60
          : 900
      res.setHeader("retry-after", String(Math.max(1, Math.round(seconds))))
    }
    json(res, status, { error: { message, type: "upstream_error", code: null } })
  }
}

/** True when the request carries an accepted key (or auth is disabled). */
export function isAuthorized(headers: Record<string, any>, accepted: string[]): boolean {
  if (accepted.length === 0) return true
  const bearer = String(headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim()
  const apiKey = String(headers["x-api-key"] ?? "").trim()
  return accepted.includes(bearer) || accepted.includes(apiKey)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${opts.hostname}:${opts.port}`)

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    })
    res.end()
    return
  }

  // Health probes stay open so a supervisor can decide "is it up" before it has the key;
  // every other route needs one. This mirrors the opencode2api contract the plugin expects.
  const isHealth = url.pathname === "/healthz" || url.pathname === "/health" || url.pathname === "/v1/health"
  if (!isHealth && !isAuthorized(req.headers as any, opts.apiKeys)) {
    json(res, 401, {
      error: { code: null, message: "invalid local API key", type: "authentication_error" },
    })
    return
  }

  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    // Report BARE model ids, matching the DSH plugin's `free.models` entries
    // (`big-pickle`, not `opencode/big-pickle`).
    //
    // The plugin feeds this listing straight into its model menu
    // (`freeProfile`/`discoveryRow`) without stripping the provider prefix, and its
    // configured menu uses bare ids, so a prefixed listing matches nothing and the card
    // reports "端点返回了空模型列表". A bare listing also keeps the ids usable as-is when
    // they are echoed back in a chat request.
    const ids = (await discoveredModels()) ?? servedModels(opts.model)
    json(res, 200, {
      object: "list",
      data: ids.map((id) => ({
        id,
        object: "model",
        owned_by: opts.transport === "http" ? "oc2api" : "opencode-cli",
        created: Math.floor(Date.now() / 1000),
      })),
    })
    return
  }

  // The DSH plugin probes `/healthz` (not `/health`) before it will talk to this
  // service, so both spellings must answer. `serviceHealthy` in the plugin fetches
  // `${serviceUrl}/healthz` and treats a non-200 as "not listening".
  if (req.method === "GET" && isHealth) {
    // Reports which backend is in play so a stale one-shot process is visible in a probe.
    // Deliberately does NOT touch the model: a health check must never spend free quota.
    json(res, 200, {
      healthy: true,
      status: "ok",
      ready: true,
      model: normalizeCliModel(opts.model),
      backend: "opencode-cli",
      mode: opts.useServe ? "serve" : "oneshot",
      serve: opts.useServe ? serveBaseUrl() ?? "cold" : undefined,
    })
    return
  }

  if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
    try {
      const body = await readBody(req)
      if (!body) {
        json(res, 400, { error: { message: "request body must be a JSON object", type: "invalid_request_error" } })
        return
      }
      await handleCompletion(body, res)
    } catch (error: any) {
      json(res, 400, { error: { message: error?.message ?? "bad request", type: "invalid_request_error" } })
    }
    return
  }

  // The DSH plugin forwards `/v1/responses` verbatim when its client speaks the
  // Responses protocol (`serviceResponses`), so the CLI lane must answer that route
  // too. The CLI itself only has a chat-style transcript, so translate the request
  // into chat form and the reply back into the Responses shape.
  if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
    try {
      const body = await readBody(req)
      if (!body) {
        json(res, 400, { error: { message: "request body must be a JSON object", type: "invalid_request_error" } })
        return
      }
      await handleResponses(body, res)
    } catch (error: any) {
      json(res, 400, { error: { message: error?.message ?? "bad request", type: "invalid_request_error" } })
    }
    return
  }

  json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}`, type: "invalid_request_error" } })
})

server.listen(opts.port, opts.hostname, () => {
  const target = opts.transport === "http" ? `${opts.httpBaseUrl} (Bearer ${opts.httpKey === "public" ? "public" : "***"})` : `cli=${opts.opencodePath}`
  console.log(
    `[cli-server] listening on http://${opts.hostname}:${opts.port}/v1 ` +
      `model=${normalizeCliModel(opts.model)} transport=${opts.transport} ${target} ` +
      (opts.transport === "cli" ? `mode=${opts.useServe ? `serve:${opts.servePort}` : "oneshot"} ` : "") +
      `auto=${opts.autoApprove}`,
  )
})

// Warm the backend at startup so the first real request is already ~4s rather than ~30s.
// This starts a server process; it does not call a model, so it costs no free quota.
// Only the CLI transport has a backend to warm.
if (opts.useServe && opts.transport === "cli") {
  void (async () => {
    try {
      const { ensureServe } = await import("./opencode-local/serve-backend.ts")
      await ensureServe({ opencodePath: opts.opencodePath, port: opts.servePort, cwd: opts.cwd, model: opts.model })
      console.log(`[cli-server] warm backend ready on port ${opts.servePort}`)
    } catch (error: any) {
      console.warn(`[cli-server] warm backend unavailable, requests will use one-shot runs: ${error?.message}`)
    }
  })()
}

// Stop the backend with the service so no orphan `opencode serve` outlives it.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal as any, () => {
    stopServe()
    process.exit(0)
  })
}


process.on("unhandledRejection", (reason) => console.error("[cli-server] unhandled rejection:", reason))
process.on("uncaughtException", (error) => console.error("[cli-server] uncaught exception:", error))
