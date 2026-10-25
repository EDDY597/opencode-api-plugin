// The embedded local upstream must heal a dead `opencode serve` backend on the
// next request: model resolution is the first backend call, so the respawn has
// to happen before it — a dead backend used to 500 every request as
// `fetch failed` with the respawn logic permanently unreachable.
//
// No real opencode install is needed: the backend is a fake `.cmd` that runs a
// tiny node server speaking the few OpenCode API routes the proxy touches.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createLocalProxy, normalizeLocalProxyConfig } from "../src/opencode-local/local-proxy.ts"
import { ensureBackend, getBackendState, killBackendFor } from "../src/opencode-local/backend.ts"

const win = process.platform === "win32"

const FAKE_SERVE_MJS = [
  'import http from "node:http"',
  "const args = process.argv.slice(2)",
  "const port = Number(args[args.indexOf(\"--port\") + 1])",
  "let pluginPath = \"\"",
  "try { pluginPath = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || \"{}\").plugin[0] || \"\" } catch {}",
  "let sessions = 0",
  "http.createServer((req, res) => {",
  "  const chunks = []",
  "  req.on(\"data\", (chunk) => chunks.push(chunk))",
  "  req.on(\"end\", () => {",
  "    const url = String(req.url)",
  "    const method = String(req.method)",
  "    const reply = (status, payload) => {",
  "      res.writeHead(status, { \"content-type\": \"application/json\" })",
  "      res.end(JSON.stringify(payload))",
  "    }",
  "    if (url === \"/global/health\") return reply(200, { healthy: true, version: \"fake\" })",
  "    if (url === \"/config/providers\") {",
  "      return reply(200, { providers: [{ id: \"opencode\", name: \"OpenCode Zen\", models: { \"space-bunny-free\": { name: \"Space Bunny Free\", release_date: \"2025-06-01\" } } }] })",
  "    }",
  "    if (url === \"/config\" && method === \"PATCH\") return reply(200, {})",
  "    if (url === \"/config\" && method === \"GET\") return reply(200, { plugin: [pluginPath] })",
  "    if (url === \"/session\" && method === \"POST\") { sessions += 1; return reply(200, { id: \"ses_fake\" + sessions }) }",
  "    const message = url.match(/^\\/session\\/([^/]+)\\/message$/)",
  "    if (message && method === \"POST\") return reply(202, {})",
  "    if (message && method === \"GET\") {",
  "      return reply(200, [{ info: { id: \"msg_1\", role: \"assistant\", finish: \"stop\", time: { completed: 1 } }, parts: [{ type: \"text\", text: \"pong\" }] }])",
  "    }",
  "    if (url.indexOf(\"/session/\") === 0 && method === \"DELETE\") return reply(200, {})",
  "    if (url === \"/experimental/tool/ids\") return reply(200, [])",
  "    reply(404, { error: { message: \"unexpected \" + method + \" \" + url } })",
  "  })",
  "}).listen(port, \"127.0.0.1\")",
].join("\n")

/** Creates a temp dir with a runnable fake `opencode serve`. */
function writeFakeOpencode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-"))
  fs.writeFileSync(path.join(dir, "fake-opencode.mjs"), FAKE_SERVE_MJS, "utf8")
  fs.writeFileSync(
    path.join(dir, "fake-opencode.cmd"),
    "@echo off\r\nnode \"%~dp0fake-opencode.mjs\" %*\r\n",
    "utf8",
  )
  return dir
}

function proxyFor(serverUrl: string, dir: string) {
  return createLocalProxy(normalizeLocalProxyConfig({
    id: "local-test",
    baseURL: serverUrl,
    opencodePath: path.join(dir, "fake-opencode.cmd"),
    manageBackend: true,
    zenApiKey: "sk-test",
    toolLockPluginPath: "C:/fake/opencode2api-tool-lock.js",
    autoCleanupConversations: false,
  }))
}

const CHAT_BODY = { model: "opencode/space-bunny-free", messages: [{ role: "user", content: "hi" }] }

async function assertPong(response: Response) {
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.choices[0].message.content, "pong")
}

