import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * `opencode run` CLI backend.
 *
 * Why this exists: OpenCode's free models are gated on being the official client. They
 * cannot be reached over plain HTTP with an API key — measured 2026-10-26, a valid
 * `oc_sk_` key gets `FreeUsageLimitError` on `POST https://opencode.ai/zen/v1/*`, while
 * `opencode run` in a completely empty data dir (no auth.json, no key) succeeds. The
 * entitlement is carried by the CLI process itself, so the only way to serve a free
 * model over the OpenAI protocol is to drive the CLI as a backend.
 *
 * Protocol: `opencode run --format json` emits NDJSON, one object per line:
 *   {"type":"step_start"|"text"|"tool_use"|"step_finish"|"error", "sessionID":..., "part":{...}}
 * `part.type === "text"` carries `part.text`; `step_finish` carries `part.tokens` and
 * `part.cost`. Sessions persist across processes via `--session <id>`, but the gateway
 * receives the full message array on every request, so we inject history into the prompt
 * instead of relying on CLI session state. That keeps the mapping stateless and correct
 * even when the client trims or rewrites history.
 */

export type CliMessage = { role: string; content: any }

export type CliRunResult = {
  text: string
  usage: { input: number; output: number; reasoning: number; cacheRead: number; total: number }
  cost: number
  sessionID?: string
  toolCalls: Array<{ name: string; input: any; output: string }>
  finishReason: string
}

export type CliBackendOptions = {
  /** Path to the `opencode` executable (or .cmd/.ps1 shim on Windows). */
  opencodePath: string
  /** Data dir holding auth.json / storage. Empty means "use the CLI default". */
  dataHome?: string
  /** Workspace directory the CLI runs in. */
  cwd?: string
  /** Model as `provider/model`, e.g. `opencode/big-pickle`. */
  model?: string
  /** Auto-approve tool permissions (needed for the agent to actually run tools). */
  autoApprove?: boolean
  /** Kill the run after this many ms. */
  timeoutMs?: number
  /** Extra env for the child (proxy settings, etc.). */
  env?: Record<string, string>
}

const DEFAULT_TIMEOUT_MS = 300_000

/** Flatten OpenAI `content` (string or content-part array) into plain text. */
export function contentToText(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part?.type === "text" && typeof part.text === "string") return part.text
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return content == null ? "" : String(content)
}

/**
 * Turn a full OpenAI message array into a single prompt for one CLI invocation.
 *
 * Tool plumbing from the caller is deliberately dropped: the CLI runs its own agent
 * loop with its own tools, so replaying the caller's tool_calls/tool results would
 * confuse the transcript rather than inform it.
 */
export function buildCliPrompt(messages: CliMessage[]): string {
  const turns: string[] = []
  for (const message of messages ?? []) {
    const role = message?.role ?? "user"
    if (role === "system") {
      // System prompts are instructions, not conversation turns.
      const text = contentToText(message.content).trim()
      if (text) turns.push(`[system instructions]\n${text}`)
      continue
    }
    if (role === "tool" || role === "function") continue
    const text = contentToText(message.content).trim()
    if (!text) continue
    turns.push(`${role}: ${text}`)
  }

  if (turns.length === 1) {
    // Single user message: send it verbatim so simple probes stay clean.
    const only = messages.find((m) => (m?.role ?? "user") !== "system" && contentToText(m?.content).trim())
    if (only) return contentToText(only.content).trim()
  }

  return [
    "The following is a conversation transcript. Write the assistant's next reply.",
    "Reply with the assistant message only: no role prefix, no preamble.",
    "",
    turns.join("\n\n"),
  ].join("\n")
}

/**
 * Resolve a shim path to the real executable.
 *
 * `opencode.cmd` on Windows is just a forwarder to `node_modules/opencode-ai/bin/opencode.exe`.
 * Spawning the shim needs `shell: true`, and under a shell the child's stdout is
 * interleaved with cmd.exe's own handling, which stalls the NDJSON stream (measured:
 * a plain completion hung for 180s). Pointing at the .exe avoids the shell entirely.
 */
