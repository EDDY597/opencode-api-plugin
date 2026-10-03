import { buildBackendAuthHeaders } from "./backend.ts"

/**
 * Zero-dependency client for the OpenCode server HTTP API (replaces @opencode-ai/sdk).
 *
 * Route map (from the SDK's generated client):
 *   config.providers  GET    /config/providers
 *   config.get        GET    /config
 *   config.update     PATCH  /config
 *   session.create    POST   /session
 *   session.delete    DELETE /session/{id}
 *   session.messages  GET    /session/{id}/message
 *   session.prompt    POST   /session/{id}/message
 *   event.subscribe   GET    /event  (SSE)
 *   tool.ids          GET    /experimental/tool/ids
 */

export type LocalClient = {
  baseUrl: string
  configProviders(): Promise<any>
  configGet(): Promise<any>
  configUpdate(body: any): Promise<any>
  sessionCreate(body?: any): Promise<any>
  sessionDelete(id: string): Promise<any>
  sessionMessages(id: string, signal?: AbortSignal): Promise<any>
  sessionPrompt(sessionId: string, body: any, signal?: AbortSignal): Promise<any>
  toolIds(): Promise<any>
  eventStream(signal: AbortSignal): AsyncGenerator<any>
}

function authHeaders(password = ""): Record<string, string> {
  return buildBackendAuthHeaders(password) ?? {}
}

async function requestJson(
  baseUrl: string,
  password: string,
  method: string,
  urlPath: string,
  body?: any,
  signal?: AbortSignal,
): Promise<{ data?: any; error?: any; statusCode?: number }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...authHeaders(password) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let parsed: any
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = text
  }
  if (!response.ok) {
    // OpenCode surfaces provider errors as "<status>: {json}" strings; keep a
    // comparable shape so transient-error detection works like the SDK's.
    const message = typeof parsed === "object" && parsed ? (parsed.message ?? JSON.stringify(parsed)) : String(text || response.statusText)
    return { error: { message: `${response.statusCode}: ${message}`, statusCode: response.statusCode, data: parsed }, statusCode: response.statusCode }
  }
  return { data: parsed }
}

/** Parses an SSE stream of `data: {json}` frames into async-generated event objects. */
async function* parseEventSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf("\n")
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "")
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).replace(/^ /, "")
        if (!data || data === "[DONE]") continue
        try {
          yield JSON.parse(data)
        } catch {
          continue
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      void 0
    }
  }
}

export function createLocalClient(baseUrl: string, password = ""): LocalClient {
  const call = (
    method: string,
    urlPath: string,
    body?: any,
    signal?: AbortSignal,
  ) => requestJson(baseUrl, password, method, urlPath, body, signal)

  return {
    baseUrl,
    async configProviders() {
      return call("GET", "/config/providers")
    },
    async configGet() {
      return call("GET", "/config")
    },
    async configUpdate(body: any) {
      return call("PATCH", "/config", body)
    },
    async sessionCreate(body?: any) {
      return call("POST", "/session", body)
    },
    async sessionDelete(id: string) {
      return call("DELETE", `/session/${encodeURIComponent(id)}`)
    },
    async sessionMessages(id: string, signal?: AbortSignal) {
      return call("GET", `/session/${encodeURIComponent(id)}/message`, undefined, signal)
    },
    async sessionPrompt(sessionId: string, body: any, signal?: AbortSignal) {
      return call("POST", `/session/${encodeURIComponent(sessionId)}/message`, body, signal)
    },
    async toolIds() {
      return call("GET", "/experimental/tool/ids")
    },
    async *eventStream(signal: AbortSignal): AsyncGenerator<any> {
      const response = await fetch(`${baseUrl}/event`, {
        method: "GET",
        headers: { accept: "text/event-stream", ...authHeaders(password) },
        signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed: HTTP ${response.status}`)
      }
      yield* parseEventSse(response.body, signal)
    },
  }
}
