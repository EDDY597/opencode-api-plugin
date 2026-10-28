/**
 * Keeps the two local lanes alive for as long as the gateway runs.
 *
 * Why this exists: the DSH plugin decides once, at load time, whether the free route
 * exists. It probes `http://127.0.0.1:18080/healthz`; if that fails it marks the route
 * unavailable for the whole session and the 60s refresh loop does not bring it back
 * (only the model *listing* is refreshed, not the runtime). So a lane that dies while
 * the gateway is up silently costs the user their free models until they restart DSH.
 *
 * This watchdog only probes loopback ports. `/health` and `/healthz` are static local
 * answers: nothing here reaches opencode.ai, so it spends no free-tier quota and does
 * not contradict the "no background polling" rule (that rule is about upstream quota,
 * not local liveness). It also stays inert while a restart is already in flight.
 */

const DEFAULT_INTERVAL_MS = 30_000

export type LaneTarget = {
  /** For log lines only. */
  name: string
  /** Resolves true when the lane answers on loopback. */
  check: () => Promise<boolean>
  /** Bring it back. Must be safe to call when the lane is already up. */
  restart: () => Promise<void>
}

export type WatchdogLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * Start watching. Returns a stop function.
 *
 * The timer is unref'd so it can never keep the process alive on its own, and checks
 * are serialized: a slow restart cannot overlap with the next tick.
 */
export function startLaneWatchdog(
  targets: LaneTarget[],
  logger?: WatchdogLogger,
  intervalMs = DEFAULT_INTERVAL_MS,
): () => void {
  let busy = false
  const failures = new Map<string, number>()

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      for (const target of targets) {
        const alive = await target.check().catch(() => false)
        if (alive) {
          if ((failures.get(target.name) ?? 0) > 0) logger?.info?.(`[Gateway] ${target.name} is back`)
          failures.delete(target.name)
          continue
        }
        // A missing binary or a port fight would otherwise log every tick forever.
        // Say it once when it starts failing, then every 10th attempt.
        const count = (failures.get(target.name) ?? 0) + 1
        failures.set(target.name, count)
        if (count === 1 || count % 10 === 0) {
          logger?.warn?.(
            `[Gateway] ${target.name} stopped answering (attempt ${count}); restarting it`,
          )
        }
        await target.restart().catch((error: any) => {
          if (count === 1) logger?.warn?.(`[Gateway] ${target.name} restart failed: ${error?.message ?? error}`)
        })
      }
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  timer.unref?.()

  return () => clearInterval(timer)
}

/** Probe helpers shared with the lanes so the check and the restart agree. */
export async function loopbackHealthy(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}