export function resolveExecutable(input: string, exists: (p: string) => boolean = fs.existsSync): string {
  if (process.platform !== "win32") return input
  if (/\.exe$/i.test(input)) return input
  if (!/\.(cmd|bat)$/i.test(input)) return input
  const dir = path.dirname(input)
  const candidates = [
    path.join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(dir, "opencode.exe"),
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return input
}

/**
 * Pick the data dir for the child process.
 *
 * Deliberately defaults to `undefined` (use the CLI's own default profile).
 *
 * Relocating `XDG_DATA_HOME` looks attractive on Windows for non-ASCII user names — the
 * CLI mis-handles such paths when it lazily opens its log file and dies with
 * `Unknown: FileSystem.open (...\log\opencode.log)`. But redirecting XDG makes the CLI
 * hang indefinitely: measured 2026-10-26, a run that completes in ~10s with the default
 * profile never emitted a single event and had to be killed at 70s once XDG_DATA_HOME
 * was set. A 70s hang on every request is far worse than the rare log-open failure, so
 * the default profile wins. Callers can still override via `dataHome`.
 */
export function resolveDataHome(options: CliBackendOptions): string | undefined {
  return options.dataHome || undefined
}

/** Strip `provider/` from a model id when the caller passed a bare model name. */
export function normalizeCliModel(model: string | undefined, fallback = "opencode/big-pickle"): string {
  const value = (model ?? "").trim()
  if (!value) return fallback
  return value.includes("/") ? value : `opencode/${value}`
}

/** Parse one NDJSON line into a structured event, tolerating non-JSON noise. */
export function parseCliLine(line: string): any | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Accumulate text/tool/usage out of a stream of CLI events. Mutates `acc`. */
export function absorbCliEvent(acc: CliRunResult, event: any) {
  if (!event || typeof event !== "object") return
  if (event.sessionID && !acc.sessionID) acc.sessionID = String(event.sessionID)

  if (event.type === "text" && typeof event.part?.text === "string") {
    acc.text += event.part.text
    return
  }
  if (event.type === "tool_use" && event.part?.tool) {
    const state = event.part.state ?? {}
    acc.toolCalls.push({
      name: String(event.part.tool),
      input: state.input,
      output: typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? ""),
    })
    return
  }
  if (event.type === "step_finish") {
    const tokens = event.part?.tokens
    if (tokens) {
      acc.usage.input += Number(tokens.input ?? 0)
      acc.usage.output += Number(tokens.output ?? 0)
      acc.usage.reasoning += Number(tokens.reasoning ?? 0)
      acc.usage.cacheRead += Number(tokens.cache?.read ?? 0)
      acc.usage.total += Number(tokens.total ?? 0)
    }
    acc.cost += Number(event.part?.cost ?? 0)
    if (event.part?.reason) acc.finishReason = String(event.part.reason)
    return
  }
  if (event.type === "error" && event.error) {
    const message = event.error?.data?.message ?? event.error?.message ?? JSON.stringify(event.error)
    acc.finishReason = "error"
    acc.text += acc.text ? `\n${message}` : String(message)
  }
}

/** The CLI synthesizes provider failures into assistant text; these are not answers. */
const CLI_FAILURE_PATTERNS: RegExp[] = [
  /unexpected server error/i,
  /check server logs/i,
  /model not found/i,
  /unknown model/i,
  /no such model/i,
  /free usage limit reached/i,
  /free usage exceeded/i,
  /insufficient account funds/i,
  /subscribe to opencode go/i,
  /quota exceeded/i,
  /unauthorized/i,
  /invalid api key/i,
  /authentication/i,
  /provider error/i,
  /failed to connect/i,
]

