import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Persistent `opencode serve` backend for the free lane.
 *
 * Why: one-shot `opencode run` costs ~30s per call on this machine, and that cost is not
 * session setup 鈥?reusing `--session` measured the same 30s. A long-lived `opencode serve`
 * warms the provider, model catalog and runtime once; subsequent messages completed in
 * 4-5s (measured 2026-10-27, same model: 31332ms cold vs 4921ms and 4358ms warm).
 *
 * This module owns exactly one server child process and reuses it. It never sends model
 * requests on its own: only `prompt()` reaches a model, and that is called once per client
 * request, so no quota is spent in the background.
 */

const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 500

export type ServeOptions = {
  /** Path to the opencode executable (resolved past the .cmd shim). */
  opencodePath: string
  /** Port to bind the headless server on. 0 lets the OS pick. */
  port?: number
  hostname?: string
  /** Workspace the server runs in. */
  cwd?: string
  /** Model as `provider/model`. */
  model?: string
}

export type ServeResult = {
  text: string
  usage: { input: number; output: number; reasoning: number; cacheRead: number; total: number }
  cost: number
  sessionID?: string
  finishReason: string
}

type ServeState = {
  child: any
  baseUrl: string
  ready: Promise<void>
  lastUsed: number
}

let state: ServeState | undefined

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Is the resolved URL answering the health probe? */
async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return false
    const body: any = await response.json().catch(() => undefined)
    return body?.healthy === true
  } catch {
    return false
  }
}

/**
 * Resolve a Windows shim to the real executable.
 *
 * `opencode.cmd` is a forwarder to `node_modules/opencode-ai/bin/opencode.exe`; spawning the
 * shim needs a shell, which interleaves cmd.exe output into the child's stdio.
 */
export function resolveServeExecutable(input: string): string {
  if (process.platform !== "win32") return input
  if (/\.exe$/i.test(input)) return input
  if (!/\.(cmd|bat)$/i.test(input)) return input
  const dir = path.dirname(input)
  for (const candidate of [
    path.join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(dir, "opencode.exe"),
  ]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return input
}

/** Base URL for the running server, or undefined when it is not up. */
export function serveBaseUrl(): string | undefined {
  return state?.baseUrl
}

/** When the server last served a prompt (ms since epoch); 0 when never. */
export function serveIdleSince(): number {
  return state?.lastUsed ?? 0
}

/**
 * Start the headless server if it is not already healthy.
 *
 * Concurrent callers share one spawn: the promise is stored before awaiting so a burst of
 * requests cannot start several servers on the same port.
 */
export async function ensureServe(options: ServeOptions): Promise<string> {
  if (state && (await isHealthy(state.baseUrl))) {
    await state.ready
    return state.baseUrl
  }
  // A previous child may be dead but leave the port bound briefly; drop it first.
  if (state) {
    try {
      state.child?.kill()
    } catch {
      void 0
    }
    state = undefined
  }

  const port = options.port ?? 10001
  const hostname = options.hostname ?? "127.0.0.1"
  const baseUrl = `http://${hostname}:${port}`

  const env = { ...process.env }
  // `opencode serve` reads the same profile as `opencode run`; keep the user paths intact.
  const child = spawn(resolveServeExecutable(options.opencodePath), ["serve", "--pure", "--port", String(port), "--hostname", hostname], {
    cwd: options.cwd ?? process.cwd(),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  })

  const ready = (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`opencode serve exited during startup (code=${child.exitCode})`)
      }
      if (await isHealthy(baseUrl)) return
      await sleep(READY_POLL_MS)
    }
    throw new Error(`opencode serve did not become healthy within ${READY_TIMEOUT_MS}ms`)
  })()

  const next: ServeState = { child, baseUrl, ready, lastUsed: 0 }
  state = next

  child.on("exit", () => {
    // Forget the state so the next request starts a fresh server instead of talking to a
    // socket nobody is listening on.
    if (state === next) state = undefined
  })

  try {
    await ready
  } catch (error) {
    if (state === next) state = undefined
    try {
      child.kill()
    } catch {
      void 0
    }
    throw error
  }
  return baseUrl
}

/** Stop the server (gateway shutdown). */
export function stopServe() {
  if (!state) return
  try {
    state.child?.kill()
  } catch {
    void 0
  }
  state = undefined
}

/** How long a single prompt may run before the request is failed instead of hanging. */
const PROMPT_TIMEOUT_MS = 20_000

/**
 * How long a quota wall is trusted before trying again.
 *
 * Deliberately short. The breaker is a *rate* guard, not a source of truth: OpenCode's
 * reset moment is unpublished, so a long block risks refusing requests that would now
 * succeed. Five minutes of protection stops a retry storm while keeping a wrong guess
 * cheap — the worst case is one wasted probe every five minutes, not a stuck lane.
 */
