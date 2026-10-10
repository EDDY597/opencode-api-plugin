import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

/**
 * OpenCode backend lifecycle management (ported from opencode2api src/proxy.js, MIT).
 *
 * The embedded local upstream spawns `opencode serve` on demand, waits for it to become
 * healthy, and shuts it down with the gateway. On Windows the backend runs with the real
 * user home (opencode storage paths) inside an empty workspace directory; on Unix-like
 * systems an optional fake-home jail provides isolation.
 */

export const OPENCODE_BASENAME = "opencode"

export const STARTUP_WAIT_ITERATIONS = 60
export const STARTUP_WAIT_INTERVAL_MS = 2000
export const STARTING_WAIT_ITERATIONS = 120
export const STARTING_WAIT_INTERVAL_MS = 1000

export type BackendState = {
  isStarting: boolean
  process: any
  jailRoot: string | null
  /** True while an intentional kill (respawn or shutdown) is in flight, so the
   * exit listener can tell "stopped by us" from "died on its own". */
  expectExit?: boolean
}

const backendState = new Map<string, BackendState>()

export function getBackendState(stateKey: string): BackendState {
  let state = backendState.get(stateKey)
  if (!state) {
    state = { isStarting: false, process: null, jailRoot: null }
    backendState.set(stateKey, state)
  }
  return state
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function buildBackendAuthHeaders(password = ""): Record<string, string> | undefined {
  if (!password) return undefined
  const token = Buffer.from(`opencode:${password}`).toString("base64")
  return { Authorization: `Basic ${token}` }
}

/**
 * `/global/health` is OpenCode's real health endpoint. `/health` is not an API route: it
 * falls through to the web UI handler, which may proxy to app.opencode.ai and answer 200
 * even when the API is not usable.
 */
export function checkHealth(serverUrl: string, password = "") {
  return new Promise((resolve, reject) => {
    const headers = buildBackendAuthHeaders(password)
    const options = headers ? { headers } : undefined
    const req = http.get(`${serverUrl}/global/health`, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`Status ${res.statusCode}`))
        return
      }
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        body += chunk
      })
      res.on("end", () => {
        try {
          if (JSON.parse(body)?.healthy === true) resolve(true)
          else reject(new Error("Backend reported unhealthy"))
        } catch {
          reject(new Error("Unexpected health response"))
        }
      })
    })
    req.on("error", (e) => reject(e))
    req.setTimeout(2000, () => {
      req.destroy()
      reject(new Error("Timeout"))
    })
  })
}

function splitPathEnv() {
  const raw = process.env.PATH || ""
  return raw.split(path.delimiter).filter(Boolean)
}

function pushDir(list: string[], dir: string | null | undefined) {
  if (!dir) return
  if (!list.includes(dir)) list.push(dir)
}

function pushExistingDir(list: string[], dir: string | null | undefined) {
  if (!dir) return
  if (!fs.existsSync(dir)) return
  if (!list.includes(dir)) list.push(dir)
}

function addVersionedDirs(list: string[], baseDir: string | null | undefined, subpath: string) {
  if (!baseDir || !fs.existsSync(baseDir)) return
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return
  }
  entries.forEach((entry) => {
    if (!entry.isDirectory()) return
    const full = path.join(baseDir, entry.name, subpath || "")
    pushExistingDir(list, full)
  })
}

function prefixToBin(prefix: string | undefined) {
  if (!prefix) return null
  return process.platform === "win32" ? prefix : path.join(prefix, "bin")
}

function getOpencodeCandidateNames() {
  if (process.platform === "win32") {
    return [`${OPENCODE_BASENAME}.cmd`, `${OPENCODE_BASENAME}.exe`, `${OPENCODE_BASENAME}.bat`, OPENCODE_BASENAME]
  }
  return [OPENCODE_BASENAME]
}

function findExecutableInDirs(dirs: string[], names: string[]) {
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name)
      if (fs.existsSync(full)) return full
    }
  }
  return null
}