function randomPort(base: number) {
  return base + Math.floor(Math.random() * 1000)
}

test("local upstream spawns a dead backend on the first request and completes it", { skip: !win }, async () => {
  const dir = writeFakeOpencode()
  const serverUrl = `http://127.0.0.1:${randomPort(20000)}`
  const proxy = proxyFor(serverUrl, dir)
  try {
    await assertPong(await proxy.handleChat(CHAT_BODY, false))
    assert.ok(getBackendState(serverUrl).process, "the fake backend was spawned")
  } finally {
    killBackendFor(serverUrl)
  }
})

test("a backend that dies mid-life is respawned by the next request", { skip: !win }, async () => {
  const dir = writeFakeOpencode()
  const serverUrl = `http://127.0.0.1:${randomPort(21000)}`
  const proxy = proxyFor(serverUrl, dir)
  try {
    await assertPong(await proxy.handleChat(CHAT_BODY, false))

    // Kill the whole tree out from under the proxy, the way an external
    // taskkill or a silent crash would.
    const pid = getBackendState(serverUrl).process.pid
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" })

    await assertPong(await proxy.handleChat(CHAT_BODY, false))
  } finally {
    killBackendFor(serverUrl)
  }
})

test("a backend that exits during startup fails fast with its exit code", { skip: !win }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-"))
  fs.writeFileSync(path.join(dir, "die.cmd"), "@echo off\r\nexit /b 7\r\n", "utf8")
  const serverUrl = `http://127.0.0.1:${randomPort(22000)}`
  const started = Date.now()
  try {
    await assert.rejects(
      ensureBackend({
        serverUrl,
        opencodePath: path.join(dir, "die.cmd"),
        useIsolatedHome: false,
        zenApiKey: "",
        manageBackend: true,
        promptMode: "standard",
        toolLockPluginPath: "",
      }),
      /exited during startup \(code=7\)/,
    )
    assert.ok(Date.now() - started < 60_000, "must fail fast, not wait out the full startup budget")
  } finally {
    killBackendFor(serverUrl)
  }
})

// --- permanent upstream errors ------------------------------------------------
//
// An exhausted free quota used to be classified as neither transient nor fatal:
// the proxy stopped retrying but then fell through to polling a session that would
// never answer, so the caller waited out the whole request timeout and finally saw
// a bare "timeout" instead of "Free usage limit reached".

/** Fake backend whose assistant message carries an upstream error. */
const FAKE_ERROR_SERVE_MJS = [
  'import http from "node:http"',
  "const args = process.argv.slice(2)",
  "const port = Number(args[args.indexOf(\"--port\") + 1])",
  "const errorName = process.env.FAKE_ERROR_NAME || \"AI_APICallError\"",
  "const errorMessage = process.env.FAKE_ERROR_MESSAGE || \"Free usage limit reached.\"",
  "let sessions = 0",
  "http.createServer((req, res) => {",
  "  req.on(\"data\", () => {})",
  "  req.on(\"end\", () => {",
  "    const url = String(req.url)",
  "    const method = String(req.method)",
  "    const reply = (status, payload) => {",
  "      res.writeHead(status, { \"content-type\": \"application/json\" })",
  "      res.end(JSON.stringify(payload))",
  "    }",
  "    if (url === \"/global/health\") return reply(200, { healthy: true, version: \"fake\" })",
  "    if (url === \"/config/providers\") {",
  "      return reply(200, { providers: [{ id: \"opencode\", name: \"OpenCode Zen\", models: { \"space-bunny-free\": { name: \"Space Bunny Free\", release_date: \"2025-06-01\" } } }] })",
  "    }",
  "    if (url === \"/config\" && method === \"PATCH\") return reply(200, {})",
  "    if (url === \"/config\" && method === \"GET\") return reply(200, { plugin: [] })",
  "    if (url === \"/session\" && method === \"POST\") { sessions += 1; return reply(200, { id: \"ses_err\" + sessions }) }",
  "    const message = url.match(/^\\/session\\/([^/]+)\\/message$/)",
  "    if (message && method === \"POST\") return reply(202, {})",
  "    if (message && method === \"GET\") {",
  "      return reply(200, [{",
  "        info: { id: \"msg_1\", role: \"assistant\", time: { completed: 1 },",
  "          error: { name: errorName, data: { message: errorMessage } } },",
  "        parts: [],",
  "      }])",
  "    }",
  "    if (url.indexOf(\"/session/\") === 0 && method === \"DELETE\") return reply(200, {})",
  "    if (url === \"/experimental/tool/ids\") return reply(200, [])",
  "    reply(404, { error: { message: \"unexpected \" + method + \" \" + url } })",
  "  })",
  "}).listen(port, \"127.0.0.1\")",
].join("\n")