const QUOTA_COOLDOWN_MS = 5 * 60 * 1000

/** Set when the free tier refused a request; blocks attempts until it expires. */
let quotaBlockedUntil = 0
let quotaBlockedReason = ""

/** True while the breaker is open (quota known-exhausted). */
export function quotaBlocked(): { blocked: boolean; reason: string; retryAfterMs: number } {
  if (quotaBlockedUntil === 0 || Date.now() >= quotaBlockedUntil) {
    return { blocked: false, reason: "", retryAfterMs: 0 }
  }
  return {
    blocked: true,
    reason: quotaBlockedReason,
    retryAfterMs: quotaBlockedUntil - Date.now(),
  }
}

/** Arm the breaker after a confirmed quota wall. */
export function tripQuotaBreaker(reason: string) {
  quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS
  quotaBlockedReason = reason
}

/** Clear the breaker (tests, or an explicit refresh). */
export function resetQuotaBreaker() {
  quotaBlockedUntil = 0
  quotaBlockedReason = ""
}

/**
 * Read the CLI's quota wording from the log, but only when it is evidence about *now*.
 *
 * Accuracy matters more than cleverness here: a false positive refuses a request that would
 * have worked, which is exactly the failure mode this guard must not introduce. So this is
 * used for two narrow jobs only, never as the sole reason to block:
 *
 *  1. Explain a request that already failed or timed out (the CLI logs the wall instead of
 *     returning an error), so the caller gets "quota exhausted" instead of "did not answer".
 *  2. Persist the wall across process restarts, bounded by `recentlyLoggedQuota`.
 *
 * A request that succeeds never consults this.
 */