export function resolveOpencodePath(requestedPath: string | undefined) {
  const input = (requestedPath || "").trim()
  const names = getOpencodeCandidateNames()

  if (input) {
    const looksLikePath = path.isAbsolute(input) || input.includes("/") || input.includes("\\")
    if (looksLikePath) {
      if (fs.existsSync(input)) return { path: input, source: "config" }
      const resolved = path.resolve(process.cwd(), input)
      if (fs.existsSync(resolved)) return { path: resolved, source: "config" }
    }
  }

  const fromPath = findExecutableInDirs(splitPathEnv(), names)
  if (fromPath) return { path: fromPath, source: "PATH" }

  const extraDirs: string[] = []
  if (process.env.OPENCODE_HOME) pushDir(extraDirs, path.join(process.env.OPENCODE_HOME, "bin"))
  if (process.env.OPENCODE_DIR) pushDir(extraDirs, path.join(process.env.OPENCODE_DIR, "bin"))
  pushDir(extraDirs, prefixToBin(process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX))
  pushDir(extraDirs, process.env.PNPM_HOME)
  if (process.env.YARN_GLOBAL_FOLDER) pushDir(extraDirs, path.join(process.env.YARN_GLOBAL_FOLDER, "bin"))
  if (process.env.VOLTA_HOME) pushDir(extraDirs, path.join(process.env.VOLTA_HOME, "bin"))
  pushDir(extraDirs, process.env.NVM_BIN)
  pushDir(extraDirs, path.dirname(process.execPath))

  const home = os.homedir()
  if (home) {
    pushDir(extraDirs, path.join(home, ".opencode", "bin"))
    pushDir(extraDirs, path.join(home, ".local", "bin"))
    pushDir(extraDirs, path.join(home, ".npm-global", "bin"))
    pushDir(extraDirs, path.join(home, ".npm", "bin"))
    pushDir(extraDirs, path.join(home, ".pnpm-global", "bin"))
    pushDir(extraDirs, path.join(home, ".local", "share", "pnpm"))
    pushDir(extraDirs, path.join(home, ".asdf", "shims"))
  }

  if (process.platform === "win32") {
    pushDir(extraDirs, process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null)
    pushDir(extraDirs, process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pnpm") : null)
    pushDir(extraDirs, process.env.NVM_HOME)
    pushDir(extraDirs, process.env.NVM_SYMLINK)
    pushDir(extraDirs, process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : null)
    pushDir(extraDirs, process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs") : null)
  } else {
    pushDir(extraDirs, "/usr/local/bin")
    pushDir(extraDirs, "/usr/bin")
    pushDir(extraDirs, "/bin")
    pushDir(extraDirs, "/opt/homebrew/bin")
    pushDir(extraDirs, "/snap/bin")
  }

  const nvmDir = process.env.NVM_DIR || (home ? path.join(home, ".nvm") : null)
  if (nvmDir) addVersionedDirs(extraDirs, path.join(nvmDir, "versions", "node"), "bin")

  const asdfDir = process.env.ASDF_DATA_DIR || (home ? path.join(home, ".asdf") : null)
  if (asdfDir) addVersionedDirs(extraDirs, path.join(asdfDir, "installs", "nodejs"), "")

  if (home) addVersionedDirs(extraDirs, path.join(home, ".fnm", "node-versions", "v1"), path.join("installation", "bin"))

  const fromExtras = findExecutableInDirs(extraDirs, names)
  if (fromExtras) return { path: fromExtras, source: "known-locations" }

  return { path: null as string | null, source: "not-found" }
}

/** Kills a spawned process tree. Windows needs taskkill: the child is behind a .cmd shell. */
export function killProcessTree(childProcess: any) {
  if (!childProcess || childProcess.pid === undefined) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(childProcess.pid)], { stdio: "ignore" })
    } else {
      childProcess.kill("SIGTERM")
    }
  } catch {
    try {
      childProcess.kill()
    } catch {
      void 0
    }
  }
}

export type EnsureBackendConfig = {
  serverUrl: string
  opencodePath: string
  useIsolatedHome: boolean
  zenApiKey?: string
  serverPassword?: string
  manageBackend: boolean
  promptMode: string
  toolLockPluginPath: string
}

/**
 * Merges the tool-lock plugin into OPENCODE_CONFIG_CONTENT for the spawned backend,
 * keeping any config the operator already passes that way.
 */