function writeFakeErrorOpencode(env: { name?: string; message?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-err-"))
  fs.writeFileSync(path.join(dir, "fake-error.mjs"), FAKE_ERROR_SERVE_MJS, "utf8")
  fs.writeFileSync(
    path.join(dir, "fake-error.cmd"),
    "@echo off\r\n"
      + `set "FAKE_ERROR_NAME=${env.name ?? "AI_APICallError"}"\r\n`
      + `set "FAKE_ERROR_MESSAGE=${env.message ?? "Free usage limit reached."}"\r\n`
      + "node \"%~dp0fake-error.mjs\" %*\r\n",
    "utf8",
  )
  return dir
}

function errorProxyFor(serverUrl: string, dir: string) {
  return createLocalProxy(normalizeLocalProxyConfig({
    id: "local-err-test",
    baseURL: serverUrl,
    opencodePath: path.join(dir, "fake-error.cmd"),
    manageBackend: true,
    zenApiKey: "sk-test",
    toolLockPluginPath: "C:/fake/opencode2api-tool-lock.js",
    autoCleanupConversations: false,
  }))
}

test("free-quota rejection fails fast with the provider's wording, not a timeout", { skip: !win }, async () => {
  const dir = writeFakeErrorOpencode({ message: "Free usage limit reached. Subscribe to OpenCode Go to keep going." })
  const serverUrl = `http://127.0.0.1:${randomPort(23000)}`
  const proxy = errorProxyFor(serverUrl, dir)
  const started = Date.now()
  try {
    const response = await proxy.handleChat(CHAT_BODY, false)
    const elapsed = Date.now() - started
    assert.equal(response.status, 402)
    const payload = await response.json()
    assert.equal(payload.error.code, "UPSTREAM_ACCOUNT_ERROR")
    assert.match(payload.error.message, /free usage limit reached/i)
    // The whole point: no waiting out requestTimeoutMs (300s in this config).
    assert.ok(elapsed < 30_000, `expected a fast failure, took ${elapsed}ms`)
  } finally {
    killBackendFor(serverUrl)
  }
})

test("an unpaid account (Insufficient account funds) also fails fast", { skip: !win }, async () => {
  const dir = writeFakeErrorOpencode({ message: "Upstream request failed: Insufficient account funds" })
  const serverUrl = `http://127.0.0.1:${randomPort(24000)}`
  const proxy = errorProxyFor(serverUrl, dir)
  const started = Date.now()
  try {
    const response = await proxy.handleChat(CHAT_BODY, false)
    const elapsed = Date.now() - started
    assert.equal(response.status, 402)
    const payload = await response.json()
    assert.equal(payload.error.code, "UPSTREAM_ACCOUNT_ERROR")
    assert.match(payload.error.message, /insufficient account funds/i)
    assert.ok(elapsed < 30_000, `expected a fast failure, took ${elapsed}ms`)
  } finally {
    killBackendFor(serverUrl)
  }
})

// The real backend never reports an exhausted free tier as an error: it parks the
// session in a `retry` status scheduled for the next reset (~11h out) and emits no
// completion. Nothing in the session snapshot marks it either, so the request used
// to hang until the client gave up.
const FAKE_QUOTA_SERVE_MJS = [
  'import http from "node:http"',
  "const args = process.argv.slice(2)",
  "const port = Number(args[args.indexOf(\"--port\") + 1])",
  "let lastSession = \"\"",
  "const sseClients = []",
  "http.createServer((req, res) => {",
  "  req.on(\"data\", () => {})",
  "  req.on(\"end\", () => {",
  "    const url = String(req.url)",
  "    const method = String(req.method)",
  "    const reply = (status, payload) => {",
  "      res.writeHead(status, { \"content-type\": \"application/json\" })",
  "      res.end(JSON.stringify(payload))",
  "    }",
  "    if (url === \"/global/health\") return reply(200, { healthy: true, version: \"fake\" })",
  "    if (url === \"/config/providers\") {",
  "      return reply(200, { providers: [{ id: \"opencode\", name: \"OpenCode Zen\", models: { \"space-bunny-free\": { name: \"Space Bunny Free\", release_date: \"2025-06-01\" } } }] })",
  "    }",
  "    if (url === \"/config\" && method === \"PATCH\") return reply(200, {})",
  "    if (url === \"/config\" && method === \"GET\") return reply(200, { plugin: [] })",
  "    if (url === \"/event\") {",
  "      res.writeHead(200, { \"content-type\": \"text/event-stream\", \"cache-control\": \"no-cache\" })",
  "      sseClients.push(res)",
  "      return",
  "    }",
  "    if (url === \"/session\" && method === \"POST\") { lastSession = \"ses_quota\" + Date.now(); return reply(200, { id: lastSession }) }",
  "    const message = url.match(/^\\/session\\/([^/]+)\\/message$/)",
  "    if (message && method === \"POST\") {",
  "      setTimeout(() => {",
  "        const frame = JSON.stringify({",
  "          type: \"session.status\",",
  "          properties: { sessionID: lastSession, status: {",
  "            type: \"retry\", attempt: 1,",
  "            message: \"Free usage exceeded, subscribe to Go\",",
  "            action: { reason: \"free_tier_limit\" },",
  "            next: Date.now() + 11 * 3600 * 1000,",
  "          } },",
  "        })",
  "        for (const client of sseClients) client.write(\"data: \" + frame + \"\\n\\n\")",
  "      }, 200)",
  "      return reply(202, {})",
  "    }",
  "    if (message && method === \"GET\") return reply(200, [])",
  "    if (url.indexOf(\"/session/\") === 0 && method === \"DELETE\") return reply(200, {})",
  "    if (url === \"/experimental/tool/ids\") return reply(200, [])",
  "    reply(404, { error: { message: \"unexpected \" + method + \" \" + url } })",
  "  })",
  "}).listen(port, \"127.0.0.1\")",
].join("\n")

test("a quota-limited session parked in retry fails fast instead of hanging", { skip: !win }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-quota-"))
  fs.writeFileSync(path.join(dir, "fake-quota.mjs"), FAKE_QUOTA_SERVE_MJS, "utf8")
  fs.writeFileSync(path.join(dir, "fake-quota.cmd"), "@echo off\r\nnode \"%~dp0fake-quota.mjs\" %*\r\n", "utf8")
  const serverUrl = `http://127.0.0.1:${randomPort(25000)}`
  const proxy = createLocalProxy(normalizeLocalProxyConfig({
    id: "local-quota-test",
    baseURL: serverUrl,
    opencodePath: path.join(dir, "fake-quota.cmd"),
    manageBackend: true,
    zenApiKey: "sk-test",
    toolLockPluginPath: "C:/fake/opencode2api-tool-lock.js",
    autoCleanupConversations: false,
  }))
  const started = Date.now()
  try {
    const response = await proxy.handleChat(CHAT_BODY, false)
    const elapsed = Date.now() - started
    assert.equal(response.status, 402)
    const payload = await response.json()
    assert.equal(payload.error.code, "UPSTREAM_ACCOUNT_ERROR")
    assert.match(payload.error.message, /free usage exceeded/i)
    assert.ok(elapsed < 30_000, `expected a fast failure, took ${elapsed}ms`)
  } finally {
    killBackendFor(serverUrl)
  }
})
