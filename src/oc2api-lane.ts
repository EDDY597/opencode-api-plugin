import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/**
 * Owns the oc2api process as a child of the gateway.
 *
 * Why this lane exists: zen/v1's free tier identifies callers by **TLS fingerprint**
 * (measured 2026-10-28: same egress, same headers, same `Bearer public` — Node
 * undici got `429 FreeUsageLimitError`, oc2api's uTLS got `200`). Node cannot send
 * a BoringSSL ClientHello, so the gateway must not talk to zen directly. It talks
 * to oc2api over plain loopback HTTP instead, and oc2api does the TLS that upstream
 * actually checks.
 *
 * Lifetime: started by the gateway like the CLI lane, and killed with it. That is
 * what makes the free lane survive a gateway restart without a separate autostart
 * entry racing the DSH plugin's load.
 *
 * oc2api binds all interfaces and treats an empty API_KEY as anonymous, so a key is
 * required here: without it anything on the LAN could spend this machine's quota.
 * The key is passed in by the caller and the upstream config must carry the same one.
 */

const HEALTH_TIMEOUT_MS = 2_000
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 500

export type Oc2apiLaneStatus = "starting" | "ready" | "failed" | "disabled"

type LaneState = {
  status: Oc2apiLaneStatus
  port: number
  child?: any
  error?: string
  /** True when we attached to a process we did not start, and must not kill. */
  adopted?: boolean
}

let state: LaneState = { status: "disabled", port: 0 }

/** Is something already serving the lane on this port? */
async function laneHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body: any = await response.json().catch(() => undefined)
    return body?.status === "ok"
  } catch {
    return false
  }
}

export function oc2apiLaneStatus(): LaneState {
  return { ...state }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Find the oc2api binary.
 *
 * `bin/` is gitignored, so the binary is built per machine rather than committed;
 * see AGENTS.md for the one-command build. OPENCODE_OC2API_PATH overrides the
 * location for a machine that keeps it elsewhere.
 */
function resolveBinary(root: string): string {
  const explicit = process.env.OPENCODE_OC2API_PATH
  if (explicit && fs.existsSync(explicit)) return explicit
  const candidates = [
    path.join(root, "bin", "oc2api.exe"),
    path.join(root, "bin", "oc2api"),
    path.join(process.env.LOCALAPPDATA ?? "", "oc2api", "oc2api.exe"),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return path.join(root, "bin", "oc2api.exe")
}

export type Oc2apiLaneOptions = {
  root: string
  port?: number
  /** Required: oc2api listens on every interface. */
  apiKey?: string
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

export async function startOc2apiLane(options: Oc2apiLaneOptions): Promise<void> {
  const port = options.port && options.port > 0 ? options.port : 18090
  const { root, logger } = options
  state = { status: "starting", port }

  // A lane started earlier (by a previous gateway run, or by hand) is adopted rather
  // than fought over: two processes on one port is the failure mode to avoid.
  if (await laneHealthy(port)) {
    state = { status: "ready", port, adopted: true }
    logger?.info?.(`[Gateway] oc2api already serving on ${port}; reusing it.`)
    return
  }

  const binary = resolveBinary(root)
  if (!fs.existsSync(binary)) {
    state = { status: "failed", port, error: `oc2api binary not found at ${binary}` }
    logger?.warn?.(`[Gateway] ${state.error} — free models are unavailable until it is built (see AGENTS.md).`)
    return
  }
  if (!options.apiKey) {
    state = { status: "failed", port, error: "oc2api API_KEY is empty; refusing to expose the free lane anonymously" }
    logger?.warn?.(`[Gateway] ${state.error}.`)
    return
  }

  const child = spawn(binary, [], {
    cwd: path.dirname(binary),
    env: { ...process.env, PORT: String(port), API_KEY: options.apiKey },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  })
  state.child = child

  let tail = ""
  const absorb = (chunk: Buffer | string) => {
    tail = (tail + String(chunk)).slice(-2000)
  }
  child.stdout?.on("data", (chunk: Buffer | string) => {
    absorb(chunk)
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) logger?.info?.(`[oc2api] ${trimmed}`)
    }
  })
  child.stderr?.on("data", absorb)

  child.on("exit", (code: number | null) => {
    if (state.child === child && state.status === "ready") {
      state = { ...state, status: "failed", error: `oc2api exited (code ${code})` }
      logger?.warn?.(`[Gateway] oc2api exited (code ${code}); free models are unavailable until the gateway restarts.`)
    }
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      state = {
        status: "failed",
        port,
        error: `oc2api exited during startup (code ${child.exitCode}): ${tail.trim().slice(-300)}`,
      }
      logger?.warn?.(`[Gateway] ${state.error}`)
      return
    }
    if (await laneHealthy(port)) {
      state = { status: "ready", port }
      logger?.info?.(`[Gateway] oc2api ready on ${port}.`)
      return
    }
    await sleep(READY_POLL_MS)
  }

  state = { status: "failed", port, error: `oc2api did not answer /health within ${READY_TIMEOUT_MS}ms` }
  logger?.warn?.(`[Gateway] ${state.error}`)
}

/** Stop the lane. A process we merely adopted is left alone. */
export function stopOc2apiLane() {
  const child = state.child
  if (state.adopted || !child || child.exitCode !== null) {
    state = { status: "disabled", port: state.port }
    return
  }
  try {
    child.kill()
  } catch {
    void 0
  }
  state = { status: "disabled", port: state.port }
}
