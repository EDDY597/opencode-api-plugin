// Validates the release workflow locally before it ever runs on GitHub:
//   - YAML parses (no tabs, no duplicate keys)
//   - every `on:` trigger and `inputs` key exists
//   - the steps' `id`s referenced via `steps.<id>.outputs.*` are defined
//   - the build/smoke-test logic is exercised against the *real* upstream tag,
//     including the /health + /models probe the workflow performs
//
// Zero dependencies (repo rule: Node built-ins only). Run with system Node 26:
//   node scripts/verify-oc2api-release.mjs            # static checks only
//   node scripts/verify-oc2api-release.mjs --build     # also build + smoke test locally
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const workflowPath = path.join(root, ".github", "workflows", "oc2api-release.yml")

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`)
}

// --- 1. static: YAML shape ---------------------------------------------------
const text = fs.readFileSync(workflowPath, "utf8")
check(!/\t/.test(text), "no tab characters (YAML forbids tabs for indentation)")
check(/^name: oc2api-release$/m.test(text), "workflow has a name")
check(/^on:$/m.test(text), "workflow has an `on:` block")
check(/^permissions:\n  contents: write$/m.test(text), "release needs contents: write")
check(/workflow_dispatch:/.test(text), "manual trigger present")
check(/^      - "oc2api-v\*"$/m.test(text), "tag trigger present")

// Top-level keys must be unique (a duplicated `on:` silently replaces the first).
const topKeys = text.split("\n").filter((line) => /^[A-Za-z_][\w-]*:/.test(line)).map((line) => line.split(":")[0])
check(new Set(topKeys).size === topKeys.length, `no duplicate top-level keys (${topKeys.join(", ")})`)

// Every `steps.<id>.outputs.<name>` must point at a step that exists in the file.
const declaredIds = new Set([...text.matchAll(/^\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]))
const referenced = new Set([...text.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)].map((m) => `${m[1]}.${m[2]}`))
for (const ref of referenced) {
  const [id, output] = ref.split(".")
  check(declaredIds.has(id), `steps.${id} is declared before being referenced`)
  check(["tags", "artifact"].includes(id), `unexpected step id in reference: ${id}`)
  check(["upstream", "release", "sha256", "size"].includes(output), `known output name: ${output}`)
}
for (const id of ["tags", "artifact"]) check(declaredIds.has(id), `step id \`${id}\` exists`)

// The workflow writes `${{ inputs.* }}` keys that must exist in workflow_dispatch.inputs.
const inputRefs = new Set([...text.matchAll(/inputs\.([\w-]+)/g)].map((m) => m[1]))
const declaredInputs = new Set([...text.matchAll(/^\s{6}([\w-]+):\n\s{8}description:/gm)].map((m) => m[1]))
for (const name of inputRefs) check(declaredInputs.has(name), `workflow_dispatch input \`${name}\` is declared`)

// Guard the one thing that bit us: the lane spawns the exe with PORT + API_KEY only,
// so the release must be the same `./cmd/oc2api` package with no extra tags/ldflags.
check(/go build -trimpath -o oc2api\.exe \.\/cmd\/oc2api/.test(text), "builds ./cmd/oc2api like AGENTS.md")
check(!/-tags/.test(text), "no build tags (full build with the mihomo kernel, as on this machine)")

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}

if (!process.argv.includes("--build")) {
  console.log("\nstatic checks passed (add --build to build + smoke test locally)")
  process.exit(0)
}

// --- 2. dynamic: build the real thing and probe it ---------------------------
const upstreamTag = (text.match(/default: "(v[\d.]+)"/) ?? [])[1]
if (!upstreamTag) throw new Error("cannot read the default upstream tag from the workflow")

const work = fs.mkdtempSync(path.join(os.tmpdir(), "oc2api-release-"))
const src = path.join(work, "upstream")
console.log(`\ncloning zhuweiyou/oc2api@${upstreamTag} -> ${src}`)
execFileSync("git", ["clone", "--depth", "1", "--branch", upstreamTag, "-c", "http.sslBackend=openssl",
  "https://github.com/zhuweiyou/oc2api.git", src], { stdio: "inherit" })

const go = process.env.OC2API_GO ?? "E:\\Agent\\tools\\go-install\\go\\bin\\go.exe"
const exe = path.join(src, "oc2api.exe")
console.log(`building with ${go}`)
// Keep every temp file under the OS temp dir (or GOCACHE/GOMODCACHE if the caller
// set them): an agent sandbox cannot write to the user's %USERPROFILE%\go.
const goCache = process.env.GOCACHE ?? path.join(work, "gocache")
const goModCache = process.env.GOMODCACHE ?? path.join(work, "gomodcache")
const goTmp = path.join(work, "gotmp")
fs.mkdirSync(goTmp, { recursive: true })
execFileSync(go, ["build", "-trimpath", "-o", exe, "./cmd/oc2api"], {
  cwd: src,
  stdio: "inherit",
  env: {
    ...process.env,
    GOCACHE: goCache,
    GOMODCACHE: goModCache,
    GOPATH: path.join(work, "gopath"),
    GOTMPDIR: goTmp,
    GOPROXY: process.env.GOPROXY ?? "https://goproxy.cn,direct",
    GOTOOLCHAIN: "local",
  },
})
const stat = fs.statSync(exe)
check(stat.size > 1_000_000, `binary looks real (${stat.size} bytes)`)

// Same probe as the workflow's smoke test. /health and /models are local/static and
// spend no quota, per the discipline table in AGENTS.md.
const port = 18091
const child = spawn(exe, [], {
  cwd: src,
  env: { ...process.env, PORT: String(port), API_KEY: "smoke-test-key" },
  stdio: "ignore",
  windowsHide: true,
})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  let health
  for (let i = 0; i < 30 && !health; i++) {
    await sleep(500)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      const body = await response.json()
      if (body?.status === "ok") health = body
    } catch { void 0 }
  }
  check(health?.status === "ok", `/health reports status=ok on ${port}`)

  const models = await fetch(`http://127.0.0.1:${port}/models`, {
    headers: { Authorization: "Bearer smoke-test-key" },
    signal: AbortSignal.timeout(5000),
  }).then((response) => response.json())
  const count = Array.isArray(models?.data) ? models.data.length : 0
  check(count > 0, `/models answers ${count} model(s) with a valid API_KEY`)

  const denied = await fetch(`http://127.0.0.1:${port}/models`, { signal: AbortSignal.timeout(5000) })
  check(denied.status === 401, `/models without a key is rejected (${denied.status}) — API_KEY is actually enforced`)
} finally {
  child.kill()
  await sleep(300)
  fs.rmSync(work, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\nbuild + smoke test passed")
// execFileSync leaves the child handles open only long enough for the build; the
// spawned exe is killed above. Exit explicitly so the (now empty) temp dir is clean.
process.exit(0)