function quotaErrorFromLog(profileDir?: string): string | undefined {
  try {
    const base = profileDir ?? os.homedir()
    const logPath = path.join(base, ".local", "share", "opencode", "log", "opencode.log")
    if (!fs.existsSync(logPath)) return undefined

    // Only the tail matters, and the file grows: read the last chunk.
    const size = fs.statSync(logPath).size
    const start = Math.max(0, size - 16384)
    const fd = fs.openSync(logPath, "r")
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    fs.closeSync(fd)

    const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-40)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (/Free usage limit reached/i.test(line)) {
        return "Free usage limit reached. OpenCode's free tier is exhausted for the current window."
      }
      if (/Insufficient account funds/i.test(line)) {
        return "Insufficient account funds on the OpenCode account."
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Was a quota wall logged in the last few minutes?
 *
 * The log is the only durable signal across process restarts: the in-memory breaker dies
 * with the CLI server, but the wall it recorded does not. Only a recent entry counts, so a
 * window that has since reset is not held against the caller forever.
 */
function recentlyLoggedQuota(profileDir?: string, withinMs = QUOTA_COOLDOWN_MS): boolean {
  try {
    const base = profileDir ?? os.homedir()
    const logPath = path.join(base, ".local", "share", "opencode", "log", "opencode.log")
    if (!fs.existsSync(logPath)) return false
    const ageMs = Date.now() - fs.statSync(logPath).mtimeMs
    // The CLI logs plenty of other things; a stale file or an idle one proves nothing.
    if (ageMs > withinMs) return false
    return quotaErrorFromLog(profileDir) !== undefined
  } catch {
    return false
  }
}

async function postJson(url: string, body: any, timeoutMs: number): Promise<any> {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error: any) {
    // AbortSignal.timeout rejects with a DOMException named TimeoutError.
    if (error?.name === "TimeoutError" || /aborted|timeout/i.test(String(error?.message))) {
      throw new Error(`opencode server did not answer within ${timeoutMs}ms`)
    }
    throw error
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`opencode server answered ${response.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : undefined
}

/** Flatten a chat transcript into one prompt, matching the one-shot adapter's behaviour. */
export function servePromptText(messages: Array<{ role: string; content: any }>): string {
  const text = (content: any): string => {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part: any) => (typeof part === "string" ? part : part?.type === "text" ? part.text ?? "" : ""))
        .filter(Boolean)
        .join("\n")
    }
    return content == null ? "" : String(content)
  }

  const turns: string[] = []
  for (const message of messages ?? []) {
    const role = message?.role ?? "user"
    if (role === "tool" || role === "function") continue
    const value = text(message?.content).trim()
    if (!value) continue
    if (role === "system") {
      turns.push(`[system instructions]\n${value}`)
      continue
    }
    turns.push(`${role}: ${value}`)
  }

  if (turns.length === 1) {
    const only = messages.find((m) => (m?.role ?? "user") !== "system" && text(m?.content).trim())
    if (only) return text(only.content).trim()
  }

  return [
    "The following is a conversation transcript. Write the assistant's next reply.",
    "Reply with the assistant message only: no role prefix, no preamble.",
    "",
    turns.join("\n\n"),
  ].join("\n")
}

/**
 * Send one prompt through the persistent server and return the assistant text.
 *
 * One HTTP call to the server per caller request: this is the only place a model is
 * invoked, so it is the only place quota can be spent.
 */
export async function servePrompt(
  options: ServeOptions,
  messages: Array<{ role: string; content: any }>,
  timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<ServeResult> {
  // Refuse without touching the network while the breaker is open.
  //
  // There is no background probing anywhere in this module: nothing here runs on a timer,
  // so an idle gateway spends nothing. The breaker is only consulted when a caller actually
  // sends a request, and it only opens from an observed failure.
  const gate = quotaBlocked()
  if (gate.blocked) {
    // Keep the warm backend alive while refusing. Without this, a long quota window left the
    // lane "cold" (or with a dead server) and the first request after the reset paid the full
    // cold-start cost — or failed outright. Warming here costs nothing: ensureServe only
    // starts a process, it never calls a model.
    void ensureServe(options).catch(() => {
      /* a failed warm-up must not change the refusal below */
    })
    const minutes = Math.ceil(gate.retryAfterMs / 60_000)
    throw new Error(`${gate.reason} Retry in about ${minutes} minute(s).`)
  }

  // Deliberately NO log-based pre-check here.
  //
  // An earlier version scanned the log before sending and refused when it found quota
  // wording. That was a real false-positive risk: the log carries history from other
  // processes, and a wall from a previous window would block a request that would now
  // succeed. The breaker above is enough to stop retry storms, and it is only armed by an
  // observed failure. Let the request decide.

  const baseUrl = await ensureServe(options)

  try {
    return await promptOnce(baseUrl, options, messages, timeoutMs)
  } catch (error: any) {
    // A quota wall is not a backend fault: the server is fine, the account is out of
    // allowance. Killing it here was a real bug — every failed request also destroyed the
    // warm backend, so once the breaker opened nothing ever restarted it and the lane came
    // back "cold" (or dead) even after the quota reset. Check the log first, and leave the
    // process alone when it explains the failure.
    const quota = quotaErrorFromLog(options.dataHome)
    if (quota) {
      tripQuotaBreaker(quota)
      throw new Error(quota)
    }

    // Genuinely wedged backend (answers /global/health but never replies to prompts, or the
    // socket died): drop it so the next request starts a fresh one.
    dropServe()
    throw error
  }
}

/** Forget the current backend so the next request spawns a new one. */
export function dropServe() {
  const current = state
  state = undefined
  if (!current) return
  try {
    current.child?.kill()
  } catch {
    void 0
  }
}

async function promptOnce(
  baseUrl: string,
  options: ServeOptions,
  messages: Array<{ role: string; content: any }>,
  timeoutMs: number,
): Promise<ServeResult> {
  const text = servePromptText(messages)
  if (!text) throw new Error("empty prompt")

  const model = (options.model ?? "opencode/big-pickle").trim() || "opencode/big-pickle"
  const slash = model.indexOf("/")
  const providerID = slash > 0 ? model.slice(0, slash) : "opencode"
  const modelID = slash > 0 ? model.slice(slash + 1) : model

  // Pass a title up front. Without one the CLI spawns a separate `gpt-5.4-nano` request per
  // session just to name the conversation — 72 such calls were logged in one morning, all
  // failing on an empty account balance and all pure waste. A fixed title skips that call.
  const session = await postJson(`${baseUrl}/session`, { title: "free-lane" }, 30_000)
  const sessionID = session?.id
  if (!sessionID) throw new Error("opencode server did not return a session id")

  const response = await postJson(
    `${baseUrl}/session/${sessionID}/message`,
    {
      model: { providerID, modelID },
      parts: [{ type: "text", text }],
      // The CLI's agent loop would otherwise stop to ask; the adapter is headless.
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    },
    timeoutMs,
  )

  const parts: any[] = Array.isArray(response?.parts) ? response.parts : []
  const answer = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")

  const info = response?.info ?? {}
  const tokens = info.tokens ?? {}
  if (state) state.lastUsed = Date.now()

  return {
    text: answer,
    usage: {
      input: Number(tokens.input ?? 0),
      output: Number(tokens.output ?? 0),
      reasoning: Number(tokens.reasoning ?? 0),
      cacheRead: Number(tokens.cache?.read ?? 0),
      total: Number(tokens.total ?? 0),
    },
    cost: Number(info.cost ?? 0),
    sessionID: String(sessionID),
    finishReason: String(info.finish ?? "stop"),
  }
}
