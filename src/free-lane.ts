import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/**
 * Owns the CLI free-lane server as a child of the gateway process.
 *
 * Why the gateway owns it: the DSH plugin registers its free-tier provider only if the
 * service at 18080 answers /healthz *when the plugin loads*. That makes startup ordering
 * load-bearing, and a separate autostart entry keeps losing that race (a Run key fires at
 * logon, long before the harness restarts mid-session). Binding the lane to the gateway
 * removes the race: whoever starts the gateway gets the lane, and both live or die together.
 *
 * The child is detached into its own process group on Windows so a console Ctrl-C aimed at
 * the gateway does not tear the server down mid-request; `stop()` is the only intended exit.
 *
 * This module starts a server process. It never calls a model, so it costs no free quota.
 */

const HEALTH_TIMEOUT_MS = 2_000
const READY_TIMEOUT_MS = 90_000
const READY_POLL_MS = 1_000

export type FreeLaneStatus = "starting" | "ready" | "failed" | "disabled"

type LaneState = {
  status: FreeLaneStatus
  port: number
  child?: any
  error?: string
}

let state: LaneState = { status: "disabled", port: 0 }

/** Is something already serving the lane on this port? */
async function laneHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body: any = await response.json().catch(() => undefined)
    return body?.backend === "opencode-cli"
  } catch {
    return false
  }
}

export function freeLaneStatus(): LaneState {
  return { ...state }
}

/**
 * Is the *forwarding* shim (the one this module spawns) answering?
 *
 * `backend: "http"` is what cli-server reports when `--transport http` + `--http-base` are
 * in play; a hand-started CLI driver reports `"opencode-cli"`. Reusing the latter would
 * silently hand DSH the slow, tool-less CLI path instead of oc2api.
 */
async function forwardingHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body: any = await response.json().catch(() => undefined)
    return body?.backend === "http"
  } catch {
    return false
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Find the opencode CLI.
 *
 * `opencode` on PATH resolves to a PowerShell script here, which Node cannot spawn — it
 * fails with `spawn opencode ENOENT` and every free-model request 502s. Resolve to the real
 * .exe instead.
 */
function resolveOpencodePath(): string {
  const explicit = process.env.OPENCODE_CLI_PATH
  if (explicit && fs.existsSync(explicit)) return explicit

  const candidates = [
    "E:\\STUDY\\IT\\nodejs\\node_global\\node_modules\\opencode-ai\\bin\\opencode.exe",
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "opencode", "opencode.exe"),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return "opencode"
}

/**
 * Start the CLI server unless it is already answering.
 *
 * @param root - repository root (holds src/cli-server.ts and bin/config.json).
 * @param port - port to serve on; the DSH plugin's default is 18080.
 * @param logger - where the child's own log lines go.
 * @param forwarding - when set, run cli-server as a plain HTTP forwarder to this base
 *   URL (in practice the local oc2api lane) instead of driving the opencode binary.
 *   That is the configuration the DSH plugin gets: 18080 must keep answering, but Node
 *   cannot reach zen itself, so oc2api does the TLS.
 * @param shimKey - key the shim demands on every non-health route. Required: without it
 *   cli-server treats "no keys" as "no auth", and every local process could spend this
 *   machine's free quota through 18080. The caller (standalone.ts) refuses to start the
 *   lane when it has no key, so a missing value here is a programming error, not a mode.
 */
export async function startFreeLane(
  root: string,
  port = 18080,
  logger?: { info?: (message: string) => void; warn?: (message: string) => void },
  forwarding?: { httpBase: string; apiKey?: string },
  shimKey?: string,
): Promise<void> {
  state = { status: "starting", port }

  if (!shimKey) {
    state.status = "failed"
    state.error = "cliServer lane has no API key; refusing to serve 18080 unauthenticated"
    logger?.warn?.(`[Gateway] ${state.error}. Set lanes.cliServer.apiKey (or lanes.oc2api.apiKey) in gateway.config.json.`)
    return
  }

  // A lane started earlier (by a previous gateway run, or by hand) is reused rather than
  // fought over: two servers on one port is the failure mode we are trying to remove.
  // Only a shim that is forwarding (backend "http") is reused: one that reports
  // "opencode-cli" is a hand-started CLI driver, which is not this lane.
  if (forwarding ? await forwardingHealthy(port) : await laneHealthy(port)) {
    state.status = "ready"
    logger?.info?.(`[Gateway] Free lane already serving on ${port}; reusing it.`)
    return
  }

  const script = path.join(root, "src", "cli-server.ts")

  // Run the CLI server with the gateway's own Node: no cmd.exe in the chain. Routing a
  // non-ASCII user name through a console host mangles USERPROFILE and the CLI then fails
  // opening its log file.
  const child = spawn(
    process.execPath,
    [
      script,
      "--port", String(port),
      // Authenticated, not open: the key is the one the caller also registered in the
      // gateway's own upstream, and --parent-pid makes an orphaned shim step aside.
      "--api-key", shimKey,
      "--parent-pid", String(process.pid),
      "--model", "opencode/big-pickle",
      "--models",
      // Fallback only: with forwarding enabled cli-server reads the live list from oc2api
      // (60s cache) and uses these just when that read fails. Keep them roughly current.
      "big-pickle,beam-free,flint-40b-free,mimo-v2.6-flash-free,nemotron-3.5-super-vl-free,nemotron-3.5-lightning-free,jev-1.13-free,deepseek-v4.1-flash-free,glm-5.3-flash-free,doubao-seed-code-free,gpt-5.4-nano-free,gpt-5.4-mini-free,kimi-k2.6-free,qwen3.8-max-free,minimax-m3-free,kimi-k2.5-free,glm-5-free,glm-5.1-free,minimax-m2.5-free,minimax-m2.7-free,trinity-large-free",
      "--opencode-path", resolveOpencodePath(),
      ...(forwarding
        ? ["--transport", "http", "--http-base", forwarding.httpBase, ...(forwarding.apiKey ? ["--http-key", forwarding.apiKey] : [])]
        : ["--transport", "cli"]),
    ],
    {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    },
  )

  state.child = child

  let tail = ""
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = String(chunk)
    tail = (tail + text).slice(-2000)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith("[cli-server]")) logger?.info?.(`[Gateway] ${trimmed}`)
    }
  })
  child.stderr?.on("data", (chunk: Buffer | string) => {
    tail = (tail + String(chunk)).slice(-2000)
  })

  child.on("exit", (code: number | null) => {
    if (state.child === child && state.status === "ready") {
      state.status = "failed"
      state.error = `CLI server exited (code ${code})`
      logger?.warn?.(`[Gateway] Free lane exited (code ${code}); free models are unavailable until the gateway restarts.`)
    }
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      state.status = "failed"
      state.error = `CLI server exited during startup (code ${child.exitCode}): ${tail.trim().slice(-300)}`
      logger?.warn?.(`[Gateway] Free lane failed to start: ${state.error}`)
      return
    }
    if (await laneHealthy(port)) {
      state.status = "ready"
      logger?.info?.(`[Gateway] Free lane ready on ${port}.`)
      return
    }
    await sleep(READY_POLL_MS)
  }

  state.status = "failed"
  state.error = `CLI server did not answer /healthz within ${READY_TIMEOUT_MS}ms`
  logger?.warn?.(`[Gateway] ${state.error}`)
}

/** Stop the lane (gateway shutdown). A lane we merely reused is left alone. */
export function stopFreeLane() {
  const child = state.child
  if (!child || child.exitCode !== null) return
  try {
    child.kill()
  } catch {
    void 0
  }
  state = { status: "disabled", port: state.port }
}