export function buildBackendConfigContent(existing: string | undefined, toolLockPluginPath: string) {
  let base: any = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed
    } catch (e: any) {
      console.warn("[Local] Ignoring invalid OPENCODE_CONFIG_CONTENT:", e.message)
    }
  }
  const plugins = Array.isArray(base.plugin) ? [...base.plugin] : []
  if (!plugins.includes(toolLockPluginPath)) plugins.push(toolLockPluginPath)
  return JSON.stringify({ ...base, plugin: plugins })
}

export function ensureBackend(config: EnsureBackendConfig) {
  return ensureBackendInternal(config, getBackendState(config.serverUrl))
}

async function ensureBackendInternal(config: EnsureBackendConfig, state: BackendState) {
  const {
    serverUrl,
    opencodePath,
    useIsolatedHome,
    zenApiKey,
    serverPassword,
    manageBackend,
    promptMode,
    toolLockPluginPath,
  } = config

  if (state.isStarting) {
    let starterDied = false
    for (let i = 0; i < STARTING_WAIT_ITERATIONS; i++) {
      await sleep(STARTING_WAIT_INTERVAL_MS)
      try {
        await checkHealth(serverUrl, serverPassword)
        return
      } catch {
        const starter = state.process
        // A starter that exited will never become healthy; waiting out the full
        // budget only burns a minute of every queued request.
        if (starter && starter.exitCode !== null) {
          starterDied = true
          break
        }
      }
    }
    if (!starterDied) throw new Error("Backend startup timeout")
    // Fall through: the starter died before becoming healthy, so the spawn
    // below raises a replacement and this request still completes.
  }

  try {
    await checkHealth(serverUrl, serverPassword)
  } catch (err) {
    if (!manageBackend) {
      for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
        await sleep(STARTUP_WAIT_INTERVAL_MS)
        try {
          await checkHealth(serverUrl, serverPassword)
          return
        } catch {}
      }
      throw err
    }

    state.isStarting = true
    console.log(`[Local] OpenCode backend not found at ${serverUrl}. Starting...`)

    if (state.process) {
      state.expectExit = true
      killProcessTree(state.process)
    }

    if (state.jailRoot && fs.existsSync(state.jailRoot)) {
      try {
        fs.rmSync(state.jailRoot, { recursive: true, force: true })
      } catch {}
    }

    // The tool-lock plugin keeps Zen free models usable, the server password protects
    // the backend API, and the Zen key unlocks paid models. `opencode serve` reads all
    // three from the environment.
    const backendEnv: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: buildBackendConfigContent(process.env.OPENCODE_CONFIG_CONTENT, toolLockPluginPath),
    }
    if (serverPassword) backendEnv.OPENCODE_SERVER_PASSWORD = serverPassword
    if (zenApiKey) backendEnv.OPENCODE_API_KEY = zenApiKey

    const isWindows = process.platform === "win32"
    const salt = Math.random().toString(36).substring(7)
    const jailRoot = path.join(os.tmpdir(), "opencode-proxy-jail", salt)
    state.jailRoot = jailRoot
    const workspace = path.join(jailRoot, "empty-workspace")

    let envVars: Record<string, any>
    let cwd: string

    try {
      fs.mkdirSync(workspace, { recursive: true })
    } catch (e: any) {
      // Without this reset a failed workspace creation would latch isStarting
      // and every later request would wait out the full startup budget.
      state.isStarting = false
      throw new Error(`Failed to create backend workspace ${workspace}: ${e.message}`)
    }
    cwd = workspace

    if (isWindows) {
      envVars = { ...process.env, ...backendEnv, OPENCODE_PROJECT_DIR: workspace }
      console.log("[Local] Running on Windows, using standard user home directory")
    } else if (useIsolatedHome) {
      const fakeHome = path.join(jailRoot, "fake-home")

      const opencodeDir = path.join(fakeHome, ".local", "share", "opencode")
      const storageDir = path.join(opencodeDir, "storage")
      const messageDir = path.join(storageDir, "message")
      const sessionDir = path.join(storageDir, "session")

      for (const dir of [fakeHome, opencodeDir, storageDir, messageDir, sessionDir]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      }

      envVars = {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ...backendEnv,
        OPENCODE_PROJECT_DIR: workspace,
      }

      if (promptMode === "plugin-inject") {
        const configDir = path.join(fakeHome, ".config", "opencode")
        const pluginDir = path.join(configDir, "plugin", "opencode2api-empty")
        fs.mkdirSync(pluginDir, { recursive: true })
        fs.writeFileSync(
          path.join(pluginDir, "index.js"),
          "export const Opencode2apiEmptyPlugin = async () => ({})\nexport default Opencode2apiEmptyPlugin\n",
          "utf8",
        )
        fs.writeFileSync(
          path.join(configDir, "opencode.json"),
          JSON.stringify({ plugin: [path.join(pluginDir, "index.js")], instructions: [], theme: "system" }, null, 2),
          "utf8",
        )
        console.log("[Local] Using plugin-inject prompt mode")
      }
      console.log("[Local] Using isolated home for OpenCode")
    } else {
      envVars = { ...process.env, ...backendEnv, OPENCODE_PROJECT_DIR: workspace }
      console.log("[Local] Using real HOME for OpenCode (isolation disabled)")
    }

    const [, , portStr] = serverUrl.split(":")
    const port = portStr ? portStr.split("/")[0] : "10001"
    const resolved = resolveOpencodePath(opencodePath)
    const opencodeBin = resolved.path || opencodePath || OPENCODE_BASENAME
    if (resolved.path) {
      console.log(`[Local] Using OpenCode binary: ${opencodeBin} (source: ${resolved.source})`)
    } else {
      console.warn(`[Local] Unable to resolve OpenCode binary for '${opencodePath}'. Using as-is.`)
    }

    const useShell = process.platform === "win32" || !resolved.path || opencodeBin.endsWith(".cmd") || opencodeBin.endsWith(".bat")
    const child = spawn(opencodeBin, ["serve", "--port", port, "--hostname", "127.0.0.1"], {
      stdio: "inherit",
      cwd,
      env: envVars,
      shell: useShell,
    })
    state.process = child

    child.on("error", (err: any) => {
      console.error(`[Local] Failed to spawn OpenCode: ${err.message}`)
      if (err.code === "ENOENT") {
        console.error(`[Local] Command '${opencodePath}' not found. Please ensure OpenCode is installed and in your PATH.`)
      }
    })

    // A backend death has historically been silent (nothing on stdio), leaving
    // the gateway answering `fetch failed` with no hint why. Log the exit and
    // whether it was ours to cause.
    child.on("exit", (code, signal) => {
      const detail = `code=${code === null ? "null" : code}${signal ? ` signal=${signal}` : ""}`
      if (state.expectExit) {
        state.expectExit = false
        console.log(`[Local] OpenCode backend stopped (${detail})`)
      } else {
        console.error(`[Local] OpenCode backend exited unexpectedly (${detail}). The next request respawns it.`)
      }
    })

    let started = false
    let startupExitCode: number | null | undefined // undefined until the child is seen exiting
    for (let i = 0; i < STARTUP_WAIT_ITERATIONS; i++) {
      await sleep(STARTUP_WAIT_INTERVAL_MS)
      try {
        await checkHealth(serverUrl, serverPassword)
        console.log("[Local] OpenCode backend ready.")
        started = true
        break
      } catch {
        if (state.process === child && child.exitCode !== null) {
          startupExitCode = child.exitCode
          console.error(`[Local] OpenCode backend exited during startup: code=${startupExitCode}`)
          break
        }
      }
    }

    state.isStarting = false

    if (!started) {
      console.warn("[Local] Backend start timed out.")
      throw new Error(startupExitCode !== undefined ? `OpenCode backend exited during startup (code=${startupExitCode})` : "Backend start timeout")
    }
  }
}

/** Kills the managed backend for a server URL (used on shutdown). */
export function killBackendFor(serverUrl: string) {
  const state = backendState.get(serverUrl)
  if (!state) return
  if (state.process) {
    state.expectExit = true
    killProcessTree(state.process)
  }
  if (state.jailRoot && process.platform !== "win32") {
    try {
      fs.rmSync(state.jailRoot, { recursive: true, force: true })
    } catch {}
  }
}