/** True when the CLI's text is entirely an error notice rather than a real answer. */
export function onlyErrorText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return CLI_FAILURE_PATTERNS.some((re) => re.test(trimmed)) && trimmed.length < 400
}

/**
 * Decide whether a finished run actually failed.
 *
 * Prefers the CLI's own wording. `stderr` is only consulted when the run produced no
 * text at all, because the CLI writes banners and permission chatter there on success.
 */
export function cliFailureText(text: string, stderr: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed) {
    for (const re of CLI_FAILURE_PATTERNS) {
      if (re.test(trimmed)) return trimmed.slice(0, 500)
    }
    return undefined
  }
  const tail = stderr.trim()
  if (tail && /error|failed|cannot|not found|denied/i.test(tail)) return tail.slice(-500)
  return undefined
}

/** A failed CLI run, carrying whatever partial output was collected. */
export class CliRunError extends Error {
  readonly result: CliRunResult
  constructor(message: string, result: CliRunResult) {
    super(message)
    this.name = "CliRunError"
    this.result = result
  }
}

/** Run the CLI once and collect the full (non-streamed) result. */
export function runCliOnce(messages: CliMessage[], options: CliBackendOptions): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const prompt = buildCliPrompt(messages)
    if (!prompt) {
      reject(new Error("empty prompt"))
      return
    }

    const args = ["run", "--pure", "--format", "json", "--model", normalizeCliModel(options.model)]
    if (options.autoApprove) args.push("--auto")
    args.push(prompt)

    const env: Record<string, string> = { ...(process.env as any), ...(options.env ?? {}) }
    const dataHome = resolveDataHome(options)
    if (dataHome) {
      env.XDG_DATA_HOME = dataHome
      env.XDG_STATE_HOME = path.join(dataHome, "state")
    }

    const child = spawn(resolveExecutable(options.opencodePath), args, {
      cwd: options.cwd ?? process.cwd(),
      env,
      windowsHide: true,
      // The CLI reads stdin for interactive prompts; an inherited/piped stdin can make it
      // wait forever when nothing writes to it.
      stdio: ["ignore", "pipe", "pipe"],
    })

    const acc: CliRunResult = {
      text: "",
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, total: 0 },
      cost: 0,
      toolCalls: [],
      finishReason: "stop",
    }

    let buffer = ""
    let stderr = ""
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        void 0
      }
      reject(new Error(`opencode CLI timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`))
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        absorbCliEvent(acc, parseCliLine(line))
        index = buffer.indexOf("\n")
      }
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      // The CLI writes its banner and permission chatter here; keep a tail for errors.
      stderr = (stderr + chunk).slice(-4000)
    })

    child.on("error", (error: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (buffer.trim()) absorbCliEvent(acc, parseCliLine(buffer))

      // The CLI reports provider failures as a synthesized assistant message such as
      // "Unexpected server error. Check server logs for details." with exit code 0. Passing
      // that through as a normal completion tells the caller nothing and hides a bad model
      // id or a dead upstream, so classify it as a failure instead.
      const failure = cliFailureText(acc.text, stderr)
      if (failure) {
        if (acc.toolCalls.length > 0 && !onlyErrorText(acc.text)) {
          // Real work happened before the error; keep the answer and let the caller see it.
          resolve(acc)
          return
        }
        reject(new CliRunError(failure, acc))
        return
      }

      if (acc.text.trim()) {
        resolve(acc)
        return
      }
      if (code !== 0) {
        reject(new CliRunError(`opencode CLI exited with ${code}: ${stderr.trim() || "no output"}`, acc))
        return
      }
      resolve(acc)
    })
  })
}

/** Stream the CLI's text deltas as they arrive, then return the final result. */
export async function* streamCliOnce(
  messages: CliMessage[],
  options: CliBackendOptions,
): AsyncGenerator<{ type: "delta"; text: string } | { type: "done"; result: CliRunResult }, void, unknown> {
  const result = await runCliOnce(messages, options)
  yield { type: "done", result }
}
