import { createServer } from "node:http"
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
 * OpenAI-compatible front end for the `opencode run` CLI backend.
 *
 * This is the only way to serve OpenCode's free models over HTTP: the entitlement is
 * attached to the CLI binary, not to an API key (see cli-backend.ts for the evidence).
 * Runs standalone so the gateway can point a normal `type: "openai"` upstream at it.
 *
 *   node src/cli-server.ts [--port 18081] [--model opencode/big-pickle]
 */

type Options = CliBackendOptions & {
  port: number
  hostname: string
  /** Keys a client may present. Empty means no auth (loopback only). */
  apiKeys: string[]
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

/**
 * Send one request to a model.
 *
 * Prefers the persistent `opencode serve` backend: a one-shot `opencode run` costs ~30s per
 * call here, while a warm server answers in 4-5s. The one-shot path stays as a fallback for
 * when the server cannot start, so the lane degrades in latency rather than failing.
 *
 * This is the only function that reaches a model, so it is the only place quota is spent:
 * nothing here runs on a timer.
 */
async function callModel(messages: CliMessage[], runOptions: Options): Promise<ServeResult | import("./opencode-local/cli-backend.ts").CliRunResult> {
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
    // Retry-After lets a client back off properly instead of hammering a closed window.
    if (status === 429) {
      const minutes = /Retry in about (\d+) minute/i.exec(message)?.[1]
      const seconds = minutes ? Number(minutes) * 60 : 900
      res.setHeader("retry-after", String(seconds))
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
    json(res, 200, {
      object: "list",
      data: servedModels(opts.model).map((id) => ({
        id,
        object: "model",
        owned_by: "opencode-cli",
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
  console.log(
    `[cli-server] listening on http://${opts.hostname}:${opts.port}/v1 ` +
      `model=${normalizeCliModel(opts.model)} cli=${opts.opencodePath} ` +
      `mode=${opts.useServe ? `serve:${opts.servePort}` : "oneshot"} auto=${opts.autoApprove}`,
  )
})

// Warm the backend at startup so the first real request is already ~4s rather than ~30s.
// This starts a server process; it does not call a model, so it costs no free quota.
if (opts.useServe) {
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
